/**
 * Hybrid retrieval: FTS5 keyword search and vector similarity, fused by
 * reciprocal rank, then optionally reranked by Voyage.
 *
 * Both arms are needed. Vector search finds "who is treating the client" when
 * the file says "orthopedic follow-up"; keyword search finds an exact invoice
 * number, a docket number, or a name that no embedding generalizes. RRF needs
 * no score calibration between the two, which matters because BM25 and cosine
 * are not on the same scale.
 *
 * Vectors are compared in-process: a matter is a few thousand chunks, so a
 * full scan is well under a millisecond and avoids a vector-index extension.
 */

import { decodeVector, embedQuery, rerank } from "./voyage";
import { getDb, indexGeneration } from "@/lib/db/sqlite";
import { ragConfig } from "./config";

export interface SearchHit {
  chunkId: number;
  sourceId: number;
  matterId: number;
  kind: string;
  clioId: string;
  page: number;
  title: string;
  text: string;
  occurredAt: string | null;
  metadata: Record<string, unknown>;
  /** Fused rank score; higher is better. */
  score: number;
  /** Voyage relevance score when reranking ran. */
  rerankScore: number | null;
  /** Which arms found this chunk, and at what rank. */
  matchedBy: { keyword: number | null; vector: number | null };
}

export interface SearchOptions {
  matterId?: number;
  /** Restrict to these source kinds. */
  kinds?: string[];
  limit?: number;
  /** Rerank the fused candidates with Voyage. Default true. */
  rerank?: boolean;
  signal?: AbortSignal;
}

export interface SearchResult {
  query: string;
  hits: SearchHit[];
  timings: { keywordMs: number; vectorMs: number; rerankMs: number; totalMs: number };
  reranked: boolean;
}

interface ChunkRow {
  chunk_id: number;
  source_id: number;
  matter_id: number;
  kind: string;
  clio_id: string;
  page: number;
  title: string;
  text: string;
  occurred_at: string | null;
  metadata: string;
}

const CHUNK_COLUMNS = `
  c.id        AS chunk_id,
  c.text      AS text,
  s.id        AS source_id,
  s.matter_id AS matter_id,
  s.kind      AS kind,
  s.clio_id   AS clio_id,
  s.page      AS page,
  s.title     AS title,
  s.occurred_at AS occurred_at,
  s.metadata  AS metadata
`;

/* --- keyword arm --------------------------------------------------------- */

/**
 * Turn free text into an FTS5 MATCH expression.
 *
 * User text is never passed to MATCH directly: `-`, `*`, `:`, `"`, `(`, `AND`
 * and friends are query syntax there, so an ordinary question like "what's
 * overdue?" either errors or means something unintended. Each word becomes a
 * quoted prefix term, OR-ed, which is a recall-first reading — precision is
 * fusion's and the reranker's job.
 */
export function toMatchQuery(input: string): string | null {
  const terms = input
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((term) => term.length > 1)
    .slice(0, 32);

  if (terms.length === 0) return null;
  return terms.map((term) => `"${term}"*`).join(" OR ");
}

function keywordSearch(
  query: string,
  options: SearchOptions,
): { rows: ChunkRow[] } {
  const match = toMatchQuery(query);
  if (!match) return { rows: [] };

  const filters: string[] = ["chunks_fts MATCH ?"];
  const params: (string | number)[] = [match];

  if (options.matterId !== undefined) {
    filters.push("s.matter_id = ?");
    params.push(options.matterId);
  }
  if (options.kinds && options.kinds.length > 0) {
    filters.push(`s.kind IN (${options.kinds.map(() => "?").join(", ")})`);
    params.push(...options.kinds);
  }

  params.push(options.limit ?? ragConfig.candidatesPerArm);

  const rows = getDb()
    .prepare(
      `SELECT ${CHUNK_COLUMNS}
       FROM chunks_fts
       JOIN chunks  c ON c.id = chunks_fts.rowid
       JOIN sources s ON s.id = c.source_id
       WHERE ${filters.join(" AND ")}
       ORDER BY bm25(chunks_fts) ASC
       LIMIT ?`,
    )
    .all(...params) as unknown as ChunkRow[];

  return { rows };
}

/* --- vector arm ---------------------------------------------------------- */

interface VectorEntry {
  chunkId: number;
  vector: Float32Array;
  /** Pre-computed so cosine is a dot product and one division. */
  norm: number;
  matterId: number;
  kind: string;
}

