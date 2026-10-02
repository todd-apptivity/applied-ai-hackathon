import { chunkRecord } from "./chunking";
import {
  ensureVectorTable,
  getMeta,
  setMeta,
  vectorTableExists,
  type RagDatabase,
} from "./db";
import { extractDocumentPages } from "./documents";
import type { Embedder } from "./embeddings";
import type { OcrFn } from "./ocr";
import type { CaseDocument, CaseRecord } from "./types";
import { sha256 } from "./util";

export interface MatterSnapshot {
  matterId: string;
  records: CaseRecord[];
  documents: CaseDocument[];
}

export interface IngestOptions {
  embedder: Embedder;
  /** OCR for scanned pages. Without it, pages with no text layer are skipped. */
  ocr?: OcrFn;
  /**
   * Remove indexed records for this matter that are no longer in the snapshot
   * (deleted in Clio). Only safe when the snapshot is complete. Default true.
   */
  prune?: boolean;
  log?: (message: string) => void;
}

export interface IngestStats {
  recordsAdded: number;
  recordsChanged: number;
  recordsUnchanged: number;
  recordsRemoved: number;
  documentPages: number;
  pagesWithoutText: number;
  chunksEmbedded: number;
  embeddingsFromCache: number;
}

/**
 * Brings the index for one matter in line with a snapshot of its records.
 * Idempotent: unchanged records keep their chunks and vectors, and embeddings
 * are reused by content hash, so re-running on an unchanged matter makes no
 * embedding calls.
 */
