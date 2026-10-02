/**
 * Writing the index.
 *
 * Sources are keyed by (matter, kind, Clio id, page) and carry a content hash,
 * so a refresh only re-chunks and re-embeds what actually changed. Embedding is
 * a separate pass over rows with no vector, which means an interrupted seed
 * resumes instead of starting over, and a model change is just a re-embed.
 */

import type { Database } from "@/lib/db/sqlite";
import { bumpIndexGeneration, getDb, transact } from "@/lib/db/sqlite";
import { chunkText, contextualize } from "./chunk";
import { ragConfig } from "./config";
import {
  markRevisionHistoryStart,
  recordRevision,
  type PriorSource,
} from "./revisions";
import { hashContent, type SourceKind, type SourceRecord } from "./sources";
import { embed, encodeVector } from "./voyage";

export interface UpsertStats {
  inserted: number;
  updated: number;
  unchanged: number;
  removed: number;
  chunksWritten: number;
  /** Rows appended to the change log. Zero on a sync that changed nothing. */
  revisions: number;
}

export interface EmbedStats {
  chunksEmbedded: number;
  batches: number;
  totalTokens: number;
  model: string;
}

/**
 * The stored row, wide enough to become a revision.
 *
 * The hash alone would decide whether to rewrite, but the change log needs the
 * content it is replacing, and this is the last moment it exists.
 */
type ExistingSource = PriorSource;

/** The same row plus its identity, for the prune pass. */
interface StoredSource extends PriorSource {
  kind: SourceKind;
  clio_id: string;
  page: number;
}

const PRIOR_COLUMNS =
  "id, title, text, content_hash, occurred_at, clio_updated_at, metadata";

function nowIso(): string {
  return new Date().toISOString();
}

/** Split one source's text into the rows that will be embedded. */
function chunkSource(source: SourceRecord): string[] {
  const chunks = chunkText(source.text);
  if (chunks.length <= 1) return chunks;
  // The first chunk already opens with the record's own header lines; later
  // chunks get the title so they still identify their source on their own.
  return chunks.map((chunk, index) =>
    index === 0 ? chunk : contextualize(source.title, chunk),
  );
}

function writeChunks(db: Database, sourceId: number, source: SourceRecord): number {
  db.prepare("DELETE FROM chunks WHERE source_id = ?").run(sourceId);

  const insert = db.prepare(
    "INSERT INTO chunks (source_id, ordinal, text) VALUES (?, ?, ?)",
  );
  const chunks = chunkSource(source);
  chunks.forEach((text, ordinal) => insert.run(sourceId, ordinal, text));
  return chunks.length;
}

export function upsertMatter(matter: {
  id: number;
  displayNumber?: string | null;
  description?: string | null;
  status?: string | null;
  clientName?: string | null;
}): void {
  getDb()
    .prepare(
      `INSERT INTO matters (matter_id, display_number, description, status, client_name)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (matter_id) DO UPDATE SET
         display_number = excluded.display_number,
         description    = excluded.description,
         status         = excluded.status,
         client_name    = excluded.client_name`,
    )
    .run(
      matter.id,
      matter.displayNumber ?? null,
      matter.description ?? null,
      matter.status ?? null,
      matter.clientName ?? null,
    );
}

/**
 * Write `sources` for one matter.
 *
 * `prune` removes stored sources that are absent from the incoming set — right
 * for a full pull, wrong for an incremental one, where Clio only returned the
 * records it changed. The caller decides.
 *
 * Every insert, content change, and prune also appends to `source_revisions`,
 * which is what makes the change digest possible. An unchanged source does not:
 * an equal hash means equal content, by definition. Set `recordRevisions:
 * false` to write the index without disturbing the log.
 */
