import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, it, mock } from "node:test";
import { ClioClient } from "../src/lib/clio/client";

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

    const client = new ClioClient({ accessToken: "token" });
    const notes = await client.getAll<{ id: number }>("/notes.json", { matter_id: "7" });
    assert.deepEqual(notes.map((n) => n.id), [1, 2, 3]);
    assert.equal(requests.length, 2);
    assert.ok(requests.every((r) => r.method === "GET" && r.auth === "Bearer token"));
    assert.match(requests[0].url, /matter_id=7/);
    assert.match(requests[0].url, /limit=200/);
  });

  it("will not send the token to a host other than Clio", async () => {
    mock.method(globalThis, "fetch", async () =>
      new Response(JSON.stringify({ data: [], meta: { paging: { next: "https://evil.example/steal" } } })),
    );
    const client = new ClioClient({ accessToken: "token" });
    await assert.rejects(client.getAll("/notes.json"), /non-Clio URL/);
  });

  it("has no code path that writes to Clio", () => {
    const dir = path.join(process.cwd(), "src", "lib", "clio");
    for (const file of fs.readdirSync(dir)) {
      const source = fs.readFileSync(path.join(dir, file), "utf8");
      assert.doesNotMatch(source, /method:\s*["'](POST|PUT|PATCH|DELETE)["']/i, file);
    }
  });
});
