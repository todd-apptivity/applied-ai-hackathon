/**
 * The single SQLite handle.
 *
 * Node 24 ships SQLite in core with FTS5 compiled in, so the cache has no
 * native dependency and no build step. The handle is cached on `globalThis` so
 * the Next dev server's module reloading does not open a second connection to
 * the same file.
 */

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { SCHEMA_SQL, SCHEMA_VERSION } from "./schema";

export type Database = DatabaseSync;

const DEFAULT_PATH = ".data/ninety.db";

export function databasePath(): string {
  // The db file is runtime state, not a bundled module, so Turbopack must not
  // treat this as a reason to trace the whole project into the server output.
  return resolve(/* turbopackIgnore: true */ process.env.RAG_DB_PATH ?? DEFAULT_PATH);
}

const cache = globalThis as unknown as { __ninetyDb?: DatabaseSync };

export function getDb(): DatabaseSync {
  if (cache.__ninetyDb) return cache.__ninetyDb;

  const path = databasePath();
  mkdirSync(dirname(path), { recursive: true });

  const db = new DatabaseSync(path);
  // WAL keeps the dev server's reads from blocking a running seed; a busy
  // timeout covers the moment a writer holds the lock.
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA_SQL);
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);

  cache.__ninetyDb = db;
  return db;
}

/** Run `fn` inside a transaction, rolling back if it throws. */
export function transact<T>(fn: (db: DatabaseSync) => T): T {
  const db = getDb();
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn(db);
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function getState(key: string): string | null {
  const row = getDb()
    .prepare("SELECT value FROM index_state WHERE key = ?")
    .get(key) as { value?: string } | undefined;
  return row?.value ?? null;
}

export function setState(key: string, value: string): void {
  getDb()
    .prepare(
      `INSERT INTO index_state (key, value) VALUES (?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    )
    .run(key, value);
}

/**
 * Monotonic counter over everything that would invalidate a cached vector set.
 * Read by the search path, bumped by the writer.
 */
export function indexGeneration(): number {
  return Number(getState("generation") ?? "0");
}

export function bumpIndexGeneration(): number {
  const next = indexGeneration() + 1;
  setState("generation", String(next));
  return next;
}