interface VectorCache {
  generation: number;
  entries: VectorEntry[];
}

const cache = globalThis as unknown as { __ninetyVectors?: VectorCache };

function loadVectors(): VectorEntry[] {
  const generation = indexGeneration();
  if (cache.__ninetyVectors?.generation === generation) {
    return cache.__ninetyVectors.entries;
  }

  const rows = getDb()
    .prepare(
      `SELECT c.id AS chunk_id, c.embedding AS embedding, s.matter_id AS matter_id, s.kind AS kind
       FROM chunks c
       JOIN sources s ON s.id = c.source_id
       WHERE c.embedding IS NOT NULL AND c.embedding_model IS ?`,
    )
    .all(ragConfig.embedModel) as {
    chunk_id: number;
    embedding: Uint8Array;
    matter_id: number;
    kind: string;
  }[];

  const entries = rows.map((row) => {
    const vector = decodeVector(row.embedding);
    let sum = 0;
    for (let i = 0; i < vector.length; i += 1) sum += vector[i] * vector[i];
    return {
      chunkId: row.chunk_id,
      vector,
      norm: Math.sqrt(sum) || 1,
      matterId: row.matter_id,
      kind: row.kind,
    };
  });

  cache.__ninetyVectors = { generation, entries };
  return entries;
}

async function vectorSearch(
  query: string,
  options: SearchOptions,
): Promise<ChunkRow[]> {
  const entries = loadVectors();
  if (entries.length === 0) return [];

  const queryVector = await embedQuery(query, { signal: options.signal });
  let queryNorm = 0;
  for (let i = 0; i < queryVector.length; i += 1) {
    queryNorm += queryVector[i] * queryVector[i];
  }
  queryNorm = Math.sqrt(queryNorm) || 1;

  const kinds = options.kinds && options.kinds.length > 0 ? new Set(options.kinds) : null;
  const scored: { chunkId: number; score: number }[] = [];

  for (const entry of entries) {
    if (options.matterId !== undefined && entry.matterId !== options.matterId) continue;
    if (kinds && !kinds.has(entry.kind)) continue;
    if (entry.vector.length !== queryVector.length) continue;

    let dot = 0;
    for (let i = 0; i < queryVector.length; i += 1) dot += queryVector[i] * entry.vector[i];
    scored.push({ chunkId: entry.chunkId, score: dot / (entry.norm * queryNorm) });
  }

  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, options.limit ?? ragConfig.candidatesPerArm);
  if (top.length === 0) return [];

  const placeholders = top.map(() => "?").join(", ");
  const rows = getDb()
    .prepare(
      `SELECT ${CHUNK_COLUMNS}
       FROM chunks c
       JOIN sources s ON s.id = c.source_id
       WHERE c.id IN (${placeholders})`,
    )
    .all(...top.map((item) => item.chunkId)) as unknown as ChunkRow[];

  // SQL returns rows unordered; restore the similarity order.
  const rank = new Map(top.map((item, index) => [item.chunkId, index]));
  return rows.sort((a, b) => rank.get(a.chunk_id)! - rank.get(b.chunk_id)!);
}

/* --- fusion -------------------------------------------------------------- */

