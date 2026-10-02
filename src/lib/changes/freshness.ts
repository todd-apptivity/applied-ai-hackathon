/**
 * Keeping the answer current.
 *
 * "Nothing changed" is only worth reading if we actually checked, so opening
 * the digest pulls Clio for anything changed since the last sync. Two rules
 * make that affordable:
 *
 *  - Embedding is skipped. Vectors are for retrieval; the changeset is a SQL
 *    window and needs none, so the digest never waits on an embedding API. The
 *    chunks are left pending for `rag:embed` or the next full sync.
 *  - A sync failure is not fatal. Clio being down is a reason to say "showing
 *    cached data", not to show nothing.
 */

import { getDb, getState, setState } from "@/lib/db/sqlite";
import { syncMatter } from "@/lib/rag/sync";

function envMs(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

/** How old the local copy may be before opening the digest re-pulls it. */
export const STALE_AFTER_MS = envMs("CHANGES_STALE_MS", 5 * 60_000);

/**
 * How often to force a full pull.
 *
 * Incremental syncs cannot detect deletions: `syncMatter` only prunes on a full
 * pull, because an incremental response omits unchanged records and absence
 * would look like removal. So tombstones — and the "removed from the file"
 * events that depend on them — only appear after a full sync, and without this
 * they would never appear at all.
 */
export const FULL_SYNC_EVERY_MS = envMs("CHANGES_FULL_SYNC_MS", 24 * 3_600_000);

export interface FreshnessResult {
  synced: boolean;
  mode: "full" | "incremental" | "skipped" | "failed";
  syncedAt: string | null;
  stale: boolean;
  /** Set when Clio refused; the digest still renders from cached data. */
  error: string | null;
}

function fullSyncKey(matterId: number): string {
  return `fullsync:${matterId}`;
}

function lastFetchedAt(matterId: number): string | null {
  const row = getDb()
    .prepare("SELECT last_fetched_at FROM matters WHERE matter_id = ?")
    .get(matterId) as { last_fetched_at?: string | null } | undefined;
  return row?.last_fetched_at ?? null;
}

function olderThan(instant: string | null, ms: number, now: number): boolean {
  if (!instant) return true;
  const parsed = Date.parse(instant);
  if (!Number.isFinite(parsed)) return true;
  return now - parsed > ms;
}

export function isStale(matterId: number, now: Date = new Date()): boolean {
  return olderThan(lastFetchedAt(matterId), STALE_AFTER_MS, now.getTime());
}

export async function refreshIfStale(
  matterId: number,
  options: { signal?: AbortSignal; force?: boolean; now?: Date } = {},
): Promise<FreshnessResult> {
  const now = options.now ?? new Date();
  const fetched = lastFetchedAt(matterId);
  const stale = olderThan(fetched, STALE_AFTER_MS, now.getTime());

  if (!stale && !options.force) {
    return { synced: false, mode: "skipped", syncedAt: fetched, stale: false, error: null };
  }

  const needsFull = olderThan(
    getState(fullSyncKey(matterId)),
    FULL_SYNC_EVERY_MS,
    now.getTime(),
  );

  try {
    const report = await syncMatter(matterId, {
      full: needsFull,
      // The whole point: the digest must not block on Voyage.
      skipEmbedding: true,
      signal: options.signal,
    });

    if (report.mode === "full") {
      setState(fullSyncKey(matterId), report.fetchedAt);
    }

    return {
      synced: true,
      mode: report.mode,
      syncedAt: report.fetchedAt,
      stale: false,
      error: null,
    };
  } catch (error) {
    if (options.signal?.aborted) throw error;
    return {
      synced: false,
      mode: "failed",
      syncedAt: fetched,
      stale: true,
      error: error instanceof Error ? error.message : "The Clio refresh failed.",
    };
  }
}
