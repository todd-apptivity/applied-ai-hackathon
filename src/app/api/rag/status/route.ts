import { NextResponse } from "next/server";

import { databasePath } from "@/lib/db/sqlite";
import { isVoyageConfigured, ragConfig } from "@/lib/rag/config";
import { indexStats } from "@/lib/rag/search";
import { pendingChunkCount } from "@/lib/rag/writer";

/** GET /api/rag/status — is the index up, and what is in it? */
export async function GET() {
  try {
    const stats = indexStats();
    const pending = pendingChunkCount();

    return NextResponse.json({
      ready: isVoyageConfigured() && stats.totals.embedded > 0 && pending === 0,
      voyageConfigured: isVoyageConfigured(),
      databasePath: databasePath(),
      rerankModel: ragConfig.rerankModel,
      pendingChunks: pending,
      ...stats,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not read the index.";
    return NextResponse.json({ ready: false, error: message }, { status: 500 });
  }
}
