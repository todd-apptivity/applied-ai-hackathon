import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, before, describe, it, mock } from "node:test";
import { clioGetAll } from "../src/lib/clio/client";
import { setTokenStore, type TokenStore } from "../src/lib/clio/token-store";
import type { ClioTokens } from "../src/lib/clio/types";

class MemoryTokenStore implements TokenStore {
  constructor(private tokens: ClioTokens | null) {}
  async read() {
    return this.tokens;
  }
  async write(tokens: ClioTokens) {
    this.tokens = tokens;
  }
  async clear() {
    this.tokens = null;
  }
}

before(() => {
  process.env.CLIO_CLIENT_ID ??= "test-client";
  process.env.CLIO_CLIENT_SECRET ??= "test-secret";
  setTokenStore(
    new MemoryTokenStore({
      accessToken: "token",
      refreshToken: "refresh",
      tokenType: "bearer",
      expiresAt: Date.now() + 3_600_000,
      obtainedAt: Date.now(),
    }),
  );
});

afterEach(() => mock.restoreAll());

describe("Clio client", () => {
  it("follows pagination and only ever sends GET requests", async () => {
    const requests: Array<{ url: string; method: string; auth: string | null }> = [];
    mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
      requests.push({
        url,
        method: init.method ?? "GET",
        auth: new Headers(init.headers).get("authorization"),
      });
      const page = new URL(url).searchParams.get("page_token");
      const body = page
        ? { data: [{ id: 3 }], meta: { paging: {} } }
        : {
            data: [{ id: 1 }, { id: 2 }],
            meta: { paging: { next: "https://app.clio.com/api/v4/notes.json?page_token=abc" } },
          };
      return new Response(JSON.stringify(body), { status: 200 });
    });

    const notes = await clioGetAll<{ id: number }>("/notes.json", { params: { matter_id: 7 } });
    assert.deepEqual(notes.map((n) => n.id), [1, 2, 3]);
    assert.equal(requests.length, 2);
    assert.ok(requests.every((r) => r.method === "GET" && r.auth === "Bearer token"));
    assert.match(requests[0].url, /matter_id=7/);
    assert.match(requests[0].url, /limit=200/);
  });

  it("maps a matter bundle into case records and documents", async () => {
    const responses: Record<string, unknown> = {
      "/matters/42.json": {
        data: {
          id: 42,
          description: "Slip and fall",
          status: "Open",
          open_date: "2024-01-02",
          client: { id: 1, name: "Pat Example" },
          statute_of_limitations: { id: 8, name: "Limitations", due_at: "2026-01-02", status: "pending" },
          custom_field_values: [
            { id: "picklist-9", field_name: "Venue", value: "County court" },
          ],
        },
      },
      "/relationships.json": {
        data: [{ id: 5, description: "Treating physician", contact: { id: 2, name: "Dr. Example" } }],
      },
      "/notes.json": { data: [{ id: 11, subject: "Intake", detail: "Hip pain.", date: "2024-01-02" }] },
      "/communications.json": {
        data: [
          {
            id: 12,
            type: "PhoneCommunication",
            subject: "Check-in",
            body: "Called client.",
            date: "2024-02-01",
            senders: [{ id: 99, name: "Paralegal", type: "User" }],
            receivers: [{ id: 1, name: "Pat Example", type: "Contact" }],
          },
        ],
      },
      "/tasks.json": { data: [] },
      "/calendar_entries.json": { data: [] },
      "/activities.json": {
        data: [
          { id: 20, type: "ExpenseEntry", date: "2024-03-01", total: 50, note: "Filing fee" },
          { id: 21, type: "TimeEntry", date: "2024-03-01", quantity: 1, note: "Billed time" },
        ],
      },
      "/folders.json": { data: [] },
      "/documents.json": {
        data: [
          { id: 30, name: "report.pdf", parent: { id: 4, name: "Medical", type: "Folder" }, latest_document_version: { id: 7 } },
          { id: 31, name: "photo.jpg" },
        ],
      },
    };
    mock.method(globalThis, "fetch", async (url: string) => {
      const key = new URL(url).pathname.replace("/api/v4", "");
      const body = responses[key];
      if (!body) return new Response("not found", { status: 404 });
      return new Response(JSON.stringify({ meta: { paging: {} }, ...(body as object) }), { status: 200 });
    });

    const { fetchMatterSnapshot } = await import("../src/lib/clio/snapshot");
    const snapshot = await fetchMatterSnapshot(42);
    const byType = (type: string) => snapshot.records.filter((r) => r.sourceType === type);

    assert.equal(snapshot.matterId, "42");
    assert.match(byType("custom_field")[0].text, /Venue: County court/);
    assert.match(byType("matter")[0].text, /Statute of limitations date \(Clio field\): 2026-01-02\nStatute of limitations task status: pending/);
    assert.deepEqual(byType("contact").map((r) => r.title).sort(), ["Dr. Example (Treating physician)", "Pat Example (Client)"]);
    assert.match(byType("communication")[0].text, /From: Paralegal\nTo: Pat Example/);
    assert.equal(byType("expense").length, 1, "time entries are not expenses");
    assert.deepEqual(snapshot.documents.map((d) => [d.documentId, d.folder, d.versionKey]), [["30", "Medical", "clio:30:7"]]);
  });

  it("has no code path that writes Clio data", () => {
    // OAuth's token and deauthorize endpoints take POSTs; they manage the
    // connection and change no case data. Nothing else in the Clio layer may.
    const dir = path.join(process.cwd(), "src", "lib", "clio");
    for (const file of fs.readdirSync(dir)) {
      const source = fs.readFileSync(path.join(dir, file), "utf8");
      const writes = source.match(/method:\s*["'](POST|PUT|PATCH|DELETE)["']/gi) ?? [];
      if (file === "oauth.ts") {
        assert.ok(writes.every((w) => /POST/i.test(w)), "oauth.ts may only POST");
        assert.ok(writes.length <= 2, "oauth.ts should only POST to /oauth/token and /oauth/deauthorize");
      } else {
        assert.deepEqual(writes, [], file);
      }
    }
  });
});