export function upsertSources(
  matterId: number,
  sources: SourceRecord[],
  options: { prune: boolean; recordRevisions?: boolean },
): UpsertStats {
  const stats: UpsertStats = {
    inserted: 0,
    updated: 0,
    unchanged: 0,
    removed: 0,
    chunksWritten: 0,
    revisions: 0,
  };

  const logging = options.recordRevisions !== false;
  // One instant for the whole call, so every revision in a sync shares an
  // observed_at. Window boundaries stay clean and collapsing a record's several
  // revisions is deterministic.
  const observedAt = nowIso();

  transact((db) => {
    const find = db.prepare(
      `SELECT ${PRIOR_COLUMNS} FROM sources
       WHERE matter_id = ? AND kind = ? AND clio_id = ? AND page = ?`,
    );
    const insertSource = db.prepare(
      `INSERT INTO sources
         (matter_id, kind, clio_id, page, title, text, occurred_at,
          clio_updated_at, content_hash, metadata, needs_text, indexed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const updateSource = db.prepare(
      `UPDATE sources SET
         title = ?, text = ?, occurred_at = ?, clio_updated_at = ?,
         content_hash = ?, metadata = ?, needs_text = ?, indexed_at = ?
       WHERE id = ?`,
    );
    const touchSource = db.prepare(
      "UPDATE sources SET clio_updated_at = ?, needs_text = ? WHERE id = ?",
    );

    const seen = new Set<string>();

    for (const source of sources) {
      const key = `${source.kind}\u0000${source.clioId}\u0000${source.page}`;
      seen.add(key);

      const hash = hashContent(source.text);
      const metadata = JSON.stringify(source.metadata);
      const needsText = source.needsText ? 1 : 0;
      const existing = find.get(
        matterId,
        source.kind,
        source.clioId,
        source.page,
      ) as ExistingSource | undefined;

      const next = {
        title: source.title,
        occurredAt: source.occurredAt,
        clioUpdatedAt: source.clioUpdatedAt,
        hash,
        metadata,
      };

      if (!existing) {
        const result = insertSource.run(
          matterId,
          source.kind,
          source.clioId,
          source.page,
          source.title,
          source.text,
          source.occurredAt,
          source.clioUpdatedAt,
          hash,
          metadata,
          needsText,
          observedAt,
        );
        const sourceId = Number(result.lastInsertRowid);
        stats.chunksWritten += writeChunks(db, sourceId, source);
        stats.inserted += 1;

        if (logging) {
          recordRevision(db, {
            matterId,
            sourceId,
            kind: source.kind,
            clioId: source.clioId,
            page: source.page,
            changeType: "created",
            prior: null,
            next,
            observedAt,
          });
          stats.revisions += 1;
        }
        continue;
      }

      if (existing.content_hash === hash) {
        touchSource.run(source.clioUpdatedAt, needsText, existing.id);
        stats.unchanged += 1;
        continue;
      }

      // Before the update: `existing` is the only copy of the old content left
      // once updateSource runs.
      if (logging) {
        recordRevision(db, {
          matterId,
          sourceId: existing.id,
          kind: source.kind,
          clioId: source.clioId,
          page: source.page,
          changeType: "updated",
          prior: existing,
          next,
          observedAt,
        });
        stats.revisions += 1;
      }

      updateSource.run(
        source.title,
        source.text,
        source.occurredAt,
        source.clioUpdatedAt,
        hash,
        metadata,
        needsText,
        observedAt,
        existing.id,
      );
      stats.chunksWritten += writeChunks(db, existing.id, source);
      stats.updated += 1;
    }

    if (options.prune) {
      const stored = db
        .prepare(
          `SELECT ${PRIOR_COLUMNS}, kind, clio_id, page FROM sources WHERE matter_id = ?`,
        )
        .all(matterId) as unknown as StoredSource[];

      const remove = db.prepare("DELETE FROM sources WHERE id = ?");
      for (const row of stored) {
        const key = `${row.kind}\u0000${row.clio_id}\u0000${row.page}`;
        // Page text is written by a separate pass and is never part of a Clio
        // bundle, so a bundle-driven prune must leave it alone.
        if (row.kind === "document_page" || seen.has(key)) continue;
        // The tombstone carries the last text we held: after the DELETE this
        // revision is the only record that the thing was ever in the file.
        if (logging) {
          recordRevision(db, {
            matterId,
            sourceId: null,
            kind: row.kind,
            clioId: row.clio_id,
            page: row.page,
            changeType: "deleted",
            prior: row,
            next: null,
            observedAt,
          });
          stats.revisions += 1;
        }

        remove.run(row.id);
        stats.removed += 1;
      }
    }

    bumpIndexGeneration();
  });

  // Only once the transaction has committed: the watermark claims the log is
  // complete from this instant on, and it must not make that claim about a
  // rolled-back write. Idempotent, so later syncs leave the original alone.
  if (logging && stats.revisions > 0) {
    markRevisionHistoryStart(matterId, observedAt);
  }

  return stats;
}

/** Clio ids of documents that already have at least one page indexed. */
export function documentsWithPages(matterId: number): Set<string> {
  const rows = getDb()
    .prepare(
      "SELECT DISTINCT clio_id FROM sources WHERE matter_id = ? AND kind = 'document_page'",
    )
    .all(matterId) as { clio_id: string }[];
  return new Set(rows.map((row) => row.clio_id));
}

/** Clear the "awaiting text" flag once a document's pages are indexed. */
export function clearNeedsText(matterId: number, documentClioId: string): void {
  getDb()
    .prepare(
      `UPDATE sources SET needs_text = 0
       WHERE matter_id = ? AND kind = 'document' AND clio_id = ?`,
    )
    .run(matterId, documentClioId);
}

export function pendingChunkCount(matterId?: number): number {
  const db = getDb();
  const row = (
    matterId === undefined
      ? db.prepare(
          `SELECT COUNT(*) AS n FROM chunks
           WHERE embedding IS NULL OR embedding_model IS NOT ?`,
        ).get(ragConfig.embedModel)
      : db.prepare(
          `SELECT COUNT(*) AS n FROM chunks c
           JOIN sources s ON s.id = c.source_id
           WHERE s.matter_id = ? AND (c.embedding IS NULL OR c.embedding_model IS NOT ?)`,
        ).get(matterId, ragConfig.embedModel)
  ) as { n: number };
  return row.n;
}

/**
 * Embed every chunk that has no vector, or whose vector came from a different
 * model. Writes each batch in its own transaction so progress survives an
 * interruption.
 */
export async function embedPendingChunks(
  options: {
    matterId?: number;
    signal?: AbortSignal;
    onProgress?: (done: number, total: number) => void;
  } = {},
): Promise<EmbedStats> {
  const db = getDb();
  const model = ragConfig.embedModel;
  const stats: EmbedStats = {
    chunksEmbedded: 0,
    batches: 0,
    totalTokens: 0,
    model,
  };

  const total = pendingChunkCount(options.matterId);
  if (total === 0) return stats;

  const select =
    options.matterId === undefined
      ? db.prepare(
          `SELECT c.id, c.text FROM chunks c
           WHERE c.embedding IS NULL OR c.embedding_model IS NOT ?
           ORDER BY c.id LIMIT ?`,
        )
      : db.prepare(
          `SELECT c.id, c.text FROM chunks c
           JOIN sources s ON s.id = c.source_id
           WHERE s.matter_id = ? AND (c.embedding IS NULL OR c.embedding_model IS NOT ?)
           ORDER BY c.id LIMIT ?`,
        );

  const update = db.prepare(
    `UPDATE chunks SET embedding = ?, embedding_model = ?, embedding_dim = ?, embedded_at = ?
     WHERE id = ?`,
  );

  for (;;) {
    options.signal?.throwIfAborted();

    const rows = (
      options.matterId === undefined
        ? select.all(model, ragConfig.embedBatchSize)
        : select.all(options.matterId, model, ragConfig.embedBatchSize)
    ) as { id: number; text: string }[];

    if (rows.length === 0) break;

    const result = await embed(
      rows.map((row) => row.text),
      "document",
      { signal: options.signal, model },
    );

    transact(() => {
      const stamp = nowIso();
      rows.forEach((row, index) => {
        const vector = result.embeddings[index];
        update.run(
          encodeVector(vector),
          model,
          vector.length,
          stamp,
          row.id,
        );
      });
      bumpIndexGeneration();
    });

    stats.chunksEmbedded += rows.length;
    stats.batches += 1;
    stats.totalTokens += result.totalTokens;
    options.onProgress?.(stats.chunksEmbedded, total);
  }

  return stats;
}

export function recordSyncCursor(
  matterId: number,
  cursor: { lastSyncedAt: string; lastFetchedAt: string },
): void {
  getDb()
    .prepare(
      "UPDATE matters SET last_synced_at = ?, last_fetched_at = ? WHERE matter_id = ?",
    )
    .run(cursor.lastSyncedAt, cursor.lastFetchedAt, matterId);
}

export function syncCursor(matterId: number): string | null {
  const row = getDb()
    .prepare("SELECT last_synced_at FROM matters WHERE matter_id = ?")
    .get(matterId) as { last_synced_at?: string | null } | undefined;
  return row?.last_synced_at ?? null;
}
