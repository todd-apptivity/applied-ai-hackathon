import type { NextRequest } from "next/server";

import { providerCaseResponse } from "@/lib/matter/provider-view";

/**
 * GET /provider/{providerId}/cases/{matterId}
 *
 * One patient's case, as that provider may see it.
 */
export async function GET(
  request: NextRequest,
  context: RouteContext<"/provider/[providerId]/cases/[matterId]">,
) {
  const { providerId, matterId } = await context.params;
  return providerCaseResponse(providerId, matterId, request);
}
