import { NextResponse, type NextRequest } from "next/server";
import { clioErrorResponse } from "@/lib/clio/http-errors";
import { getMatterBundle } from "@/lib/clio/resources";

/**
 * Raw read of one matter and all its children:
 * GET /api/clio/matters/{matterId}?updated_since=2026-10-01T00:00:00Z
 *
 * This is the pipeline's sync input, exposed as a route so the connection
 * can be smoke-tested before any ingestion exists.
 */
export async function GET(
  request: NextRequest,
  context: RouteContext<"/api/clio/matters/[matterId]">,
) {
  const { matterId } = await context.params;
  const id = Number(matterId);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "invalid_matter_id" }, { status: 400 });
  }

  try {
    const bundle = await getMatterBundle(id, {
      updatedSince: request.nextUrl.searchParams.get("updated_since") ?? undefined,
      signal: request.signal,
    });

    return NextResponse.json({
      ...bundle,
      counts: {
        relationships: bundle.relationships.length,
        notes: bundle.notes.length,
        communications: bundle.communications.length,
        tasks: bundle.tasks.length,
        calendarEntries: bundle.calendarEntries.length,
        activities: bundle.activities.length,
        folders: bundle.folders.length,
        documents: bundle.documents.length,
      },
    });
  } catch (error) {
    return clioErrorResponse(error);
  }
}
