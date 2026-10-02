import { NextResponse, type NextRequest } from "next/server";
import { clioErrorResponse } from "@/lib/clio/http-errors";
import { listMatters } from "@/lib/clio/resources";

/** Matter picker feed: GET /api/clio/matters?status=Open&query=... */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;

  try {
    const matters = await listMatters({
      status: params.get("status") ?? undefined,
      query: params.get("query") ?? undefined,
      updatedSince: params.get("updated_since") ?? undefined,
    });

    return NextResponse.json({
      count: matters.length,
      matters: matters.map((matter) => ({
        id: matter.id,
        displayNumber: matter.display_number,
        description: matter.description,
        status: matter.status,
        stage: matter.matter_stage?.name ?? null,
        practiceArea: matter.practice_area?.name ?? null,
        client: matter.client
          ? { id: matter.client.id, name: matter.client.name }
          : null,
        updatedAt: matter.updated_at,
      })),
    });
  } catch (error) {
    return clioErrorResponse(error);
  }
}
