/**
 * Read-only HTTP client for the Clio Manage API v4.
 *
 * READ-ONLY GUARANTEE
 * -------------------
 * This module is the only place in the codebase that talks to the Clio API,
 * and it sends `GET` and nothing else. `assertReadOnly` throws on any other
 * verb, so a write would fail loudly rather than reach Clio. Everything
 * Ninety creates lives in its own database.
 *
 * Also handles: access-token refresh (single-flight), the 600 req/min
 * account rate limit, 429 `Retry-After`, 5xx backoff, and `meta.paging.next`
 * pagination.
 */

import {
  CLIO_MAX_PAGE_SIZE,
  CLIO_RATE_LIMIT_PER_MINUTE,
  getClioConfig,
} from "./config";
import { refreshTokens } from "./oauth";
import { getTokenStore } from "./token-store";
import type { ClioListResponse, ClioSingleResponse, ClioTokens } from "./types";

export class ClioNotConnectedError extends Error {
  constructor() {
    super("Clio is not connected. Visit /api/clio/connect to authorize.");
    this.name = "ClioNotConnectedError";
  }
}

export class ClioApiError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    readonly body: string,
  ) {
    super(`Clio API ${status} for ${url}: ${body.slice(0, 500)}`);
    this.name = "ClioApiError";
  }
}

function assertReadOnly(method: string): void {
  if (method.toUpperCase() !== "GET") {
    throw new Error(
      `Clio is input only: refusing a ${method} request. Write to Ninety's own database instead.`,
    );
  }
}

/** Sliding-window limiter, sized under Clio's 600 requests/minute per token. */
class RateLimiter {
  private readonly hits: number[] = [];
  private inFlight = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly maxConcurrent: number,
  ) {}

  async acquire(): Promise<() => void> {
    while (true) {
      const now = Date.now();
      while (this.hits.length > 0 && now - this.hits[0] >= this.windowMs) {
        this.hits.shift();
      }
      if (this.inFlight < this.maxConcurrent && this.hits.length < this.limit) {
        this.inFlight += 1;
        this.hits.push(now);
        let released = false;
        return () => {
          if (released) return;
          released = true;
          this.inFlight -= 1;
          this.waiters.shift()?.();
        };
      }
      const oldest = this.hits[0];
      const windowWait =
        this.hits.length >= this.limit ? this.windowMs - (now - oldest) : 0;
      await Promise.race([
        new Promise<void>((resolve) => this.waiters.push(resolve)),
        sleep(Math.max(windowWait, 25)),
      ]);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 90% of the documented ceiling leaves headroom for anything else on the token.
const limiter = new RateLimiter(
  Math.floor(CLIO_RATE_LIMIT_PER_MINUTE * 0.9),
  60_000,
  8,
);

const REFRESH_SKEW_MS = 60_000;
let refreshInFlight: Promise<ClioTokens> | null = null;

async function currentTokens(): Promise<ClioTokens> {
  const tokens = await getTokenStore().read();
  if (!tokens?.accessToken) throw new ClioNotConnectedError();
  return tokens;
}

async function accessToken(force = false): Promise<string> {
  const tokens = await currentTokens();
  const stale = tokens.expiresAt - REFRESH_SKEW_MS <= Date.now();
  if (!force && !stale) return tokens.accessToken;

  refreshInFlight ??= refreshTokens(tokens.refreshToken).finally(() => {
    refreshInFlight = null;
  });
  return (await refreshInFlight).accessToken;
}

export interface ClioRequestOptions {
  /** Query parameters. Arrays are repeated; undefined/null are dropped. */
  params?: Record<string, string | number | boolean | undefined | null | string[]>;
  signal?: AbortSignal;
  /** Number of retries for 429 and 5xx responses. */
  retries?: number;
  /** Follow Clio's redirect to storage (used by document downloads). */
  redirect?: RequestRedirect;
}

function buildUrl(pathOrUrl: string, params?: ClioRequestOptions["params"]): string {
  const { apiBase } = getClioConfig();
  const url = pathOrUrl.startsWith("http")
    ? new URL(pathOrUrl)
    : new URL(`${apiBase}${pathOrUrl.startsWith("/") ? "" : "/"}${pathOrUrl}`);

  for (const [key, value] of Object.entries(params ?? {})) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) url.searchParams.append(`${key}[]`, item);
    } else {
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

/** One authenticated GET against Clio, with retries and token refresh. */
export async function clioFetch(
  pathOrUrl: string,
  options: ClioRequestOptions = {},
): Promise<Response> {
  assertReadOnly("GET");

  const url = buildUrl(pathOrUrl, options.params);
  const maxRetries = options.retries ?? 4;
  let refreshed = false;

  for (let attempt = 0; ; attempt += 1) {
    const release = await limiter.acquire();
    let response: Response;
    try {
      response = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${await accessToken()}`,
          Accept: "application/json",
        },
        signal: options.signal,
        redirect: options.redirect ?? "follow",
        cache: "no-store",
      });
    } finally {
      release();
    }

    if (response.status === 401 && !refreshed) {
      refreshed = true;
      await accessToken(true);
      continue;
    }

    const retryable = response.status === 429 || response.status >= 500;
    if (retryable && attempt < maxRetries) {
      const retryAfter = Number(response.headers.get("retry-after"));
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : Math.min(2 ** attempt * 500, 15_000);
      await sleep(waitMs);
      continue;
    }

    if (!response.ok) {
      throw new ClioApiError(response.status, url, await response.text());
    }

    return response;
  }
}

/** GET a single record: `{ data: ... }` unwrapped. */
export async function clioGet<T>(
  pathOrUrl: string,
  options: ClioRequestOptions = {},
): Promise<T> {
  const response = await clioFetch(pathOrUrl, options);
  const payload = (await response.json()) as ClioSingleResponse<T>;
  return payload.data;
}

/** GET one page of a list endpoint, with the paging cursor. */
export async function clioGetPage<T>(
  pathOrUrl: string,
  options: ClioRequestOptions = {},
): Promise<{ data: T[]; next?: string; records?: number }> {
  const response = await clioFetch(pathOrUrl, options);
  const payload = (await response.json()) as ClioListResponse<T>;
  return {
    data: payload.data ?? [],
    next: payload.meta?.paging?.next,
    records: payload.meta?.records,
  };
}

/** Walk every page of a list endpoint. */
export async function* clioPaginate<T>(
  path: string,
  options: ClioRequestOptions = {},
): AsyncGenerator<T, void, undefined> {
  let url: string | undefined = buildUrl(path, {
    limit: CLIO_MAX_PAGE_SIZE,
    ...options.params,
  });

  while (url) {
    const page: { data: T[]; next?: string } = await clioGetPage<T>(url, {
      signal: options.signal,
      retries: options.retries,
    });
    for (const item of page.data) yield item;
    url = page.next;
  }
}

/** Collect every page of a list endpoint into one array. */
export async function clioGetAll<T>(
  path: string,
  options: ClioRequestOptions = {},
): Promise<T[]> {
  const all: T[] = [];
  for await (const item of clioPaginate<T>(path, options)) all.push(item);
  return all;
}

/** True when tokens exist locally — does not prove Clio still accepts them. */
export async function isConnected(): Promise<boolean> {
  const tokens = await getTokenStore().read();
  return Boolean(tokens?.accessToken);
}
