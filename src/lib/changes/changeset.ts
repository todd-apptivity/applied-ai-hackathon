/**
 * What changed, exactly.
 *
 * This is a time-window query, not a search. `search()` is recall-first by
 * design — it sanitizes a query into OR'd prefix terms and ranks what comes
 * back — which is right for "what does the file say about the left knee" and
 * wrong for "what changed", where a miss is a lie. So nothing on this path
 * touches retrieval, embeddings, or the reranker.
 *
 * The visibility predicate arrives as `scope.kinds`, already narrowed by the
 * permission layer, and goes into the SQL WHERE rather than a filter over the
 * results. Denied text is never read into this process, which is the same
 * order `search()` uses and the reason the model cannot paraphrase something it
 * was not allowed to see.
 */

import { sourceLink } from "@/lib/chat/source-link";
import { getDb } from "@/lib/db/sqlite";
import { hashContent, type SourceKind } from "@/lib/rag/sources";
import { revisionHistoryStart } from "@/lib/rag/revisions";

import type { ResolvedWindow } from "./checkpoint";
import { classifyRow, collapseRevisions, type RevisionRow } from "./classify";
import { countEvents, emptyCounts, type ChangeEvent, type Changeset } from "./types";

export interface ChangesetScope {
  matterId: number;
  /** Kinds this viewer may read. Empty means an empty changeset, not "all". */
  kinds: readonly SourceKind[];
  /**
   * Optional per-record allow-list, ANDed with `kinds`.
   *
   * Unused in v1 and deliberately wired anyway: the PRD's provider share
   * approves individual records, and when that lands it should be a value
   * passed in here rather than a second query to write.
   */
  sourceIds?: readonly number[];
}

/** Longest excerpt handed to the model per change. */
const EXCERPT_CHARS = 1200;

export const DEFAULT_LIMIT = 40;

/**
 * Above this many events from the fallback path, the window is reported as
 * truncated history and no prose is composed. Enumerating a whole imported case
 * as "new" would be true of the index and false of the case.
 */
export const DEGRADED_MAX_EVENTS = 25;

interface CountRow {
  n: number;
}

