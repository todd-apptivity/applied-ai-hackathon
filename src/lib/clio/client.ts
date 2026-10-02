/**
 * Read-only Clio Manage API v4 client.
 *
 * This client can only issue GET requests. There is deliberately no method
 * for POST, PATCH, PUT, or DELETE: Clio is an input to this app, never an
 * output. Use an OAuth app that requests read scopes only.
 */

export interface ClioClientOptions {
  accessToken?: string;
  /** Region base, e.g. https://app.clio.com (US) or https://eu.app.clio.com. */
  baseUrl?: string;
}

interface ClioPage<T> {
  data: T[];
  meta?: { paging?: { next?: string } };
}

export class ClioClient {
  private readonly token: string;
  private readonly apiBase: string;
  private readonly origin: string;

  constructor(options: ClioClientOptions = {}) {
    const token = options.accessToken ?? process.env.CLIO_ACCESS_TOKEN;
    if (!token) throw new Error("CLIO_ACCESS_TOKEN is not set");
    this.token = token;
    const base = (options.baseUrl ?? process.env.CLIO_BASE_URL ?? "https://app.clio.com").replace(/\/+$/, "");
    this.origin = new URL(base).origin;
    this.apiBase = `${base}/api/v4`;
  }

  /** GET a single resource, returning its `data` object. */
  async getOne<T>(path: string, params: Record<string, string> = {}): Promise<T> {
    const json = (await this.request(this.url(path, params))) as { data: T };
    return json.data;
  }

  /** GET every page of a collection by following meta.paging.next. */
  async getAll<T>(path: string, params: Record<string, string> = {}): Promise<T[]> {
    const out: T[] = [];
    let next: string | undefined = this.url(path, { limit: "200", ...params });
    while (next) {
      const page = (await this.request(next)) as ClioPage<T>;
      out.push(...page.data);
      next = page.meta?.paging?.next;
    }
    return out;
  }

  /** Downloads a document's latest version as bytes. */
  async download(documentId: string | number): Promise<Uint8Array> {
    const res = await this.fetchWithRetry(this.url(`/documents/${documentId}/download`));
    return new Uint8Array(await res.arrayBuffer());
  }

  private url(path: string, params: Record<string, string> = {}): string {
    const url = new URL(`${this.apiBase}${path.startsWith("/") ? path : `/${path}`}`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    return url.toString();
  }

  private async request(url: string): Promise<unknown> {
    const res = await this.fetchWithRetry(url);
    return res.json();
  }

  private async fetchWithRetry(url: string): Promise<Response> {
    // Never send the token anywhere except Clio's own API.
    if (new URL(url).origin !== this.origin) throw new Error(`Refusing to call non-Clio URL: ${url}`);
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${this.token}`, Accept: "application/json" },
        redirect: "follow",
      });
      if (res.ok) return res;
      if ((res.status === 429 || res.status >= 500) && attempt < 5) {
        const retryAfter = Number(res.headers.get("retry-after"));
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt);
        continue;
      }
      const body = await res.text();
      throw new Error(`Clio GET ${url} failed (${res.status}): ${body.slice(0, 500)}`);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
