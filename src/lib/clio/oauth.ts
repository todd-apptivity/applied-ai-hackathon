/**
 * Clio OAuth 2.0 authorization-code flow.
 *
 * Clio has no `scope` request parameter — permissions are granted on the
 * developer app itself (see REQUIRED_READ_PERMISSIONS in config.ts). Access
 * tokens are short-lived; the refresh token does not expire unless the user
 * revokes the app.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import { getClioConfig } from "./config";
import { getTokenStore } from "./token-store";
import type { ClioTokens } from "./types";

export const OAUTH_STATE_COOKIE = "clio_oauth_state";

interface ClioTokenResponse {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
}

export function createOAuthState(): string {
  return randomBytes(32).toString("base64url");
}

export function verifyOAuthState(
  expected: string | undefined,
  received: string | null,
): boolean {
  if (!expected || !received) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(received);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function buildAuthorizeUrl(state: string): string {
  const config = getClioConfig();
  const url = new URL(config.authorizeUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("state", state);
  // Bounce back to us with ?error=access_denied instead of dead-ending in Clio.
  url.searchParams.set("redirect_on_decline", "true");
  return url.toString();
}

function toTokens(payload: ClioTokenResponse, fallbackRefresh?: string): ClioTokens {
  const now = Date.now();
  return {
    accessToken: payload.access_token,
    // Clio returns a fresh refresh token on refresh, but tolerate omission.
    refreshToken: payload.refresh_token ?? fallbackRefresh ?? "",
    tokenType: payload.token_type ?? "bearer",
    expiresAt: now + payload.expires_in * 1000,
    obtainedAt: now,
  };
}

async function postTokenRequest(
  body: Record<string, string>,
  fallbackRefresh?: string,
): Promise<ClioTokens> {
  const config = getClioConfig();
  const response = await fetch(config.tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      ...body,
    }),
    cache: "no-store",
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `Clio token request failed (${response.status} ${response.statusText}): ${text.slice(0, 500)}`,
    );
  }

  return toTokens(JSON.parse(text) as ClioTokenResponse, fallbackRefresh);
}

/** Exchange the `code` from the callback for tokens and persist them. */
export async function exchangeCodeForTokens(code: string): Promise<ClioTokens> {
  const config = getClioConfig();
  const tokens = await postTokenRequest({
    grant_type: "authorization_code",
    code,
    redirect_uri: config.redirectUri,
  });
  await getTokenStore().write(tokens);
  return tokens;
}

/** Trade the refresh token for a new access token and persist the result. */
export async function refreshTokens(refreshToken: string): Promise<ClioTokens> {
  const tokens = await postTokenRequest(
    { grant_type: "refresh_token", refresh_token: refreshToken },
    refreshToken,
  );
  await getTokenStore().write(tokens);
  return tokens;
}

/** Revoke at Clio (best effort) and drop the local tokens. */
export async function disconnect(): Promise<void> {
  const store = getTokenStore();
  const tokens = await store.read();
  if (tokens) {
    const config = getClioConfig();
    try {
      await fetch(`${config.host}/oauth/deauthorize`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: tokens.accessToken }),
        cache: "no-store",
      });
    } catch {
      // Local tokens still get cleared below; Clio-side revocation is a courtesy.
    }
  }
  await store.clear();
}
