import { NextResponse, type NextRequest } from "next/server";
import { getClioConfig } from "@/lib/clio/config";
import {
  OAUTH_STATE_COOKIE,
  exchangeCodeForTokens,
  verifyOAuthState,
} from "@/lib/clio/oauth";

/** OAuth redirect target: GET /api/clio/callback?code=...&state=... */
export async function GET(request: NextRequest) {
  const config = getClioConfig();
  const params = request.nextUrl.searchParams;
  const done = (search: string) =>
    NextResponse.redirect(new URL(`${config.postConnectPath}${search}`, request.url));

  const error = params.get("error");
  if (error) {
    return done(`?clio_error=${encodeURIComponent(error)}`);
  }

  const expected = request.cookies.get(OAUTH_STATE_COOKIE)?.value;
  if (!verifyOAuthState(expected, params.get("state"))) {
    return done("?clio_error=state_mismatch");
  }

  const code = params.get("code");
  if (!code) {
    return done("?clio_error=missing_code");
  }

  try {
    await exchangeCodeForTokens(code);
  } catch (cause) {
    console.error("Clio token exchange failed", cause);
    return done("?clio_error=token_exchange_failed");
  }

  const response = done("?clio=connected");
  response.cookies.delete(OAUTH_STATE_COOKIE);
  return response;
}
