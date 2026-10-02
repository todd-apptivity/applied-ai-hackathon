import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { loadClioExport } from "../src/lib/rag/sources/clio-export";

const EXPORT = path.join(process.cwd(), "reference-material", "sapini-clio-data.json");

describe("Clio export loader (hackathon matter)", { skip: !fs.existsSync(EXPORT) }, () => {
  const snapshot = loadClioExport({
    file: EXPORT,
    matterId: "test-matter",
    documentsDir: path.join(process.cwd(), "reference-material"),
  });
  const count = (type: string) => snapshot.records.filter((r) => r.sourceType === type).length;

  it("maps every record in the export", () => {
    assert.equal(count("matter"), 1);
    assert.equal(count("custom_field"), 16);
    assert.equal(count("note"), 42);
    assert.equal(count("communication"), 69);
    assert.equal(count("task"), 14);
    assert.equal(count("calendar_entry"), 17);
    assert.equal(count("expense"), 5);
    assert.equal(snapshot.documents.length, 15);
  });

  it("resolves contact placeholders to names", () => {
    const call = snapshot.records.find(
      (r) => r.sourceType === "communication" && r.date === "2026-09-27",
    );
    assert.ok(call, "expected the 2026-09-27 client call");
    assert.match(call.text, /Type: Phone call/);
    assert.match(call.text, /To: Justin Sapini/);
    assert.doesNotMatch(call.text, /\{\{/);
  });

  it("totals expenses from quantity and price", () => {
    const total = snapshot.records
      .filter((r) => r.sourceType === "expense")
      .reduce((sum, r) => sum + Number(r.metadata?.amount ?? 0), 0);
    assert.equal(total, 1410);
  });
});
