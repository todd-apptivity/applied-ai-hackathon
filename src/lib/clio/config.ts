/**
 * Clio Manage connection config.
 *
 * Read-only by design: see `client.ts`. No value in this file points at a
 * write endpoint, and the OAuth app itself is configured with read
 * permissions only (Clio sets permissions on the developer app, not via a
 * `scope` request parameter).
 */

export type ClioRegion = "us" | "eu" | "ca" | "au";

const REGION_HOSTS: Record<ClioRegion, string> = {
  us: "https://app.clio.com",
  eu: "https://eu.clio.com",
  ca: "https://ca.clio.com",
  au: "https://au.clio.com",
};

/**
 * Permissions the Clio developer app must be granted. Clio has no `scope`
 * request parameter, so this list is documentation + a checklist for the
 * app settings page, not something sent on the wire.
 */
export const REQUIRED_READ_PERMISSIONS = [
  "Users (read)",
  "Practice Areas (read)",
  "Contacts (read)",
  "Matters (read)",
  "Custom Fields (read)",
  "Documents (read)",
  "Notes (read)",
  "Communications (read)",
  "Tasks (read)",
  "Calendars (read)",
  "Activities (read)",
] as const;

export interface ClioConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  region: ClioRegion;
  /** e.g. https://app.clio.com */
  host: string;
  /** e.g. https://app.clio.com/api/v4 */
  apiBase: string;
  authorizeUrl: string;
  tokenUrl: string;
  /** Where the OAuth callback sends the browser once tokens are stored. */
  postConnectPath: string;
  /** Token filename, resolved inside the gitignored `.clio/` directory. */
  tokenFile: string;
}

export class ClioConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClioConfigError";
  }
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new ClioConfigError(
      `Missing ${name}. Copy .env.example to .env.local and fill in your Clio app credentials.`,
    );
  }
  return value;
}

function parseRegion(value: string | undefined): ClioRegion {
  const region = (value ?? "us").toLowerCase();
  if (region in REGION_HOSTS) return region as ClioRegion;
  throw new ClioConfigError(
    `CLIO_REGION must be one of ${Object.keys(REGION_HOSTS).join(", ")} (got "${value}").`,
  );
}

export function getClioConfig(): ClioConfig {
  const region = parseRegion(process.env.CLIO_REGION);
  const host = REGION_HOSTS[region];

  return {
    clientId: required("CLIO_CLIENT_ID"),
    clientSecret: required("CLIO_CLIENT_SECRET"),
    redirectUri:
      process.env.CLIO_REDIRECT_URI ?? "http://localhost:3000/api/clio/callback",
    region,
    host,
    apiBase: `${host}/api/v4`,
    authorizeUrl: `${host}/oauth/authorize`,
    tokenUrl: `${host}/oauth/token`,
    postConnectPath: process.env.CLIO_POST_CONNECT_PATH ?? "/clio",
    tokenFile: process.env.CLIO_TOKEN_FILE ?? "tokens.json",
  };
}

/** True when credentials are present, without throwing. */
export function isClioConfigured(): boolean {
  return Boolean(process.env.CLIO_CLIENT_ID && process.env.CLIO_CLIENT_SECRET);
}

/** Clio allows 600 requests per minute per token. */
export const CLIO_RATE_LIMIT_PER_MINUTE = 600;

/** Max page size Clio accepts on list endpoints. */
export const CLIO_MAX_PAGE_SIZE = 200;
