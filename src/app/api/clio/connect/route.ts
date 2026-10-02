import { NextResponse, type NextRequest } from "next/server";
import { isClioConfigured } from "@/lib/clio/config";
import {
  OAUTH_STATE_COOKIE,
  buildAuthorizeUrl,
  createOAuthState,
} from "@/lib/clio/oauth";

/** Starts the Clio OAuth flow: GET /api/clio/connect */
export async function GET(request: NextRequest) {
  if (!isClioConfigured()) {
    return NextResponse.json(
      {
        error: "clio_not_configured",
        message:
          "Set CLIO_CLIENT_ID and CLIO_CLIENT_SECRET in .env.local (see .env.example).",
      },
      { status: 500 },
    );
  }

  const state = createOAuthState();
  const response = NextResponse.redirect(buildAuthorizeUrl(state));

  response.cookies.set(OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: "lax",
    secure: request.nextUrl.protocol === "https:",
    path: "/",
    maxAge: 600,
  });

  return response;
}
