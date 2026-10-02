import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";

export type RagDatabase = Database.Database;

const DEFAULT_DB_PATH = path.join(process.cwd(), "data", "rag.sqlite");

const connections = new Map<string, RagDatabase>();

export function ragDbPath(): string {
  return process.env.RAG_DB_PATH || DEFAULT_DB_PATH;
}

/**
 * Opens (and migrates) the RAG database. Connections are cached per path so
 * route handlers reuse one handle across requests.
 */
export function openRagDb(dbPath: string = ragDbPath()): RagDatabase {
  const cached = connections.get(dbPath);
  if (cached?.open) return cached;

  if (dbPath !== ":memory:") {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new Database(dbPath);
  sqliteVec.load(db);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  connections.set(dbPath, db);
  return db;
}

export function closeRagDb(dbPath: string = ragDbPath()): void {
  const db = connections.get(dbPath);
  if (db?.open) db.close();
  connections.delete(dbPath);
}

function migrate(db: RagDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- One row per source record (note, email, task, document page, ...).
    CREATE TABLE IF NOT EXISTS records (
      id          TEXT PRIMARY KEY,            -- matter_id|source_type|source_id
      matter_id   TEXT NOT NULL,
      source_type TEXT NOT NULL,
      source_id   TEXT NOT NULL,
      title       TEXT NOT NULL,
      date        TEXT,
      page        INTEGER,
      text_hash   TEXT NOT NULL,
      metadata    TEXT NOT NULL DEFAULT '{}',
      updated_at  TEXT,
      indexed_at  TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS records_matter ON records(matter_id, source_type);

    CREATE TABLE IF NOT EXISTS chunks (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      record_id    TEXT NOT NULL REFERENCES records(id),
      matter_id    TEXT NOT NULL,
      ordinal      INTEGER NOT NULL,
      text         TEXT NOT NULL,             -- chunk body shown to the model
      embed_text   TEXT NOT NULL,             -- header + body, what was embedded
      content_hash TEXT NOT NULL              -- hash of embed_text
    );
    CREATE INDEX IF NOT EXISTS chunks_record ON chunks(record_id);
    CREATE INDEX IF NOT EXISTS chunks_matter ON chunks(matter_id);

    -- Keyword index; rowid = chunks.id.
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
      title, text, tokenize = 'porter unicode61'
    );

    -- Embeddings are cached by content so unchanged text is never re-embedded,
    -- even across rebuilds.
    CREATE TABLE IF NOT EXISTS embedding_cache (
      model        TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      dim          INTEGER NOT NULL,
      vector       BLOB NOT NULL,
      PRIMARY KEY (model, content_hash)
    );

    -- Per-page text, cached by document version so OCR runs once per file.
    CREATE TABLE IF NOT EXISTS page_text (
      version_key TEXT NOT NULL,
      page        INTEGER NOT NULL,
      method      TEXT NOT NULL,              -- 'text_layer' | 'ocr' | 'none'
      text        TEXT NOT NULL,
      PRIMARY KEY (version_key, page)
    );

    CREATE TABLE IF NOT EXISTS documents (
      matter_id          TEXT NOT NULL,
      document_id        TEXT NOT NULL,
      version_key        TEXT NOT NULL,
      name               TEXT NOT NULL,
      page_count         INTEGER NOT NULL,
      pages_without_text INTEGER NOT NULL,
      indexed_at         TEXT NOT NULL,
      PRIMARY KEY (matter_id, document_id)
    );
  `);
}

export function getMeta(db: RagDatabase, key: string): string | null {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function setMeta(db: RagDatabase, key: string, value: string): void {
  db.prepare(
    "INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
}

export function vectorTableExists(db: RagDatabase): boolean {
  return !!db
    .prepare("SELECT 1 FROM sqlite_master WHERE name = 'chunk_vectors'")
    .get();
}

/**
 * Creates the vec0 table for the active embedding model. If the model or
 * dimension changed since the last run, the old vectors are dropped and the
 * caller must re-embed (see reembedAll in ingest.ts).
 *
 * Returns true when the table was (re)created.
 */
export function ensureVectorTable(
  db: RagDatabase,
  model: string,
  dim: number,
): boolean {
  if (!Number.isInteger(dim) || dim <= 0) {
    throw new Error(`Invalid embedding dimension: ${dim}`);
  }
  const currentModel = getMeta(db, "embedding_model");
  const currentDim = Number(getMeta(db, "embedding_dim") ?? 0);
  const exists = vectorTableExists(db);
  if (exists && currentModel === model && currentDim === dim) return false;

  db.exec("DROP TABLE IF EXISTS chunk_vectors");
  db.exec(`
    CREATE VIRTUAL TABLE chunk_vectors USING vec0(
      matter_id   TEXT PARTITION KEY,
      source_type TEXT,
      date        TEXT,
      embedding   FLOAT[${dim}] distance_metric=cosine
    )
  `);
  setMeta(db, "embedding_model", model);
  setMeta(db, "embedding_dim", String(dim));
  return true;
}
