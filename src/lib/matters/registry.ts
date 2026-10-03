/**
 * The matters this install holds, for picking one.
 *
 * `indexStats()` already reports per-matter chunk counts, which answers "is the
 * index healthy". This answers a different question — "which case needs me" —
 * so it carries the client and status, and counts how many changes are waiting
 * for this particular viewer.
 *
 * The count is a plain SQL count over the change log, with the viewer's
 * permitted kinds applied in the WHERE. It is not a changeset: no
 * classification, no collapsing, no model. A number on a list does not justify
 * composing a digest per row, and the number is for triage rather than for
 * citation.
 */

import { getDb } from "@/lib/db/sqlite";
import type { SourceKind } from "@/lib/rag/sources";

export interface MatterListing {
  matterId: number;
  displayNumber: string | null;
  description: string | null;
  clientName: string | null;
  status: string | null;
  lastSyncedAt: string | null;
  /** Records this viewer may read. */
  sources: number;
  /** Null when this viewer has never marked the matter reviewed. */
  reviewedThrough: string | null;
  /**
   * Distinct records changed since `reviewedThrough`, or null when there is no
   * baseline to measure from.
   */
  pendingChanges: number | null;
}

interface Row {
  matterId: number;
  displayNumber: string | null;
  description: string | null;
  clientName: string | null;
  status: string | null;
  lastSyncedAt: string | null;
  sources: number;
  reviewedThrough: string | null;
  pendingChanges: number | null;
}

/**
 * Every matter in the local index, newest activity first.
 *
 * `kinds` comes from the permission layer, and an empty allowance returns
 * nothing rather than everything — the same rule the changeset follows, since
 * "no kinds" must never be read as "no filter".
 *
 * Matter *scope* is not applied here: the caller filters with
 * `canAccessMatter`, so there is one implementation of that rule rather than a
 * second one in SQL that could drift from it.
 */
export function listIndexedMatters(options: {
  viewerId: string;
  kinds: readonly SourceKind[];
}): MatterListing[] {
  const { viewerId, kinds } = options;

  if (kinds.length === 0) return [];

  const placeholders = kinds.map(() => "?").join(",");

  const rows = getDb()
    .prepare(
      `SELECT
         m.matter_id      AS matterId,
         m.display_number AS displayNumber,
         m.description    AS description,
         m.client_name    AS clientName,
         m.status         AS status,
         m.last_synced_at AS lastSyncedAt,
         (SELECT COUNT(*) FROM sources s
           WHERE s.matter_id = m.matter_id AND s.kind IN (${placeholders})) AS sources,
         r.reviewed_through AS reviewedThrough,
         CASE WHEN r.reviewed_through IS NULL THEN NULL ELSE (
           -- Distinct records, not revisions: five edits to one note is one
           -- thing waiting for you, which is what the changeset would show.
           SELECT COUNT(DISTINCT rev.kind || ':' || rev.clio_id || ':' || rev.page)
             FROM source_revisions rev
            WHERE rev.matter_id = m.matter_id
              AND rev.observed_at > r.reviewed_through
              AND rev.kind IN (${placeholders})
         ) END AS pendingChanges
       FROM matters m
       LEFT JOIN matter_review_state r
              ON r.matter_id = m.matter_id AND r.viewer_id = ?
       ORDER BY m.last_synced_at DESC, m.matter_id`,
    )
    .all(...kinds, ...kinds, viewerId) as unknown as Row[];

  return rows.map((row) => ({
    ...row,
    pendingChanges: row.pendingChanges ?? null,
  }));
}

/** The client on a matter, or null when the matter is not indexed. */
export function matterClientName(matterId: number): string | null {
  const row = getDb()
    .prepare("SELECT client_name FROM matters WHERE matter_id = ?")
    .get(matterId) as { client_name?: string | null } | undefined;
  return row?.client_name ?? null;
}

/** A readable name for a matter, preferring Clio's own display number. */
export function listingLabel(matter: MatterListing): string {
  return matter.displayNumber ?? matter.description ?? `Matter ${matter.matterId}`;
}
