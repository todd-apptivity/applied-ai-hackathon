import { NextResponse, type NextRequest } from "next/server";

import { markReviewed, recordViewEvent } from "@/lib/changes/checkpoint";
import { isMatterIndexed } from "@/lib/changes/digest";
import { resolvePrincipal } from "@/lib/identity/current-viewer";
import { canAccessMatter } from "@/lib/permissions/policy";

/**
 * POST /api/matters/{id}/reviewed
 *
 * "I have read this." Commits the review checkpoint early and starts a fresh
 * session, so the next visit reports only what arrives from here on. The
 * checkpoint also advances on its own after a session gap; this is the explicit
 * version, for someone who is done now rather than done tomorrow.
 */
export async function POST(
  request: NextRequest,
  context: RouteContext<"/api/matters/[matterId]/reviewed">,
) {
  const { matterId } = await context.params;
  const id = Number(matterId);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "invalid_matter_id" }, { status: 400 });
  }
  if (!isMatterIndexed(id)) {
    return NextResponse.json({ error: "matter_not_indexed" }, { status: 404 });
  }

  const { viewer, principal } = resolvePrincipal(request, id);
  if (!canAccessMatter(principal, id)) {
    return NextResponse.json({ error: "matter_not_permitted" }, { status: 403 });
  }

  const state = markReviewed(viewer.id, id);
  recordViewEvent({
    viewerId: viewer.id,
    matterId: id,
    event: "marked_reviewed",
    window: {
      from: state.reviewedThrough,
      to: state.reviewedThrough ?? new Date().toISOString(),
      kind: "checkpoint",
      label: "marked reviewed",
      readOnly: false,
    },
  });

  return NextResponse.json({
    viewer: { id: viewer.id, name: viewer.name, role: viewer.role },
    state,
  });
}
