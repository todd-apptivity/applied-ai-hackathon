/**
 * The change log.
 *
 * `sources` holds what the file says now. This holds what it said before, one
 * row per observed change, which is the whole basis for answering "what
 * happened since I last looked?".
 *
 * Why not Clio's `updated_at`: it records when Clio last touched a record, not
 * when we first saw the touch. A case imported in one pass has every record
 * stamped with the import day, so a window measured on Clio's clock either
 * returns everything or nothing. `observed_at` is ours, and it is the only
 * honest answer to "was this new to me?".
 *
 * Writes go through `upsertSources`, inside the transaction it already opens —
 * a revision and the change it describes commit together or not at all.
 */

import type { Database } from "@/lib/db/sqlite";
import { getState, setState } from "@/lib/db/sqlite";

import type { SourceKind } from "./sources";

export type ChangeType = "created" | "updated" | "deleted";

/**
 * Prior text is kept for the digest to quote, not to reconstruct history, so a
 * long document page does not need storing twice. The chunk size is the natural
 * ceiling: more than this never reaches a prompt anyway.
 */
export const PREV_TEXT_CAP = 4000;

/** The columns a revision needs from the row it is about to replace. */
export interface PriorSource {
  id: number;
  title: string | null;
  text: string;
  content_hash: string;
  occurred_at: string | null;
  clio_updated_at: string | null;
  metadata: string;
}

export interface RevisionWrite {
  matterId: number;
  /** NULL once the source row is gone, which is why this is not a foreign key. */
  sourceId: number | null;
  kind: SourceKind;
  clioId: string;
  page: number;
  changeType: ChangeType;
  /** The row as it was. NULL on `created`. */
  prior: PriorSource | null;
  /** The row as it will be. NULL on `deleted`. */
  next: {
    title: string;
    occurredAt: string | null;
    clioUpdatedAt: string | null;
    hash: string;
    metadata: string;
  } | null;
  observedAt: string;
}

function cap(text: string | null | undefined): string | null {
  if (typeof text !== "string" || text.length === 0) return null;
  return text.length > PREV_TEXT_CAP ? text.slice(0, PREV_TEXT_CAP) : text;
}

/**
 * Append one revision. Takes the caller's `Database` handle rather than calling
 * `getDb()` so it joins the surrounding transaction instead of opening its own.
 */
export function recordRevision(db: Database, write: RevisionWrite): void {
  const { prior, next } = write;

  db.prepare(
    `INSERT INTO source_revisions
       (matter_id, source_id, kind, clio_id, page, change_type,
        title, prev_title, prev_text, prev_hash, new_hash,
        prev_metadata, new_metadata,
        occurred_at, prev_occurred_at,
        clio_updated_at, prev_clio_updated_at, observed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    write.matterId,
    write.sourceId,
    write.kind,
    write.clioId,
    write.page,
    write.changeType,
    // A tombstone has no "after", so it keeps the last title we knew.
    next?.title ?? prior?.title ?? null,
    prior?.title ?? null,
    cap(prior?.text),
    prior?.content_hash ?? null,
    next?.hash ?? null,
    prior?.metadata ?? null,
    next?.metadata ?? null,
    next?.occurredAt ?? prior?.occurred_at ?? null,
    prior?.occurred_at ?? null,
    next?.clioUpdatedAt ?? prior?.clio_updated_at ?? null,
    prior?.clio_updated_at ?? null,
    write.observedAt,
  );
}

/* --- history watermark ---------------------------------------------------- */

/**
 * The instant from which this matter's change log is complete.
 *
 * A matter indexed before the log existed has 456 sources and no revisions, and
 * a window reaching back past this point cannot be answered from the log. One
 * watermark in `index_state` says so, which beats writing a synthetic
 * "created" row for every pre-existing source and then having to explain why
 * the case appears to have been built in a single second.
 */
function historyKey(matterId: number): string {
  return `revisions:since:${matterId}`;
}

export function revisionHistoryStart(matterId: number): string | null {
  return getState(historyKey(matterId));
}

/** Idempotent: the first write wins, so the watermark only ever moves earlier. */
export function markRevisionHistoryStart(matterId: number, at: string): void {
  if (revisionHistoryStart(matterId) !== null) return;
  setState(historyKey(matterId), at);
}

/** True when the log covers every change back to `from`. */
export function historyCovers(matterId: number, from: string | null): boolean {
  const start = revisionHistoryStart(matterId);
  if (start === null) return false;
  if (from === null) return false;
  return from >= start;
}