function parseMetadata(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function toHit(row: ChunkRow): Omit<SearchHit, "score" | "rerankScore" | "matchedBy"> {
  return {
    chunkId: row.chunk_id,
    sourceId: row.source_id,
    matterId: row.matter_id,
    kind: row.kind,
    clioId: row.clio_id,
    page: row.page,
    title: row.title,
    text: row.text,
    occurredAt: row.occurred_at,
    metadata: parseMetadata(row.metadata),
  };
}

function fuse(keyword: ChunkRow[], vector: ChunkRow[]): SearchHit[] {
  const k = ragConfig.rrfK;
  const byId = new Map<number, SearchHit>();

  const add = (rows: ChunkRow[], arm: "keyword" | "vector") => {
    rows.forEach((row, index) => {
      const rank = index + 1;
      const existing = byId.get(row.chunk_id);
      if (existing) {
        existing.score += 1 / (k + rank);
        existing.matchedBy[arm] = rank;
        return;
      }
      const matchedBy: SearchHit["matchedBy"] = { keyword: null, vector: null };
      matchedBy[arm] = rank;
      byId.set(row.chunk_id, {
        ...toHit(row),
        score: 1 / (k + rank),
        rerankScore: null,
        matchedBy,
      });
    });
  };

  add(keyword, "keyword");
  add(vector, "vector");

  return [...byId.values()].sort((a, b) => b.score - a.score);
}

/* --- entry point --------------------------------------------------------- */

export async function search(
  query: string,
  options: SearchOptions = {},
): Promise<SearchResult> {
  const started = performance.now();
  const limit = options.limit ?? 10;
  const armOptions: SearchOptions = { ...options, limit: ragConfig.candidatesPerArm };
  const trimmed = query.trim();

  if (trimmed.length === 0) {
    return {
      query: trimmed,
      hits: [],
      reranked: false,
      timings: { keywordMs: 0, vectorMs: 0, rerankMs: 0, totalMs: 0 },
    };
  }

  const keywordStart = performance.now();
  const keyword = keywordSearch(trimmed, armOptions).rows;
  const keywordMs = performance.now() - keywordStart;

  const vectorStart = performance.now();
  const vector = await vectorSearch(trimmed, armOptions);
  const vectorMs = performance.now() - vectorStart;

  let hits = fuse(keyword, vector);
  let rerankMs = 0;
  let reranked = false;

  const shouldRerank = (options.rerank ?? true) && hits.length > 1;
  if (shouldRerank) {
    const candidates = hits.slice(0, ragConfig.rerankCandidates);
    const rerankStart = performance.now();
    const scores = await rerank(
      trimmed,
      candidates.map((hit) => hit.text),
      { signal: options.signal },
    );
    rerankMs = performance.now() - rerankStart;

    for (const { index, score } of scores) {
      candidates[index].rerankScore = score;
    }
    // Reranked candidates come first, ordered by relevance; the fused tail
    // keeps its own order behind them.
    hits = [
      ...candidates.sort((a, b) => (b.rerankScore ?? 0) - (a.rerankScore ?? 0)),
      ...hits.slice(ragConfig.rerankCandidates),
    ];
    reranked = true;
  }

  return {
    query: trimmed,
    hits: hits.slice(0, limit),
    reranked,
    timings: {
      keywordMs,
      vectorMs,
      rerankMs,
      totalMs: performance.now() - started,
    },
  };
}

export interface IndexStats {
  matters: {
    matterId: number;
    displayNumber: string | null;
    lastSyncedAt: string | null;
    sources: number;
    chunks: number;
    embedded: number;
    documentsNeedingText: number;
  }[];
  totals: { sources: number; chunks: number; embedded: number };
  byKind: { kind: string; sources: number; chunks: number; embedded: number }[];
  embedModel: string;
  generation: number;
}

export function indexStats(): IndexStats {
  const db = getDb();
  const model = ragConfig.embedModel;

  const matters = db
    .prepare(
      `SELECT
         m.matter_id      AS matterId,
         m.display_number AS displayNumber,
         m.last_synced_at AS lastSyncedAt,
         (SELECT COUNT(*) FROM sources s WHERE s.matter_id = m.matter_id) AS sources,
         (SELECT COUNT(*) FROM chunks c JOIN sources s ON s.id = c.source_id
           WHERE s.matter_id = m.matter_id) AS chunks,
         (SELECT COUNT(*) FROM chunks c JOIN sources s ON s.id = c.source_id
           WHERE s.matter_id = m.matter_id AND c.embedding_model IS ?) AS embedded,
         (SELECT COUNT(*) FROM sources s
           WHERE s.matter_id = m.matter_id AND s.kind = 'document' AND s.needs_text = 1)
           AS documentsNeedingText
       FROM matters m ORDER BY m.matter_id`,
    )
    .all(model) as IndexStats["matters"];

  const byKind = db
    .prepare(
      `SELECT
         s.kind AS kind,
         COUNT(DISTINCT s.id) AS sources,
         COUNT(c.id) AS chunks,
         SUM(CASE WHEN c.embedding_model IS ? THEN 1 ELSE 0 END) AS embedded
       FROM sources s LEFT JOIN chunks c ON c.source_id = s.id
       GROUP BY s.kind ORDER BY s.kind`,
    )
    .all(model) as IndexStats["byKind"];

  const totals = db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM sources) AS sources,
         (SELECT COUNT(*) FROM chunks) AS chunks,
         (SELECT COUNT(*) FROM chunks WHERE embedding_model IS ?) AS embedded`,
    )
    .get(model) as IndexStats["totals"];

  return { matters, totals, byKind, embedModel: model, generation: indexGeneration() };
}
