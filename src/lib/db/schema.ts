/**
 * The local cache and retrieval index.
 *
 * `sources` is one row per atomic Clio record — a note, an email, a task, a
 * calendar entry, an expense, a custom field, a document, or a single page of a
 * document. `chunks` is the retrievable unit: a slice of a source's text with
 * its embedding. `chunks_fts` is the keyword half of hybrid search, kept in
 * sync by triggers so there is no second write path to forget.
 *
 * Nothing here names a matter, person, or provider; every table is keyed by
 * Clio's own ids.
 */

export const SCHEMA_VERSION = 2;

export const SCHEMA_SQL = `
PRAGMA foreign_keys = ON;

-- One row per matter we have pulled. last_synced_at is the cursor handed back
-- to Clio as updated_since on the next refresh.
CREATE TABLE IF NOT EXISTS matters (
  matter_id        INTEGER PRIMARY KEY,
  display_number   TEXT,
  description      TEXT,
  status           TEXT,
  client_name      TEXT,
  last_synced_at   TEXT,
  last_fetched_at  TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sources (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  matter_id        INTEGER NOT NULL REFERENCES matters(matter_id) ON DELETE CASCADE,
  -- 'matter' | 'custom_field' | 'contact' | 'note' | 'communication' | 'task'
  -- | 'calendar_entry' | 'activity' | 'document' | 'document_page'
  kind             TEXT NOT NULL,
  -- Clio's id as text: calendar entries return strings, everything else numbers.
  clio_id          TEXT NOT NULL,
  -- Page number for 'document_page', NULL otherwise. Part of the identity key,
  -- so it is stored as 0 rather than NULL (SQLite treats NULLs as distinct).
  page             INTEGER NOT NULL DEFAULT 0,
  title            TEXT,
  text             TEXT NOT NULL,
  -- The record's own date (note date, email date, task due date). Drives
  -- recency ranking and is distinct from clio_updated_at.
  occurred_at      TEXT,
  clio_updated_at  TEXT,
  -- sha256 of text: unchanged hash means the chunks and embeddings still hold.
  content_hash     TEXT NOT NULL,
  metadata         TEXT NOT NULL DEFAULT '{}',
  -- 1 when Clio has bytes we have not turned into text yet (a scan awaiting OCR).
  needs_text       INTEGER NOT NULL DEFAULT 0,
  indexed_at       TEXT,
  UNIQUE (matter_id, kind, clio_id, page)
);

CREATE INDEX IF NOT EXISTS sources_matter_kind ON sources (matter_id, kind);
CREATE INDEX IF NOT EXISTS sources_occurred ON sources (matter_id, occurred_at);
CREATE INDEX IF NOT EXISTS sources_needs_text ON sources (matter_id, needs_text);

CREATE TABLE IF NOT EXISTS chunks (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id        INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  ordinal          INTEGER NOT NULL,
  text             TEXT NOT NULL,
  -- Float32 little-endian, one value per embedding dimension.
  embedding        BLOB,
  embedding_model  TEXT,
  embedding_dim    INTEGER,
  embedded_at      TEXT,
  UNIQUE (source_id, ordinal)
);

CREATE INDEX IF NOT EXISTS chunks_source ON chunks (source_id);
CREATE INDEX IF NOT EXISTS chunks_pending ON chunks (id) WHERE embedding IS NULL;

-- Keyword half of retrieval. External-content table: the text lives in chunks
-- and FTS5 holds only the index.
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5 (
  text,
  content='chunks',
  content_rowid='id',
  tokenize='porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS chunks_fts_insert AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts (rowid, text) VALUES (new.id, new.text);
END;

CREATE TRIGGER IF NOT EXISTS chunks_fts_delete AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts (chunks_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;

CREATE TRIGGER IF NOT EXISTS chunks_fts_update AFTER UPDATE OF text ON chunks BEGIN
  INSERT INTO chunks_fts (chunks_fts, rowid, text) VALUES ('delete', old.id, old.text);
  INSERT INTO chunks_fts (rowid, text) VALUES (new.id, new.text);
END;

-- Bumped on every write that changes chunk text or embeddings, so the in-process
-- vector cache knows when to reload.
CREATE TABLE IF NOT EXISTS index_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Who is looking, and when they last looked.
--
-- A caveat that governs every timestamp below: this file is re-executed on
-- every open and there is no migration runner, so only CREATE ... IF NOT EXISTS
-- is safe here — new tables, never ALTER. And no column that gets compared as a
-- window bound may carry DEFAULT (datetime('now')): that yields
-- '2026-10-02 18:55:27' while every TypeScript write yields
-- '2026-10-02T18:55:27.013Z', and ' ' (0x20) sorts below 'T' (0x54), so the two
-- formats compare wrong rather than erroring. Every instant here is written as
-- an explicit ISO parameter.

-- One row per viewer. Not authentication — see src/lib/identity/viewers.ts —
-- but a real table, so read state has a stable key to hang off.
CREATE TABLE IF NOT EXISTS viewers (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  -- 'firm' | 'provider', matching ViewAs in the permission layer.
  role          TEXT NOT NULL,
  -- From Clio's /users/who_am_i.json, when the firm is connected.
  clio_user_id  INTEGER,
  -- Provider viewers are scoped to exactly one matter; NULL for firm staff.
  matter_id     INTEGER,
  created_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS viewers_role ON viewers (role);

-- Append-only log of who opened what. Records the window each viewer was
-- actually shown, so the log answers "what did they see?" and not just "when".
CREATE TABLE IF NOT EXISTS view_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  viewer_id   TEXT NOT NULL,
  matter_id   INTEGER NOT NULL,
  -- 'matter_opened' | 'digest_viewed' | 'marked_reviewed'
  event       TEXT NOT NULL,
  window_from TEXT,
  window_to   TEXT,
  digest_id   INTEGER,
  occurred_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS view_events_viewer
  ON view_events (viewer_id, matter_id, occurred_at);

-- The review checkpoint, one row per (viewer, matter).
--
-- Two pointers rather than one. reviewed_through is the committed baseline and
-- the lower bound of "since you last reviewed"; pending_through is the current
-- session's high-water mark and the upper bound. Opening the matter moves only
-- pending_through, so a refresh cannot destroy the window you are mid-way
-- through reading. A new session commits pending_through into reviewed_through.
CREATE TABLE IF NOT EXISTS matter_review_state (
  viewer_id          TEXT NOT NULL,
  matter_id          INTEGER NOT NULL,
  reviewed_through   TEXT,
  pending_through    TEXT,
  session_started_at TEXT,
  last_viewed_at     TEXT,
  PRIMARY KEY (viewer_id, matter_id)
);

-- One row per observed change to a source: the change log that makes "what
-- happened since I last looked" answerable at all.
--
-- Clio's own updated_at cannot carry this. It tells you when Clio last touched
-- a record, not when we first saw the touch, and a backfilled case has every
-- record stamped with the day it was imported. observed_at is ours.
CREATE TABLE IF NOT EXISTS source_revisions (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  matter_id            INTEGER NOT NULL,
  -- Deliberately NOT a foreign key: a 'deleted' tombstone has to outlive the
  -- sources row it describes, and sources cascades from matters.
  source_id            INTEGER,
  kind                 TEXT NOT NULL,
  clio_id              TEXT NOT NULL,
  page                 INTEGER NOT NULL DEFAULT 0,
  -- 'created' | 'updated' | 'deleted'
  change_type          TEXT NOT NULL,
  title                TEXT,
  prev_title           TEXT,
  -- Prior text, capped. NULL on 'created'; on 'deleted' it is the last text we
  -- held, which is the only copy left once the source row is gone.
  prev_text            TEXT,
  prev_hash            TEXT,
  new_hash             TEXT,
  prev_metadata        TEXT,
  new_metadata         TEXT,
  occurred_at          TEXT,
  prev_occurred_at     TEXT,
  clio_updated_at      TEXT,
  prev_clio_updated_at TEXT,
  -- When WE learned. The axis every change window is measured on, and distinct
  -- from occurred_at (when it happened in the world).
  observed_at          TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS source_revisions_window
  ON source_revisions (matter_id, observed_at);
CREATE INDEX IF NOT EXISTS source_revisions_entity
  ON source_revisions (matter_id, kind, clio_id, page);

-- Composed prose, cached by a hash of everything that went into it, so
-- reopening an unchanged matter costs no model call.
CREATE TABLE IF NOT EXISTS digests (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  matter_id      INTEGER NOT NULL,
  -- 'changes_since'. The 90-second story will add its own kind here.
  kind           TEXT NOT NULL,
  input_hash     TEXT NOT NULL,
  -- 'firm' | 'provider': the same changes compose differently per scope, and a
  -- provider must never read a digest composed for firm staff.
  scope          TEXT NOT NULL,
  window_from    TEXT,
  window_to      TEXT NOT NULL,
  model          TEXT NOT NULL,
  prompt_version INTEGER NOT NULL,
  body           TEXT NOT NULL,
  input_tokens   INTEGER,
  output_tokens  INTEGER,
  created_at     TEXT NOT NULL,
  UNIQUE (kind, input_hash)
);

CREATE INDEX IF NOT EXISTS digests_matter ON digests (matter_id, kind, created_at);
`;
