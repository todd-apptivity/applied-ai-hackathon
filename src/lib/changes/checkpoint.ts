/**
 * The review checkpoint: where "the last time I reviewed it" is decided.
 *
 * The obvious design is one timestamp, set to now when you open the matter.
 * It does not work. Opening the page would consume the very baseline the page
 * is about to render against, so a refresh — or a second tab, or a window
 * toggle — would report "nothing changed" about changes you had not finished
 * reading.
 *
 * So there are two pointers:
 *
 *   reviewed_through  the COMMITTED baseline. The window's lower bound.
 *   pending_through   this session's high-water mark. The window's upper bound.
 *
 * Opening the matter moves only `pending_through`. A *new session* — a gap of
 * more than `SESSION_IDLE_MS` since the last view — commits the previous
 * session's `pending_through` into `reviewed_through` and starts a new one.
 * That is the auto-advance: come back tomorrow and you see exactly what arrived
 * since yesterday's visit, having clicked nothing. Refresh three times inside
 * one sitting and the window does not move.
 *
 * Manual windows ("last 7 days") never touch either pointer; they are marked
 * `readOnly` and the caller must not call `openMatter` for them. Reading a
 * wider window to catch up is not the same act as reviewing the file.
 */

import { getDb } from "@/lib/db/sqlite";

/**
 * How long a gap starts a new review session. Half an hour: long enough that
 * lunch does not advance your baseline, short enough that tomorrow does.
 */