export async function ingestMatter(
  db: RagDatabase,
  snapshot: MatterSnapshot,
  options: IngestOptions,
): Promise<IngestStats> {
  const log = options.log ?? (() => {});
  const stats: IngestStats = {
    recordsAdded: 0,
    recordsChanged: 0,
    recordsUnchanged: 0,
    recordsRemoved: 0,
    documentPages: 0,
    pagesWithoutText: 0,
    chunksEmbedded: 0,
    embeddingsFromCache: 0,
  };

  const records = [...snapshot.records];
  for (const doc of snapshot.documents) {
    log(`Document: ${doc.name}`);
    const extracted = await extractDocumentPages(db, doc, { ocr: options.ocr, log });
    records.push(...extracted.records);
    stats.documentPages += extracted.pageCount;
    stats.pagesWithoutText += extracted.pagesWithoutText;
    db.prepare(
      `INSERT OR REPLACE INTO documents
         (matter_id, document_id, version_key, name, page_count, pages_without_text, indexed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      doc.matterId,
      doc.documentId,
      doc.versionKey,
      doc.name,
      extracted.pageCount,
      extracted.pagesWithoutText,
      new Date().toISOString(),
    );
  }

  upsertRecords(db, snapshot.matterId, records, stats);

  if (options.prune ?? true) {
    const seen = new Set(records.map((r) => recordKey(r)));
    const existing = db
      .prepare("SELECT id FROM records WHERE matter_id = ?")
      .all(snapshot.matterId) as Array<{ id: string }>;
    const stale = existing.filter((row) => !seen.has(row.id));
    db.transaction(() => stale.forEach((row) => deleteRecord(db, row.id)))();
    stats.recordsRemoved = stale.length;
  }

  const embedded = await syncVectors(db, options.embedder, log);
  stats.chunksEmbedded = embedded.embedded;
  stats.embeddingsFromCache = embedded.fromCache;
  setMeta(db, `last_ingest:${snapshot.matterId}`, new Date().toISOString());
  return stats;
}

export function recordKey(record: Pick<CaseRecord, "matterId" | "sourceType" | "sourceId">): string {
  return `${record.matterId}|${record.sourceType}|${record.sourceId}`;
}

function upsertRecords(
  db: RagDatabase,
  matterId: string,
  records: CaseRecord[],
  stats: IngestStats,
): void {
  const getHash = db.prepare("SELECT text_hash FROM records WHERE id = ?");
  const touch = db.prepare("UPDATE records SET metadata = ?, updated_at = ? WHERE id = ?");
  const upsert = db.prepare(`
    INSERT INTO records
      (id, matter_id, source_type, source_id, title, date, page, text_hash, metadata, updated_at, indexed_at)
    VALUES (@id, @matterId, @sourceType, @sourceId, @title, @date, @page, @hash, @metadata, @updatedAt, @indexedAt)
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title, date = excluded.date, page = excluded.page,
      text_hash = excluded.text_hash, metadata = excluded.metadata,
      updated_at = excluded.updated_at, indexed_at = excluded.indexed_at
  `);
  const insertChunk = db.prepare(
    `INSERT INTO chunks (record_id, matter_id, ordinal, text, embed_text, content_hash)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const insertFts = db.prepare("INSERT INTO chunks_fts(rowid, title, text) VALUES (?, ?, ?)");

  db.transaction(() => {
    for (const record of records) {
      if (record.matterId !== matterId) {
        throw new Error(`Record ${record.sourceId} belongs to matter ${record.matterId}, not ${matterId}`);
      }
      const id = recordKey(record);
      const hash = sha256(
        JSON.stringify([record.sourceType, record.title, record.date, record.page ?? null, record.text]),
      );
      const metadata = JSON.stringify(record.metadata ?? {});
      const existing = getHash.get(id) as { text_hash: string } | undefined;
      if (existing?.text_hash === hash) {
        touch.run(metadata, record.updatedAt ?? null, id);
        stats.recordsUnchanged += 1;
        continue;
      }
      if (existing) {
        deleteChunks(db, id);
        stats.recordsChanged += 1;
      } else {
        stats.recordsAdded += 1;
      }
      upsert.run({
        id,
        matterId,
        sourceType: record.sourceType,
        sourceId: record.sourceId,
        title: record.title,
        date: record.date,
        page: record.page ?? null,
        hash,
        metadata,
        updatedAt: record.updatedAt ?? null,
        indexedAt: new Date().toISOString(),
      });
      for (const chunk of chunkRecord(record)) {
        const info = insertChunk.run(
          id,
          matterId,
          chunk.ordinal,
          chunk.text,
          chunk.embedText,
          sha256(chunk.embedText),
        );
        insertFts.run(info.lastInsertRowid, record.title, chunk.embedText);
      }
    }
  })();
}

function deleteChunks(db: RagDatabase, recordId: string): void {
  const ids = db.prepare("SELECT id FROM chunks WHERE record_id = ?").all(recordId) as Array<{ id: number }>;
  const hasVectors = vectorTableExists(db);
  const delFts = db.prepare("DELETE FROM chunks_fts WHERE rowid = ?");
  const delVec = hasVectors ? db.prepare("DELETE FROM chunk_vectors WHERE rowid = ?") : null;
  for (const { id } of ids) {
    delFts.run(id);
    delVec?.run(BigInt(id));
  }
  db.prepare("DELETE FROM chunks WHERE record_id = ?").run(recordId);
}

function deleteRecord(db: RagDatabase, recordId: string): void {
  deleteChunks(db, recordId);
  db.prepare("DELETE FROM records WHERE id = ?").run(recordId);
}

interface PendingChunk {
  id: number;
  matter_id: string;
  source_type: string;
  date: string | null;
  embed_text: string;
  content_hash: string;
}

/**
 * Makes sure every chunk has a vector for the active embedding model. If the
 * model changed, the vector table is rebuilt (from the embedding cache where
 * possible).
 */
export async function syncVectors(
  db: RagDatabase,
  embedder: Embedder,
  log: (message: string) => void = () => {},
): Promise<{ embedded: number; fromCache: number }> {
  let ready = vectorTableExists(db) && getMeta(db, "embedding_model") === embedder.id;
  const baseQuery = `
    SELECT c.id, c.matter_id, r.source_type, r.date, c.embed_text, c.content_hash
    FROM chunks c JOIN records r ON r.id = c.record_id`;
  const pending = db
    .prepare(ready ? `${baseQuery} WHERE c.id NOT IN (SELECT rowid FROM chunk_vectors)` : baseQuery)
    .all() as PendingChunk[];
  if (pending.length === 0) return { embedded: 0, fromCache: 0 };

  const getCached = db.prepare(
    "SELECT vector FROM embedding_cache WHERE model = ? AND content_hash = ?",
  );
  const putCached = db.prepare(
    "INSERT OR REPLACE INTO embedding_cache(model, content_hash, dim, vector) VALUES (?, ?, ?, ?)",
  );

  let embedded = 0;
  let fromCache = 0;
  const batchSize = 64;
  for (let i = 0; i < pending.length; i += batchSize) {
    const batch = pending.slice(i, i + batchSize);
    const vectors = new Map<number, Float32Array>();
    const toEmbed: PendingChunk[] = [];
    for (const chunk of batch) {
      const row = getCached.get(embedder.id, chunk.content_hash) as { vector: Buffer } | undefined;
      if (row) {
        vectors.set(chunk.id, bufferToVector(row.vector));
        fromCache += 1;
      } else {
        toEmbed.push(chunk);
      }
    }
    if (toEmbed.length > 0) {
      const fresh = await embedder.embed(toEmbed.map((c) => c.embed_text), "document");
      db.transaction(() => {
        toEmbed.forEach((chunk, j) => {
          vectors.set(chunk.id, fresh[j]);
          putCached.run(embedder.id, chunk.content_hash, fresh[j].length, vectorToBuffer(fresh[j]));
        });
      })();
      embedded += toEmbed.length;
    }

    if (!ready) {
      const dim = vectors.values().next().value!.length;
      ensureVectorTable(db, embedder.id, dim);
      ready = true;
    }
    const insert = db.prepare(
      "INSERT INTO chunk_vectors(rowid, matter_id, source_type, date, embedding) VALUES (?, ?, ?, ?, ?)",
    );
    db.transaction(() => {
      for (const chunk of batch) {
        insert.run(
          BigInt(chunk.id),
          chunk.matter_id,
          chunk.source_type,
          chunk.date ?? "",
          vectors.get(chunk.id)!,
        );
      }
    })();
    log(`Vectors: ${Math.min(i + batch.length, pending.length)}/${pending.length}`);
  }
  return { embedded, fromCache };
}

export function vectorToBuffer(vector: Float32Array): Buffer {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
}

export function bufferToVector(buffer: Buffer): Float32Array {
  // Copy so the Float32Array is aligned regardless of the Buffer's offset.
  return new Float32Array(Uint8Array.from(buffer).buffer);
}
