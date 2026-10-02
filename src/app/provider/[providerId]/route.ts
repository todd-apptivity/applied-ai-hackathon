import type { NextRequest } from "next/server";

import { providerHomeResponse } from "@/lib/matter/provider-view";

/**
 * GET /provider/{providerId}
 *
 * A treating provider's own page: every case shared with their office. It has
 * none of the firm's navigation, because it is not a page for the firm.
 */
export async function GET(request: NextRequest, context: RouteContext<"/provider/[providerId]">) {
  const { providerId } = await context.params;
  return providerHomeResponse(providerId, request);
}
