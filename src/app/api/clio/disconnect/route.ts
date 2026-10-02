import { NextResponse } from "next/server";
import { disconnect } from "@/lib/clio/oauth";

/**
 * Drops the stored tokens: POST /api/clio/disconnect
 *
 * The POST is to Clio's OAuth deauthorize endpoint, which revokes our own
 * token. It touches no matter data; the API v4 surface stays read-only.
 */
export async function POST() {
  await disconnect();
  return NextResponse.json({ connected: false });
}
