import { getMeta, vectorTableExists, type RagDatabase } from "./db";
import type { Embedder } from "./embeddings";
import type { SearchFilters, SearchResult, SourceType } from "./types";

export interface SearchOptions {
  matterId: string;
  query: string;
  /** Results to return. Default 8. */
  limit?: number;
  filters?: SearchFilters;
  /**
   * Embedder for the query. Must match the model the index was built with.
   * When omitted, or when no vectors exist yet, search is keyword-only.
   */
  embedder?: Embedder;
}

/** Reciprocal rank fusion constant. 60 is the value from the original paper. */
const RRF_K = 60;

/**
 * Hybrid search over one matter: vector similarity (semantic) plus SQLite
 * FTS5/BM25 (exact names, numbers, claim ids), merged with reciprocal rank
 * fusion. Results are always scoped to a single matter.
 */
export async function searchCaseFile(
  db: RagDatabase,
  options: SearchOptions,
): Promise<SearchResult[]> {
  const limit = clamp(options.limit ?? 8, 1, 50);
  const candidates = Math.max(limit * 5, 40);
  const filters = options.filters ?? {};

  const [vectorIds, keywordIds] = await Promise.all([
    options.embedder ? vectorSearch(db, options.embedder, options.matterId, options.query, candidates, filters) : [],
    Promise.resolve(keywordSearch(db, options.matterId, options.query, candidates, filters)),
  ]);

  const fused = new Map<number, { score: number; matchedBy: Set<"vector" | "keyword"> }>();
  const addRanks = (ids: number[], source: "vector" | "keyword") => {
    ids.forEach((id, rank) => {
      const entry = fused.get(id) ?? { score: 0, matchedBy: new Set() };
      entry.score += 1 / (RRF_K + rank + 1);
      entry.matchedBy.add(source);
      fused.set(id, entry);
    });
  };
  addRanks(vectorIds, "vector");
  addRanks(keywordIds, "keyword");

  const top = [...fused.entries()].sort((a, b) => b[1].score - a[1].score).slice(0, limit);
  if (top.length === 0) return [];

  const rows = db
    .prepare(
      `SELECT c.id, c.text, r.matter_id, r.source_type, r.source_id, r.title, r.date, r.page, r.metadata
       FROM chunks c JOIN records r ON r.id = c.record_id
       WHERE c.id IN (${top.map(() => "?").join(",")})`,
    )
    .all(...top.map(([id]) => id)) as Array<{
    id: number;
    text: string;
    matter_id: string;
    source_type: SourceType;
    source_id: string;
    title: string;
    date: string | null;
    page: number | null;
    metadata: string;
  }>;
  const byId = new Map(rows.map((row) => [row.id, row]));

  return top.flatMap(([id, { score, matchedBy }]) => {
    const row = byId.get(id);
    if (!row) return [];
    return [
      {
        chunkId: row.id,
        matterId: row.matter_id,
        sourceType: row.source_type,
        sourceId: row.source_id,
        title: row.title,
        date: row.date,
        page: row.page,
        text: row.text,
        metadata: JSON.parse(row.metadata) as Record<string, unknown>,
        score,
        matchedBy: [...matchedBy],
      },
    ];
  });
}

async function vectorSearch(
  db: RagDatabase,
  embedder: Embedder,
  matterId: string,
  query: string,
  k: number,
  filters: SearchFilters,
): Promise<number[]> {
  if (!vectorTableExists(db)) return [];
  const indexedModel = getMeta(db, "embedding_model");
  if (indexedModel !== embedder.id) {
    throw new Error(
      `The index was built with ${indexedModel} but the query embedder is ${embedder.id}. ` +
        "Re-run ingestion with the current embedding settings.",
    );
  }
  const [queryVector] = await embedder.embed([query], "query");

  const where = ["embedding MATCH ?", "k = ?", "matter_id = ?"];
  const params: unknown[] = [queryVector, Math.min(k, 4096), matterId];
  if (filters.sourceTypes?.length) {
    where.push(`source_type IN (${filters.sourceTypes.map(() => "?").join(",")})`);
    params.push(...filters.sourceTypes);
  }
  if (filters.dateFrom) {
    where.push("date >= ?");
    params.push(filters.dateFrom);
  }
  if (filters.dateTo) {
    // Undated records are stored as '' and must not pass an upper bound.
    where.push("date <= ?", "date != ''");
    params.push(filters.dateTo);
  }
  const rows = db
    .prepare(`SELECT rowid FROM chunk_vectors WHERE ${where.join(" AND ")} ORDER BY distance`)
    .all(...params) as Array<{ rowid: number | bigint }>;
  return rows.map((row) => Number(row.rowid));
}

function keywordSearch(
  db: RagDatabase,
  matterId: string,
  query: string,
  limit: number,
  filters: SearchFilters,
): number[] {
  const match = toFtsQuery(query);
  if (!match) return [];
  const where = ["chunks_fts MATCH ?", "c.matter_id = ?"];
  const params: unknown[] = [match, matterId];
  if (filters.sourceTypes?.length) {
    where.push(`r.source_type IN (${filters.sourceTypes.map(() => "?").join(",")})`);
    params.push(...filters.sourceTypes);
  }
  if (filters.dateFrom) {
    where.push("r.date >= ?");
    params.push(filters.dateFrom);
  }
  if (filters.dateTo) {
    where.push("r.date <= ?");
    params.push(filters.dateTo);
  }
  params.push(limit);
  const rows = db
    .prepare(
      `SELECT c.id FROM chunks_fts
       JOIN chunks c ON c.id = chunks_fts.rowid
       JOIN records r ON r.id = c.record_id
       WHERE ${where.join(" AND ")}
       ORDER BY bm25(chunks_fts, 2.0, 1.0)
       LIMIT ?`,
    )
    .all(...params) as Array<{ id: number }>;
  return rows.map((row) => row.id);
}

const STOPWORDS = new Set(
  (
    "a an and are as at be but by did do does for from had has have he her his how i if in into is it its " +
    "me my of on or our she so than that the their them then there these they this to was we were what " +
    "when where which who whom why will with you your about any can could should would been being"
  ).split(" "),
);

/**
 * Converts free text into a safe FTS5 query: each meaningful term is quoted
 * (so punctuation and FTS operators in user text can't break the query) and
 * terms are OR'ed, letting BM25 rank chunks that match more of them higher.
 */
export function toFtsQuery(query: string): string | null {
  const terms = (query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter(
    (term) => !STOPWORDS.has(term),
  );
  const unique = [...new Set(terms)].slice(0, 32);
  if (unique.length === 0) return null;
  return unique.map((term) => `"${term}"`).join(" OR ");
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.floor(value)));
}