function totalSources(matterId: number, kinds: readonly SourceKind[]): number {
  if (kinds.length === 0) return 0;
  const placeholders = kinds.map(() => "?").join(",");
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS n FROM sources
        WHERE matter_id = ? AND kind IN (${placeholders})`,
    )
    .get(matterId, ...kinds) as unknown as CountRow;
  return row.n;
}

/** Documents that already had a page indexed before this window opened. */
function documentsWithPagesBefore(matterId: number, from: string | null): Set<string> {
  const rows = getDb()
    .prepare(
      `SELECT DISTINCT clio_id FROM source_revisions
        WHERE matter_id = ? AND kind = 'document_page'
          AND change_type = 'created'
          AND (? IS NULL OR observed_at <= ?)`,
    )
    .all(matterId, from, from) as unknown as { clio_id: string }[];
  return new Set(rows.map((row) => row.clio_id));
}

/* --- tier A: the change log ---------------------------------------------- */

function readRevisions(
  scope: ChangesetScope,
  window: ResolvedWindow,
  limit: number,
): RevisionRow[] {
  const kinds = scope.kinds.map(() => "?").join(",");
  const sourceFilter =
    scope.sourceIds && scope.sourceIds.length > 0
      ? `AND r.source_id IN (${scope.sourceIds.map(() => "?").join(",")})`
      : "";

  const sql = `
    SELECT r.id, r.matter_id, r.source_id, r.kind, r.clio_id, r.page,
           r.change_type, r.title, r.prev_title,
           substr(COALESCE(s.text, r.prev_text), 1, ${EXCERPT_CHARS}) AS excerpt,
           substr(r.prev_text, 1, ${EXCERPT_CHARS})                   AS prev_excerpt,
           r.prev_metadata, r.new_metadata,
           r.occurred_at, r.prev_occurred_at,
           r.clio_updated_at, r.observed_at
      FROM source_revisions r
      -- LEFT, so a tombstone survives the source row it describes.
      LEFT JOIN sources s ON s.id = r.source_id
     WHERE r.matter_id = ?
       AND r.observed_at >  ?
       AND r.observed_at <= ?
       AND r.kind IN (${kinds})
       ${sourceFilter}
     ORDER BY r.observed_at DESC, r.id DESC
     LIMIT ?`;

  const params: unknown[] = [
    scope.matterId,
    // An open lower bound is the empty string: every ISO instant sorts above it.
    window.from ?? "",
    window.to,
    ...scope.kinds,
    ...(scope.sourceIds && scope.sourceIds.length > 0 ? scope.sourceIds : []),
    limit,
  ];

  return getDb()
    .prepare(sql)
    .all(...(params as never[])) as unknown as RevisionRow[];
}

/* --- tier B: the fallback ------------------------------------------------- */

/**
 * Sources that look changed but have no revision covering them.
 *
 * Needed for any matter indexed before the change log existed, and for a window
 * reaching back past the log's start. It reads Clio's `updated_at`, falling back
 * to our own `indexed_at`, and is flagged `degraded` because neither is a real
 * record of when we learned: an imported case has every record stamped with the
 * import, so this path tends to return everything or nothing.
 */
function readFallback(
  scope: ChangesetScope,
  window: ResolvedWindow,
  limit: number,
): RevisionRow[] {
  const kinds = scope.kinds.map(() => "?").join(",");
  const sourceFilter =
    scope.sourceIds && scope.sourceIds.length > 0
      ? `AND s.id IN (${scope.sourceIds.map(() => "?").join(",")})`
      : "";

  const sql = `
    SELECT s.id AS id, s.matter_id, s.id AS source_id, s.kind, s.clio_id, s.page,
           'created' AS change_type, s.title, NULL AS prev_title,
           substr(s.text, 1, ${EXCERPT_CHARS}) AS excerpt,
           NULL AS prev_excerpt,
           NULL AS prev_metadata, s.metadata AS new_metadata,
           s.occurred_at, NULL AS prev_occurred_at,
           s.clio_updated_at,
           COALESCE(s.clio_updated_at, s.indexed_at) AS observed_at
      FROM sources s
     WHERE s.matter_id = ?
       AND COALESCE(s.clio_updated_at, s.indexed_at) >  ?
       AND COALESCE(s.clio_updated_at, s.indexed_at) <= ?
       AND s.kind IN (${kinds})
       ${sourceFilter}
       -- Anything the change log already covers is reported from there.
       AND NOT EXISTS (
         SELECT 1 FROM source_revisions r
          WHERE r.matter_id = s.matter_id AND r.kind = s.kind
            AND r.clio_id = s.clio_id AND r.page = s.page
            AND r.observed_at > ? AND r.observed_at <= ?
       )
     ORDER BY observed_at DESC, s.id DESC
     LIMIT ?`;

  const params: unknown[] = [
    scope.matterId,
    window.from ?? "",
    window.to,
    ...scope.kinds,
    ...(scope.sourceIds && scope.sourceIds.length > 0 ? scope.sourceIds : []),
    window.from ?? "",
    window.to,
    limit,
  ];

  return getDb()
    .prepare(sql)
    .all(...(params as never[])) as unknown as RevisionRow[];
}

/* --- fingerprint ---------------------------------------------------------- */

/**
 * Identity of a changeset, for the digest cache.
 *
 * `window.to` is deliberately left out. It moves to "now" on every request, so
 * including it would change the hash on every refresh and guarantee a fresh
 * model call for an unchanged matter — the opposite of what the cache is for.
 * The stored digest keeps its own `window_to` so the UI can still say what it
 * was composed against.
 */
export function fingerprintChangeset(
  scope: ChangesetScope,
  window: ResolvedWindow,
  events: ChangeEvent[],
): string {
  return hashContent(
    JSON.stringify({
      matterId: scope.matterId,
      kinds: [...scope.kinds].sort(),
      sourceIds: scope.sourceIds ? [...scope.sourceIds].sort() : null,
      from: window.from,
      events: events.map((event) => [
        event.ref,
        event.type,
        event.observedAt,
        event.deltas,
      ]),
    }),
  );
}

/* --- the entry point ------------------------------------------------------ */

export function buildChangeset(
  scope: ChangesetScope,
  window: ResolvedWindow,
  options: { limit?: number } = {},
): Changeset {
  const limit = options.limit ?? DEFAULT_LIMIT;
  const historyStart = revisionHistoryStart(scope.matterId);
  const truncated =
    historyStart === null || window.from === null || window.from < historyStart;

  const empty: Changeset = {
    matterId: scope.matterId,
    window,
    events: [],
    counts: emptyCounts(),
    history: { startsAt: historyStart, truncated },
    degraded: false,
    totalSources: 0,
    fingerprint: "",
  };

  if (scope.kinds.length === 0) {
    return { ...empty, fingerprint: fingerprintChangeset(scope, window, []) };
  }

  const rows = readRevisions(scope, window, limit);

  // Only reach for the fallback when the log cannot answer the whole window.
  // Asking for one extra row is how truncation is detected without a COUNT.
  const fallback = truncated
    ? readFallback(scope, window, DEGRADED_MAX_EVENTS + 1)
    : [];

  const degraded = fallback.length > 0;
  const fallbackOverflow = fallback.length > DEGRADED_MAX_EVENTS;

  const collapsed = collapseRevisions([
    ...rows,
    // Drop the overflow: the caller is told history is truncated instead.
    ...(fallbackOverflow ? [] : fallback),
  ]);

  const documentsAlreadyIndexed = documentsWithPagesBefore(
    scope.matterId,
    window.from,
  );

  const events = collapsed
    .flatMap((row) =>
      classifyRow(row, {
        clioUrl: sourceLink(row.kind, row.clio_id, row.matter_id, parseMetadata(row)),
        documentExisted: documentsAlreadyIndexed.has(row.clio_id),
      }),
    )
    .sort((a, b) => {
      if (b.weight !== a.weight) return b.weight - a.weight;
      if (a.observedAt !== b.observedAt) return a.observedAt < b.observedAt ? 1 : -1;
      // Final tiebreak on ref so the order — and so the fingerprint, and so the
      // cache key — is identical for identical data.
      return a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0;
    })
    .slice(0, limit);

  return {
    matterId: scope.matterId,
    window,
    events,
    counts: countEvents(events),
    history: {
      startsAt: historyStart,
      truncated: truncated && (fallbackOverflow || degraded || events.length === 0),
    },
    degraded,
    totalSources: totalSources(scope.matterId, scope.kinds),
    fingerprint: fingerprintChangeset(scope, window, events),
  };
}

function parseMetadata(row: RevisionRow): Record<string, unknown> {
  const raw = row.new_metadata ?? row.prev_metadata;
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
