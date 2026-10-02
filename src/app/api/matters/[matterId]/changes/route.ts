import { NextResponse, type NextRequest } from "next/server";

import { changeDigest, MatterNotIndexedError } from "@/lib/changes/digest";
import type { WindowRequest } from "@/lib/changes/checkpoint";
import { resolvePrincipal } from "@/lib/identity/current-viewer";
import { PermissionError } from "@/lib/permissions/types";

/** A Clio refresh plus a model call; the default 15s is not enough. */
export const maxDuration = 60;

/**
 * "What happened in this case since the last time I reviewed it?"
 *
 * POST composes the answer: resolve the window against this viewer's review
 * checkpoint, refresh from Clio, read the changeset the viewer is permitted to
 * see, and write cited prose over it. GET is a cache-only peek, so a page can
 * render instantly without a sync or a model call.
 *
 * The changeset is an exact SQL window over the change log — never a search —
 * and the permission filter runs before anything reaches the model.
 */
export async function POST(
  request: NextRequest,
  context: RouteContext<"/api/matters/[matterId]/changes">,
) {
  const { matterId } = await context.params;
  const id = Number(matterId);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "invalid_matter_id" }, { status: 400 });
  }

  let body: {
    window?: unknown;
    sync?: unknown;
    compose?: unknown;
    limit?: unknown;
  } = {};

  if (request.headers.get("content-length") !== "0") {
    try {
      body = await request.json();
    } catch {
      // An empty body is the common case from a client that only wants the
      // defaults, and is not worth a 400.
      body = {};
    }
  }

  const window = parseWindow(body.window);
  if (window === "invalid") {
    return NextResponse.json({ error: "invalid_window" }, { status: 400 });
  }

  return respond(request, id, {
    window,
    sync: body.sync !== false,
    compose: body.compose !== false,
    limit: typeof body.limit === "number" ? body.limit : undefined,
  });
}

/** GET /api/matters/{id}/changes — no sync, no model, no view event. */
export async function GET(
  request: NextRequest,
  context: RouteContext<"/api/matters/[matterId]/changes">,
) {
  const { matterId } = await context.params;
  const id = Number(matterId);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "invalid_matter_id" }, { status: 400 });
  }

  const params = request.nextUrl.searchParams;
  const days = Number(params.get("days"));
  const since = params.get("since");

  const window: WindowRequest = Number.isFinite(days) && days > 0
    ? { kind: "relative", days }
    : since
      ? { kind: "absolute", since }
      : { kind: "checkpoint" };

  return respond(request, id, {
    window,
    sync: false,
    compose: false,
    // A peek must not advance the checkpoint, log a view, or store a digest:
    // it is a render of the shell, not a viewer reviewing the file.
    peek: true,
  });
}

async function respond(
  request: NextRequest,
  matterId: number,
  options: {
    window: WindowRequest;
    sync: boolean;
    compose: boolean;
    limit?: number;
    peek?: boolean;
  },
) {
  const { viewer, principal } = resolvePrincipal(request, matterId);

  try {
    const result = await changeDigest({
      principal,
      viewerId: viewer.id,
      matterId,
      window: options.window,
      sync: options.sync,
      compose: options.compose,
      limit: options.limit,
      peek: options.peek,
      signal: request.signal,
    });

    return NextResponse.json({
      ...result,
      viewer: { id: viewer.id, name: viewer.name, role: viewer.role },
    });
  } catch (error) {
    if (error instanceof PermissionError) {
      return NextResponse.json({ error: error.code }, { status: 403 });
    }
    if (error instanceof MatterNotIndexedError) {
      return NextResponse.json(
        { error: "matter_not_indexed", detail: error.message },
        { status: 404 },
      );
    }
    const message = error instanceof Error ? error.message : "The digest failed.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/** `"invalid"` rather than a throw, so the caller owns the status code. */
function parseWindow(raw: unknown): WindowRequest | "invalid" {
  if (raw === undefined || raw === null) return { kind: "checkpoint" };
  if (typeof raw !== "object") return "invalid";

  const value = raw as { kind?: unknown; days?: unknown; since?: unknown };

  if (value.kind === "checkpoint") return { kind: "checkpoint" };

  if (value.kind === "relative") {
    const days = Number(value.days);
    if (!Number.isFinite(days) || days <= 0) return "invalid";
    return { kind: "relative", days };
  }

  if (value.kind === "absolute") {
    if (typeof value.since !== "string") return "invalid";
    if (!Number.isFinite(Date.parse(value.since))) return "invalid";
    return { kind: "absolute", since: new Date(value.since).toISOString() };
  }

  return "invalid";
}
