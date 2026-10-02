import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { splitText } from "../src/lib/rag/chunking";
import { closeRagDb, getMeta, openRagDb } from "../src/lib/rag/db";
import { HashEmbedder, type Embedder, type InputType } from "../src/lib/rag/embeddings";
import { ingestMatter, type MatterSnapshot } from "../src/lib/rag/ingest";
import { parsePages } from "../src/lib/rag/ocr";
import { buildCaseRecords, type MatterParts } from "../src/lib/rag/records";
import { searchCaseFile, toFtsQuery } from "../src/lib/rag/search";
import { parseSearchCaseFileInput, runSearchCaseFile } from "../src/lib/rag/tool";
import { toLocalDate } from "../src/lib/rag/util";

const tempPaths: string[] = [];

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rag-test-"));
  const file = path.join(dir, "rag.sqlite");
  tempPaths.push(file);
  return { db: openRagDb(file), file };
}

afterEach(() => {
  for (const file of tempPaths.splice(0)) {
    closeRagDb(file);
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
});

/** Wraps an embedder and counts how many texts it was asked to embed. */
class CountingEmbedder implements Embedder {
  calls = 0;
  constructor(private readonly inner: Embedder = new HashEmbedder(64)) {}
  get id() {
    return this.inner.id;
  }
  async embed(texts: string[], inputType: InputType) {
    if (inputType === "document") this.calls += texts.length;
    return this.inner.embed(texts, inputType);
  }
}

function parts(matterId: string, overrides: Partial<MatterParts> = {}): MatterParts {
  return {
    matter: { id: matterId, description: "Rear-end collision on a highway", status: "Open", openDate: "2024-01-10" },
    customFields: [{ id: "cf1", name: "Policy Limits", value: "$50,000 per person" }],
    contacts: [{ id: "c1", name: "Pat Example", role: "Client", phones: ["555-0100"] }],
    notes: [
      { id: "n1", subject: "Intake", detail: "Client reports neck pain and a fractured wrist.", date: "2024-01-10" },
      { id: "n2", subject: "Status", detail: "Waiting on the orthopedist for an operative report.", date: "2024-06-01" },
    ],
    communications: [
      {
        id: "e1",
        type: "PhoneCommunication",
        subject: "Check-in call",
        body: "Spoke with the client about physical therapy attendance.",
        date: "2024-07-15",
        senders: ["Firm user"],
        receivers: ["Pat Example"],
      },
    ],
    tasks: [{ id: "t1", name: "Request records", status: "pending", dueAt: "2024-08-01" }],
    calendarEntries: [{ id: "k1", summary: "Deposition", startAt: "2024-09-10T14:00:00Z", endAt: "2024-09-10T16:00:00Z" }],
    expenses: [{ id: "x1", date: "2024-02-02", quantity: 1, price: 85, note: "Records reproduction fee" }],
    ...overrides,
  };
}

function snapshot(matterId: string, overrides: Partial<MatterParts> = {}): MatterSnapshot {
  return { matterId, records: buildCaseRecords(parts(matterId, overrides)), documents: [] };
}

describe("chunking", () => {
  it("keeps short text as one chunk", () => {
    assert.deepEqual(splitText("Hello world."), ["Hello world."]);
  });

  it("splits long text under the size limit with overlap", () => {
    const sentence = "The patient attended physical therapy and reported improvement. ";
    const text = Array.from({ length: 80 }, () => sentence).join("");
    const chunks = splitText(text, { maxChars: 400, overlapChars: 80 });
    assert.ok(chunks.length > 5);
    for (const chunk of chunks) assert.ok(chunk.length <= 400, `chunk too long: ${chunk.length}`);
    // Every word of the source survives chunking.
    const words = new Set(chunks.join(" ").split(/\s+/));
    for (const word of sentence.trim().split(/\s+/)) assert.ok(words.has(word));
  });

  it("hard-wraps text with no natural boundaries", () => {
    const chunks = splitText("x".repeat(2500), { maxChars: 1000 });
    assert.ok(chunks.every((c) => c.length <= 1000));
    assert.equal(chunks.join("").replace(/\s/g, "").length >= 2500, true);
  });
});

describe("dates", () => {
  it("converts UTC timestamps to the local calendar date", () => {
    assert.equal(toLocalDate("2024-03-08T03:00:00Z", "America/New_York"), "2024-03-07");
    assert.equal(toLocalDate("2024-03-08T10:00:00Z", "America/New_York"), "2024-03-08");
  });

  it("passes date-only values through unchanged", () => {
    assert.equal(toLocalDate("2023-04-23", "America/New_York"), "2023-04-23");
    assert.equal(toLocalDate(null), null);
    assert.equal(toLocalDate("not a date"), null);
  });
});

describe("keyword query building", () => {
  it("quotes terms so FTS operators in user text cannot break the query", () => {
    assert.equal(toFtsQuery('who said "NEAR" -x OR y*?'), '"said" OR "near" OR "x" OR "y"');
  });

  it("returns null when only stopwords remain", () => {
    assert.equal(toFtsQuery("what is the"), null);
  });
});

describe("OCR output parsing", () => {
  it("splits page-delimited transcription", () => {
    const pages = parsePages("=== PAGE 1 ===\nFirst page\n=== PAGE 2 ===\nSecond\npage\n");
    assert.equal(pages.get(1), "First page");
    assert.equal(pages.get(2), "Second\npage");
  });
});

describe("ingest and search", () => {
  it("indexes records and finds them with hybrid search", async () => {
    const { db } = tempDb();
    const embedder = new CountingEmbedder();
    const stats = await ingestMatter(db, snapshot("m1"), { embedder });
    assert.ok(stats.recordsAdded >= 8);
    assert.equal(stats.chunksEmbedded, embedder.calls);

    const results = await searchCaseFile(db, { matterId: "m1", query: "fractured wrist", embedder });
    assert.equal(results[0].sourceId, "n1");
    assert.deepEqual(results[0].matchedBy.sort(), ["keyword", "vector"]);
  });

  it("makes no embedding calls when nothing changed", async () => {
    const { db } = tempDb();
    const embedder = new CountingEmbedder();
    await ingestMatter(db, snapshot("m1"), { embedder });
    embedder.calls = 0;
    const stats = await ingestMatter(db, snapshot("m1"), { embedder });
    assert.equal(embedder.calls, 0);
    assert.equal(stats.recordsAdded + stats.recordsChanged, 0);
  });

  it("re-embeds only the record that changed and prunes deleted ones", async () => {
    const { db } = tempDb();
    const embedder = new CountingEmbedder();
    await ingestMatter(db, snapshot("m1"), { embedder });
    embedder.calls = 0;

    const changed = parts("m1").notes.map((n) =>
      n.id === "n2" ? { ...n, detail: "Operative report received from the orthopedist." } : n,
    );
    const stats = await ingestMatter(db, snapshot("m1", { notes: changed, expenses: [] }), { embedder });
    assert.equal(stats.recordsChanged, 1);
    assert.equal(stats.recordsRemoved, 1);
    assert.equal(embedder.calls, 1);

    const gone = await searchCaseFile(db, { matterId: "m1", query: "reproduction fee", embedder });
    assert.ok(gone.every((r) => r.sourceType !== "expense"));
    const counts = db
      .prepare("SELECT (SELECT count(*) FROM chunks) c, (SELECT count(*) FROM chunks_fts) f, (SELECT count(*) FROM chunk_vectors) v")
      .get() as { c: number; f: number; v: number };
    assert.equal(counts.c, counts.f);
    assert.equal(counts.c, counts.v);
  });

  it("never returns another matter's records", async () => {
    const { db } = tempDb();
    const embedder = new HashEmbedder(64);
    await ingestMatter(db, snapshot("m1"), { embedder });
    await ingestMatter(
      db,
      snapshot("m2", { notes: [{ id: "n9", subject: "Other", detail: "A fractured wrist in another case." }] }),
      { embedder },
    );
    const results = await searchCaseFile(db, { matterId: "m1", query: "fractured wrist", embedder, limit: 20 });
    assert.ok(results.length > 0);
    assert.ok(results.every((r) => r.matterId === "m1"));
  });

  it("filters by source type and date range", async () => {
    const { db } = tempDb();
    const embedder = new HashEmbedder(64);
    await ingestMatter(db, snapshot("m1"), { embedder });

    const notes = await searchCaseFile(db, {
      matterId: "m1",
      query: "orthopedist client",
      embedder,
      filters: { sourceTypes: ["note"] },
    });
    assert.ok(notes.length > 0 && notes.every((r) => r.sourceType === "note"));

    const dated = await searchCaseFile(db, {
      matterId: "m1",
      query: "client",
      embedder,
      limit: 20,
      filters: { dateFrom: "2024-06-01", dateTo: "2024-07-31" },
    });
    assert.ok(dated.length > 0);
    assert.ok(dated.every((r) => r.date !== null && r.date >= "2024-06-01" && r.date <= "2024-07-31"));
  });

  it("rebuilds vectors when the embedding model changes", async () => {
    const { db } = tempDb();
    await ingestMatter(db, snapshot("m1"), { embedder: new HashEmbedder(64) });
    const next = new CountingEmbedder(new HashEmbedder(128));
    await ingestMatter(db, snapshot("m1"), { embedder: next });
    assert.equal(getMeta(db, "embedding_model"), "hash:128");
    assert.ok(next.calls > 0);
    const results = await searchCaseFile(db, { matterId: "m1", query: "deposition", embedder: next });
    assert.ok(results.some((r) => r.sourceType === "calendar_entry"));
  });

  it("refuses to query with a different model than the index", async () => {
    const { db } = tempDb();
    await ingestMatter(db, snapshot("m1"), { embedder: new HashEmbedder(64) });
    await assert.rejects(
      searchCaseFile(db, { matterId: "m1", query: "x", embedder: new HashEmbedder(32) }),
      /Re-run ingestion/,
    );
  });

  it("falls back to keyword search without an embedder", async () => {
    const { db } = tempDb();
    await ingestMatter(db, snapshot("m1"), { embedder: new HashEmbedder(64) });
    const results = await searchCaseFile(db, { matterId: "m1", query: "Deposition" });
    assert.equal(results[0].sourceType, "calendar_entry");
    assert.deepEqual(results[0].matchedBy, ["keyword"]);
  });
});

describe("chat tool", () => {
  it("validates model input", () => {
    assert.throws(() => parseSearchCaseFileInput({}), /query/);
    assert.throws(() => parseSearchCaseFileInput({ query: "x", source_types: ["bogus"] }), /source_types/);
    assert.throws(() => parseSearchCaseFileInput({ query: "x", date_from: "May 1" }), /date_from/);
    assert.deepEqual(parseSearchCaseFileInput({ query: "x", limit: 3 }).limit, 3);
  });

  it("returns cited passages for the bound matter", async () => {
    const { db } = tempDb();
    const embedder = new HashEmbedder(64);
    await ingestMatter(db, snapshot("m1"), { embedder });
    const text = await runSearchCaseFile(db, embedder, "m1", { query: "physical therapy attendance" });
    assert.match(text, /<passage source_type="communication" source_id="e1"/);
    assert.match(text, /date="2024-07-15"/);
  });
});
