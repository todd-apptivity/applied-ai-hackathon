import { NextResponse, type NextRequest } from "next/server";

import { clioErrorResponse } from "@/lib/clio/http-errors";
import { isVoyageConfigured } from "@/lib/rag/config";
import { syncAllMatters, syncMatter } from "@/lib/rag/sync";

/**
 * POST /api/rag/sync
 *
 * Body: { matterId?: number, full?: boolean, skipEmbedding?: boolean, status?: string }
 *
 * With `matterId`, refreshes one matter; without it, every matter with the
 * given status (default Open). A full sync re-pulls everything and prunes
 * records Clio no longer has; the default incremental sync asks Clio only for
 * what changed since the stored cursor.
 */
export async function POST(request: NextRequest) {
  let body: {
    matterId?: number;
    full?: boolean;
    skipEmbedding?: boolean;
    status?: string;
  } = {};

  if (request.headers.get("content-type")?.includes("application/json")) {
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Body must be valid JSON." }, { status: 400 });
    }
  }

  if (!body.skipEmbedding && !isVoyageConfigured()) {
    return NextResponse.json(
      {
        error:
          "VOYAGE_API_KEY is not set. Set it, or pass skipEmbedding to cache Clio records without embedding them.",
      },
      { status: 503 },
    );
  }

  const options = {
    full: body.full === true,
    skipEmbedding: body.skipEmbedding === true,
    signal: request.signal,
  };

  try {
    if (body.matterId !== undefined) {
      if (!Number.isFinite(body.matterId)) {
        return NextResponse.json({ error: "`matterId` must be a number." }, { status: 400 });
      }
      return NextResponse.json({ reports: [await syncMatter(body.matterId, options)] });
    }

    return NextResponse.json({
      reports: await syncAllMatters({ ...options, status: body.status }),
    });
  } catch (error) {
    // Clio failures carry their own status; anything else is ours.
    const clio = clioErrorResponse(error);
    if (clio.status !== 500) return clio;
    const message = error instanceof Error ? error.message : "Sync failed.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
