"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";

import { markReviewed, recordViewEvent } from "@/lib/changes/checkpoint";
import { VIEWER_COOKIE } from "@/lib/identity/current-viewer";
import { getViewer, viewerToPrincipal } from "@/lib/identity/viewers";
import { canAccessMatter } from "@/lib/permissions/policy";

/**
 * Server Functions for the dashboard.
 *
 * Cookies can be set here but not during a Server Component's render, which is
 * why switching viewer is an action rather than something the page does on the
 * way past.
 */

export async function setViewerCookie(viewerId: string, matterId: number) {
  // Only an id that resolves to a row: a cookie naming nothing would silently
  // fall back to the default viewer and look like the switch did nothing.
  if (!getViewer(viewerId)) return;

  const store = await cookies();
  store.set(VIEWER_COOKIE, viewerId, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });

  revalidatePath(`/matters/${matterId}`);
}

export async function markMatterReviewed(matterId: number) {
  const store = await cookies();
  const viewerId = store.get(VIEWER_COOKIE)?.value;
  const viewer = viewerId ? getViewer(viewerId) : null;
  if (!viewer) return;

  if (!canAccessMatter(viewerToPrincipal(viewer, matterId), matterId)) return;

  const state = markReviewed(viewer.id, matterId);
  recordViewEvent({
    viewerId: viewer.id,
    matterId,
    event: "marked_reviewed",
    window: state.reviewedThrough
      ? {
          from: state.reviewedThrough,
          to: state.reviewedThrough,
          kind: "checkpoint",
          label: "marked reviewed",
          readOnly: false,
        }
      : null,
  });

  revalidatePath(`/matters/${matterId}`);
}
