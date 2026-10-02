/**
 * Viewers — STUB, but a real table.
 *
 * This is still not authentication. There is no password, no session token, no
 * verification: the current viewer is whichever row a cookie names, and anyone
 * can change the cookie. What it does add over the query-parameter stub it
 * replaces is a *stable identity*, which read state needs — "since the last
 * time I reviewed it" is meaningless without a durable "I" to key on.
 *
 * TODO(auth): replace `viewerFromRequest` in ./current-viewer with two real
 * lookups and delete the cookie path.
 *
 *   firm      -> the signed-in staff session
 *   provider  -> a `provider_shares` row keyed by the unguessable share token
 *                in the URL, carrying matter_id, approved kinds, released
 *                topics, and revoked_at
 *
 * The `viewers` row shape is deliberately close to what those lookups would
 * return, so the swap is a change of source rather than a change of model.
 */

import { getCurrentUser } from "@/lib/clio/resources";
import { getDb } from "@/lib/db/sqlite";
import { PROVIDER_BASELINE_KINDS } from "@/lib/permissions/policy";
import type { ViewAs } from "@/lib/permissions/principal";
import type { Principal } from "@/lib/permissions/types";

export interface ViewerRecord {
  /** `firm:<clio user id>` or `provider:<slug>`. Prefixed so roles cannot collide. */
  id: string;
  name: string;
  role: ViewAs;
  /** From Clio's `who_am_i`, when the firm is connected. */
  clioUserId: number | null;
  /** The one matter a provider viewer may see. NULL for firm staff. */
  matterId: number | null;
  createdAt: string;
}

interface ViewerRow {
  id: string;
  name: string;
  role: string;
  clio_user_id: number | null;
  matter_id: number | null;
  created_at: string;
}

/**
 * The fallback firm viewer, used when Clio has never been connected. Seeded
 * rather than returned ad hoc so `view_events.viewer_id` always resolves to a
 * row that exists.
 */
export const LOCAL_FIRM_VIEWER_ID = "firm:local";
export const DEMO_PROVIDER_VIEWER_ID = "provider:demo";

function nowIso(): string {
  return new Date().toISOString();
}

function toRecord(row: ViewerRow): ViewerRecord {
  return {
    id: row.id,
    name: row.name,
    role: row.role === "provider" ? "provider" : "firm",
    clioUserId: row.clio_user_id ?? null,
    matterId: row.matter_id ?? null,
    createdAt: row.created_at,
  };
}

export function listViewers(): ViewerRecord[] {
  const rows = getDb()
    .prepare(
      // Firm staff first, then by name, so a switcher's order is stable.
      `SELECT id, name, role, clio_user_id, matter_id, created_at FROM viewers
       ORDER BY CASE role WHEN 'firm' THEN 0 ELSE 1 END, name`,
    )
    .all() as unknown as ViewerRow[];
  return rows.map(toRecord);
}

export function getViewer(id: string): ViewerRecord | null {
  const row = getDb()
    .prepare(
      `SELECT id, name, role, clio_user_id, matter_id, created_at FROM viewers
       WHERE id = ?`,
    )
    .get(id) as unknown as ViewerRow | undefined;
  return row ? toRecord(row) : null;
}

export function upsertViewer(
  viewer: Omit<ViewerRecord, "createdAt"> & { createdAt?: string },
): ViewerRecord {
  getDb()
    .prepare(
      `INSERT INTO viewers (id, name, role, clio_user_id, matter_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         name         = excluded.name,
         role         = excluded.role,
         clio_user_id = excluded.clio_user_id,
         matter_id    = excluded.matter_id`,
    )
    .run(
      viewer.id,
      viewer.name,
      viewer.role,
      viewer.clioUserId,
      viewer.matterId,
      viewer.createdAt ?? nowIso(),
    );

  // Re-read rather than echo the input: on conflict the stored created_at wins.
  return getViewer(viewer.id)!;
}

/**
 * Some firm viewer, always. Seeds a local one if the table is empty, so no
 * caller has to handle "there is nobody" — a fresh clone with no Clio
 * connection still has a working dashboard.
 */
export function defaultViewer(): ViewerRecord {
  const existing = getDb()
    .prepare(
      `SELECT id, name, role, clio_user_id, matter_id, created_at FROM viewers
       WHERE role = 'firm' ORDER BY created_at LIMIT 1`,
    )
    .get() as unknown as ViewerRow | undefined;

  if (existing) return toRecord(existing);

  return upsertViewer({
    id: LOCAL_FIRM_VIEWER_ID,
    name: "Firm staff (local)",
    role: "firm",
    clioUserId: null,
    matterId: null,
  });
}

/**
 * Seed viewers from Clio.
 *
 * Reuses the `who_am_i` read the connection status page already makes, so the
 * firm viewer is keyed on a real Clio user id rather than an invented one. Also
 * seeds one demo provider so the switcher can demonstrate the scoped view.
 *
 * Never throws: an unconnected Clio is the normal state of a fresh clone, and
 * seeding is not the moment to fail over it.
 */
export async function seedViewersFromClio(
  options: { signal?: AbortSignal; providerMatterId?: number } = {},
): Promise<{ viewers: ViewerRecord[]; clioError: string | null }> {
  const viewers: ViewerRecord[] = [];
  let clioError: string | null = null;

  try {
    const user = await getCurrentUser({ signal: options.signal });
    viewers.push(
      upsertViewer({
        id: `firm:${user.id}`,
        name: user.name ?? user.email ?? `Clio user ${user.id}`,
        role: "firm",
        clioUserId: user.id,
        matterId: null,
      }),
    );
  } catch (error) {
    clioError = error instanceof Error ? error.message : "Could not read the Clio user.";
    viewers.push(defaultViewer());
  }

  viewers.push(
    upsertViewer({
      id: DEMO_PROVIDER_VIEWER_ID,
      name: "Outside provider (demo)",
      role: "provider",
      clioUserId: null,
      matterId: options.providerMatterId ?? null,
    }),
  );

  return { viewers, clioError };
}

/**
 * Bridge a viewer row to the permission layer's `Principal`.
 *
 * `matterId` is the matter being requested. A provider's own `matterId` wins
 * when it is set — which is the point: a real share carries its own scope, so
 * replaying a provider's cookie against another matter has to fail
 * `canAccessMatter` rather than silently re-scope. The query-parameter stub
 * could never fail that check, because it built the principal from whatever
 * matter was asked for.
 */
export function viewerToPrincipal(viewer: ViewerRecord, matterId: number): Principal {
  if (viewer.role === "provider") {
    return {
      kind: "provider",
      providerId: viewer.id,
      name: viewer.name,
      matterId: viewer.matterId ?? matterId,
      shareId: `${viewer.id}:stub-share`,
      // The baseline itself, not a widening: `allowedKinds` intersects, so this
      // is "everything a provider could ever see", narrowed by nothing yet.
      approvedKinds: [...PROVIDER_BASELINE_KINDS],
      // Nothing is released until an attorney releases it.
      releasedTopics: [],
    };
  }

  return { kind: "firm", userId: viewer.id, name: viewer.name };
}
