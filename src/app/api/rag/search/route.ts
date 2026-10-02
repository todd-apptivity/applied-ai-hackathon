import { NextResponse, type NextRequest } from "next/server";

import { clioLinks } from "@/lib/clio/resources";
import { clioHost } from "@/lib/clio/config";
import { isVoyageConfigured } from "@/lib/rag/config";
import { search } from "@/lib/rag/search";

/**
 * Deep link back into Clio for a source, so every hit is clickable.
 *
 * Notes, communications, and custom field values have no page of their own in
 * Clio, so they fall back to the matter that holds them — the PRD asks every
 * fact on screen to open its source, and a link to the containing record beats
 * no link at all.
 */
function sourceLink(
  kind: string,
  clioId: string,
  matterId: number,
  metadata: Record<string, unknown>,
) {
  const host = clioHost();
  const id = Number(clioId);

  switch (kind) {
    case "matter":
      return clioLinks.matter(host, id);
    case "contact":
      return clioLinks.contact(host, id);
    case "task":
      return clioLinks.task(host, id);
    case "calendar_entry":
      return clioLinks.calendarEntry(host, id);
    case "activity":
      return clioLinks.activity(host, id);
    case "document":
      return clioLinks.document(host, id);
    case "document_page":
      return clioLinks.document(host, Number(metadata.documentId ?? id));
    default:
      return clioLinks.matter(host, matterId);
  }
}

/** GET /api/rag/search?q=...&matter_id=...&limit=10&kinds=note,task&rerank=false */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const query = params.get("q")?.trim();

  if (!query) {
    return NextResponse.json({ error: "Missing `q` query parameter." }, { status: 400 });
  }
  if (!isVoyageConfigured()) {
    return NextResponse.json(
      { error: "VOYAGE_API_KEY is not set; retrieval needs it to embed the query." },
      { status: 503 },
    );
  }

  const matterIdRaw = params.get("matter_id");
  const matterId = matterIdRaw ? Number(matterIdRaw) : undefined;
  if (matterIdRaw && !Number.isFinite(matterId)) {
    return NextResponse.json({ error: "`matter_id` must be a number." }, { status: 400 });
  }

  const limitRaw = Number(params.get("limit"));
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 50) : 10;

  try {
    const result = await search(query, {
      matterId,
      limit,
      kinds: params.get("kinds")?.split(",").map((kind) => kind.trim()).filter(Boolean),
      rerank: params.get("rerank") !== "false",
      signal: request.signal,
    });

    return NextResponse.json({
      query: result.query,
      reranked: result.reranked,
      timings: result.timings,
      count: result.hits.length,
      hits: result.hits.map((hit) => ({
        kind: hit.kind,
        title: hit.title,
        text: hit.text,
        occurredAt: hit.occurredAt,
        score: hit.score,
        rerankScore: hit.rerankScore,
        matchedBy: hit.matchedBy,
        source: {
          sourceId: hit.sourceId,
          chunkId: hit.chunkId,
          matterId: hit.matterId,
          clioId: hit.clioId,
          page: hit.page || null,
          clioUrl: sourceLink(hit.kind, hit.clioId, hit.matterId, hit.metadata),
        },
        metadata: hit.metadata,
      })),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Search failed.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
