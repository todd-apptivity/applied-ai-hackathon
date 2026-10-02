import { NextResponse } from "next/server";
import { ClioNotConnectedError, isConnected } from "@/lib/clio/client";
import { getClioConfig, isClioConfigured } from "@/lib/clio/config";
import { getCurrentUser } from "@/lib/clio/resources";

/** Connection health: GET /api/clio/status */
export async function GET() {
  if (!isClioConfigured()) {
    return NextResponse.json({ configured: false, connected: false });
  }

  const config = getClioConfig();
  const base = { configured: true, region: config.region, host: config.host };

  if (!(await isConnected())) {
    return NextResponse.json({ ...base, connected: false });
  }

  try {
    const user = await getCurrentUser();
    return NextResponse.json({
      ...base,
      connected: true,
      user: { id: user.id, name: user.name, email: user.email },
      account: user.account ?? null,
    });
  } catch (error) {
    if (error instanceof ClioNotConnectedError) {
      return NextResponse.json({ ...base, connected: false });
    }
    return NextResponse.json(
      { ...base, connected: false, error: (error as Error).message },
      { status: 502 },
    );
  }
}