export const SESSION_IDLE_MS = (() => {
  const raw = Number(process.env.CHANGES_SESSION_IDLE_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 30 * 60_000;
})();

export type ViewEventName = "matter_opened" | "digest_viewed" | "marked_reviewed";

export interface ReviewState {
  viewerId: string;
  matterId: number;
  reviewedThrough: string | null;
  pendingThrough: string | null;
  sessionStartedAt: string | null;
  lastViewedAt: string | null;
}

export type WindowRequest =
  | { kind: "checkpoint" }
  | { kind: "relative"; days: number }
  | { kind: "absolute"; since: string };

export interface ResolvedWindow {
  /** Exclusive lower bound. NULL means "before tracked history began". */
  from: string | null;
  /** Inclusive upper bound. */
  to: string;
  kind: "checkpoint" | "relative" | "absolute" | "first_visit";
  /** Human phrasing for the panel heading. */
  label: string;
  /** True when resolving this window must not advance any checkpoint. */
  readOnly: boolean;
}

interface StateRow {
  viewer_id: string;
  matter_id: number;
  reviewed_through: string | null;
  pending_through: string | null;
  session_started_at: string | null;
  last_viewed_at: string | null;
}

function nowIso(): string {
  return new Date().toISOString();
}

function toState(row: StateRow): ReviewState {
  return {
    viewerId: row.viewer_id,
    matterId: row.matter_id,
    reviewedThrough: row.reviewed_through ?? null,
    pendingThrough: row.pending_through ?? null,
    sessionStartedAt: row.session_started_at ?? null,
    lastViewedAt: row.last_viewed_at ?? null,
  };
}

const SELECT_STATE = `SELECT viewer_id, matter_id, reviewed_through, pending_through,
                             session_started_at, last_viewed_at
                        FROM matter_review_state
                       WHERE viewer_id = ? AND matter_id = ?`;

export function getReviewState(viewerId: string, matterId: number): ReviewState | null {
  const row = getDb().prepare(SELECT_STATE).get(viewerId, matterId) as unknown as
    | StateRow
    | undefined;
  return row ? toState(row) : null;
}

/** True when `now` is far enough from the last view to count as a new sitting. */
function isNewSession(state: ReviewState, now: string): boolean {
  if (!state.lastViewedAt) return true;
  const gap = Date.parse(now) - Date.parse(state.lastViewedAt);
  // An unparseable stored instant is treated as a new session: starting fresh
  // is recoverable, pinning the baseline on a bad value is not.
  if (!Number.isFinite(gap)) return true;
  return gap > SESSION_IDLE_MS;
}

/**
 * Record that this viewer opened this matter, and run the session machine.
 *
 * The only place `reviewed_through` advances without an explicit request.
 */
export function openMatter(
  viewerId: string,
  matterId: number,
  now: string = nowIso(),
): ReviewState {
  const existing = getReviewState(viewerId, matterId);
  const db = getDb();

  if (!existing) {
    // First-ever view. No baseline to compare against: nothing is "since" yet.
    db.prepare(
      `INSERT INTO matter_review_state
         (viewer_id, matter_id, reviewed_through, pending_through,
          session_started_at, last_viewed_at)
       VALUES (?, ?, NULL, ?, ?, ?)`,
    ).run(viewerId, matterId, now, now, now);
    return getReviewState(viewerId, matterId)!;
  }

  if (isNewSession(existing, now)) {
    // Commit the previous sitting, then open a new one.
    db.prepare(
      `UPDATE matter_review_state
          SET reviewed_through   = ?,
              pending_through    = ?,
              session_started_at = ?,
              last_viewed_at     = ?
        WHERE viewer_id = ? AND matter_id = ?`,
    ).run(
      existing.pendingThrough ?? existing.reviewedThrough,
      now,
      now,
      now,
      viewerId,
      matterId,
    );
    return getReviewState(viewerId, matterId)!;
  }

  // Same sitting: extend the upper bound, leave the baseline alone. This is the
  // line that makes a refresh non-destructive.
  db.prepare(
    `UPDATE matter_review_state
        SET pending_through = ?, last_viewed_at = ?
      WHERE viewer_id = ? AND matter_id = ?`,
  ).run(now, now, viewerId, matterId);

  return getReviewState(viewerId, matterId)!;
}

/**
 * "I have read this." Commits the baseline early and starts a fresh session, so
 * the next open reports only what arrives from here on.
 *
 * Idempotent, and it never moves the baseline backwards: a stale `through` from
 * a resubmitted form must not resurrect changes the viewer already dismissed.
 */
export function markReviewed(
  viewerId: string,
  matterId: number,
  through: string = nowIso(),
): ReviewState {
  const existing = getReviewState(viewerId, matterId);
  const now = nowIso();

  if (!existing) {
    getDb()
      .prepare(
        `INSERT INTO matter_review_state
           (viewer_id, matter_id, reviewed_through, pending_through,
            session_started_at, last_viewed_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(viewerId, matterId, through, through, now, now);
    return getReviewState(viewerId, matterId)!;
  }

  const committed =
    existing.reviewedThrough && existing.reviewedThrough > through
      ? existing.reviewedThrough
      : through;

  getDb()
    .prepare(
      `UPDATE matter_review_state
          SET reviewed_through   = ?,
              pending_through    = ?,
              session_started_at = ?,
              last_viewed_at     = ?
        WHERE viewer_id = ? AND matter_id = ?`,
    )
    .run(committed, committed, now, now, viewerId, matterId);

  return getReviewState(viewerId, matterId)!;
}

/* --- window resolution ---------------------------------------------------- */

function shortDate(iso: string): string {
  // The matter's local time is a display concern the UI owns; the label only
  // needs to be unambiguous, so it stays on the stored instant's date.
  return iso.slice(0, 10);
}

function minusDays(now: string, days: number): string {
  return new Date(Date.parse(now) - days * 86_400_000).toISOString();
}

export function resolveWindow(
  state: ReviewState | null,
  request: WindowRequest,
  now: string = nowIso(),
): ResolvedWindow {
  if (request.kind === "relative") {
    const days = Math.max(1, Math.floor(request.days));
    return {
      from: minusDays(now, days),
      to: now,
      kind: "relative",
      label: days === 1 ? "in the last day" : `in the last ${days} days`,
      readOnly: true,
    };
  }

  if (request.kind === "absolute") {
    return {
      from: request.since,
      to: now,
      kind: "absolute",
      label: `since ${shortDate(request.since)}`,
      readOnly: true,
    };
  }

  if (!state || state.reviewedThrough === null) {
    return {
      from: null,
      to: now,
      kind: "first_visit",
      label: "since you first opened this matter",
      readOnly: false,
    };
  }

  return {
    from: state.reviewedThrough,
    to: state.pendingThrough ?? now,
    kind: "checkpoint",
    label: `since you last reviewed this on ${shortDate(state.reviewedThrough)}`,
    readOnly: false,
  };
}

/* --- the view log --------------------------------------------------------- */

export function recordViewEvent(event: {
  viewerId: string;
  matterId: number;
  event: ViewEventName;
  /** The window the viewer was actually shown, so the log says what they saw. */
  window?: ResolvedWindow | null;
  digestId?: number | null;
  at?: string;
}): void {
  getDb()
    .prepare(
      `INSERT INTO view_events
         (viewer_id, matter_id, event, window_from, window_to, digest_id, occurred_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      event.viewerId,
      event.matterId,
      event.event,
      event.window?.from ?? null,
      event.window?.to ?? null,
      event.digestId ?? null,
      event.at ?? nowIso(),
    );
}

export function viewEventCount(viewerId: string, matterId: number): number {
  const row = getDb()
    .prepare(
      "SELECT COUNT(*) AS n FROM view_events WHERE viewer_id = ? AND matter_id = ?",
    )
    .get(viewerId, matterId) as { n: number };
  return row.n;
}
