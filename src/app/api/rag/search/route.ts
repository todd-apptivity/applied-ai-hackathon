import { createHash, timingSafeEqual } from "node:crypto";
import { getRagContext, searchCaseFile } from "@/lib/rag";
import { isSourceType } from "@/lib/rag/types";

function sameSecret(a: string, b: string): boolean {
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(a), digest(b));
}

/**
 * POST /api/rag/search
 * Body: { matterId, query, limit?, sourceTypes?, dateFrom?, dateTo? }
 *
 * Firm-side only: results can include anything in the case file. Never call
 * this from the provider portal. Set RAG_API_TOKEN and send it as a Bearer
 * token; it is required in production.
 */
export async function POST(request: Request) {
  const token = process.env.RAG_API_TOKEN;
  if (!token && process.env.NODE_ENV === "production") {
    return Response.json({ error: "RAG_API_TOKEN must be set in production." }, { status: 503 });
  }
  if (token && !sameSecret(request.headers.get("authorization") ?? "", `Bearer ${token}`)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Body must be JSON." }, { status: 400 });
  }

  const { matterId, query, limit, sourceTypes, dateFrom, dateTo } = body;
  if (typeof matterId !== "string" || !matterId || typeof query !== "string" || !query.trim()) {
    return Response.json({ error: "matterId and query are required strings." }, { status: 400 });
  }
  if (sourceTypes !== undefined && (!Array.isArray(sourceTypes) || !sourceTypes.every((t) => isSourceType(String(t))))) {
    return Response.json({ error: "sourceTypes contains an unknown source type." }, { status: 400 });
  }

  const { db, embedder } = getRagContext();
  try {
    const results = await searchCaseFile(db, {
      matterId,
      query,
      limit: typeof limit === "number" ? limit : undefined,
      embedder,
      filters: {
        sourceTypes: sourceTypes as never,
        dateFrom: typeof dateFrom === "string" ? dateFrom : undefined,
        dateTo: typeof dateTo === "string" ? dateTo : undefined,
      },
    });
    return Response.json({ mode: embedder ? "hybrid" : "keyword", results });
  } catch (error) {
    return Response.json({ error: (error as Error).message }, { status: 500 });
  }
}
