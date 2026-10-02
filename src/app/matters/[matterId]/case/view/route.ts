import type { NextRequest } from "next/server";

import { lawyerViewResponse } from "@/lib/matter/respond";

/**
 * GET /matters/{matterId}/case/view?device=desktop|phone
 *
 * The case view as a self-contained document, read live from Clio. The case
 * page frames this and picks the device from the width of the window.
 */
export async function GET(
  request: NextRequest,
  context: RouteContext<"/matters/[matterId]/case/view">,
) {
  const { matterId } = await context.params;
  const device = request.nextUrl.searchParams.get("device") === "phone" ? "phone" : "desktop";
  return lawyerViewResponse(device, matterId, request);
}
