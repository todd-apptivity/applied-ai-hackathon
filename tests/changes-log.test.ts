/**
 * The change log and the changeset, end to end over a scratch database.
 *
 * The load-bearing test is the dull one: a sync that changed nothing must write
 * no revisions. If it writes one per source, every refresh looks like the whole
 * case changed, and the digest becomes confident noise.
 *
 * Synthetic sources rather than live Clio, so this runs in milliseconds and
 * fails for reasons in this repo.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { buildChangeset } from "@/lib/changes/changeset";
import type { ResolvedWindow } from "@/lib/changes/checkpoint";
import { ALL_KINDS } from "@/lib/permissions/policy";
import { getDb } from "@/lib/db/sqlite";
import { revisionHistoryStart } from "@/lib/rag/revisions";
import type { SourceRecord } from "@/lib/rag/sources";
import { upsertMatter, upsertSources } from "@/lib/rag/writer";

const scratch = mkdtempSync(join(tmpdir(), "ninety-log-"));
process.env.RAG_DB_PATH = join(scratch, "test.db");

const MATTER = 4242;

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function source(overrides: Partial<SourceRecord> = {}): SourceRecord {
  return {
    matterId: MATTER,
    kind: "task",
    clioId: "100",
    page: 0,
    title: "Request records",
    text: "Task: Request records\nStatus: incomplete\nDue: 2026-09-30",
    occurredAt: "2026-09-30",
    clioUpdatedAt: "2026-10-02T18:00:00.000Z",
    needsText: false,
    metadata: { status: "incomplete", dueAt: "2026-09-30" },
    ...overrides,
  };
}

function wholeWindow(): ResolvedWindow {
  return {
    from: null,
    to: "2099-01-01T00:00:00.000Z",
    kind: "checkpoint",
    label: "everything",
    readOnly: false,
  };
}

function revisionCount(): number {
  const row = getDb()
    .prepare("SELECT COUNT(*) AS n FROM source_revisions WHERE matter_id = ?")
    .get(MATTER) as unknown as { n: number };
  return row.n;
}

function scope() {
  return { matterId: MATTER, kinds: ALL_KINDS };
}

describe("the change log", () => {
  it("records a creation per new source", () => {
    upsertMatter({ id: MATTER, displayNumber: "00001-Test" });

    const stats = upsertSources(
      MATTER,
      [source(), source({ clioId: "101", title: "Second task" })],
      { prune: true },
    );

    assert.equal(stats.inserted, 2);
    assert.equal(stats.revisions, 2);
    assert.equal(revisionCount(), 2);
  });

  it("marks the point from which history is complete", () => {
    assert.ok(revisionHistoryStart(MATTER));
  });

  it("writes NOTHING when a sync re-sends identical sources", () => {
    const before = revisionCount();

    const stats = upsertSources(
      MATTER,
      [source(), source({ clioId: "101", title: "Second task" })],
      { prune: true },
    );

    assert.equal(stats.unchanged, 2);
    assert.equal(stats.inserted, 0);
    assert.equal(stats.updated, 0);
    assert.equal(stats.revisions, 0, "an unchanged sync must not touch the log");
    assert.equal(revisionCount(), before);
  });

  it("records an update and keeps the prior content", () => {
    upsertSources(
      MATTER,
      [
        source({
          text: "Task: Request records\nStatus: complete\nDue: 2026-09-30",
          metadata: { status: "complete", dueAt: "2026-09-30" },
        }),
        source({ clioId: "101", title: "Second task" }),
      ],
      { prune: true },
    );

    const row = getDb()
      .prepare(
        `SELECT change_type, prev_text, prev_metadata, new_metadata
           FROM source_revisions
          WHERE matter_id = ? AND clio_id = '100' AND change_type = 'updated'`,
      )
      .get(MATTER) as unknown as {
      change_type: string;
      prev_text: string;
      prev_metadata: string;
      new_metadata: string;
    };

    assert.equal(row.change_type, "updated");
    // The prior text is the only copy left once `sources` is overwritten.
    assert.match(row.prev_text, /Status: incomplete/);
    assert.match(row.prev_metadata, /"status":"incomplete"/);
    assert.match(row.new_metadata, /"status":"complete"/);
  });

  it("writes a tombstone when a full sync prunes a record", () => {
    const stats = upsertSources(
      MATTER,
      [
        source({
          text: "Task: Request records\nStatus: complete\nDue: 2026-09-30",
          metadata: { status: "complete", dueAt: "2026-09-30" },
        }),
      ],
      { prune: true },
    );

    assert.equal(stats.removed, 1);

    const row = getDb()
      .prepare(
        `SELECT change_type, title, prev_text FROM source_revisions
          WHERE matter_id = ? AND clio_id = '101' AND change_type = 'deleted'`,
      )
      .get(MATTER) as unknown as { title: string; prev_text: string };

    // The tombstone outlives the row, so it has to carry the last text we held.
    assert.equal(row.title, "Second task");
    assert.ok(row.prev_text.length > 0);
  });

  it("does not prune on an incremental sync", () => {
    // An incremental response omits unchanged records, so absence is not
    // removal — which is also why deletions only surface on a full pull.
    const stats = upsertSources(MATTER, [], { prune: false });
    assert.equal(stats.removed, 0);
  });

  it("can write the index without touching the log", () => {
    const before = revisionCount();
    upsertSources(
      MATTER,
      [source({ clioId: "102", title: "Unlogged", text: "Task: Unlogged" })],
      { prune: false, recordRevisions: false },
    );
    assert.equal(revisionCount(), before);
  });
});

describe("the changeset", () => {
  it("classifies the completion out of the log", () => {
    const changeset = buildChangeset(scope(), wholeWindow());
    const completion = changeset.events.find((event) => event.clioId === "100");

    assert.ok(completion, "the completed task must appear");
    // Created and then updated inside one window reads as new, not as an edit.
    assert.equal(completion.type, "task_created");
    assert.equal(completion.ref, "task:100");
  });

  it("suppresses a record created and removed inside one window", () => {
    const changeset = buildChangeset(scope(), wholeWindow());
    assert.equal(
      changeset.events.some((event) => event.clioId === "101"),
      false,
      "a record that came and went never existed for this viewer",
    );
  });

  it("returns nothing for a window after everything happened", () => {
    const changeset = buildChangeset(scope(), {
      ...wholeWindow(),
      from: "2098-01-01T00:00:00.000Z",
    });
    assert.deepEqual(changeset.events, []);
    assert.equal(changeset.counts.total, 0);
  });

  it("returns an empty changeset when no kind is permitted", () => {
    // An empty allowance must not be read as "no filter".
    const changeset = buildChangeset({ matterId: MATTER, kinds: [] }, wholeWindow());
    assert.deepEqual(changeset.events, []);
  });

  it("is identical for identical data, so the cache key is stable", () => {
    const a = buildChangeset(scope(), wholeWindow());
    const b = buildChangeset(scope(), wholeWindow());
    assert.equal(a.fingerprint, b.fingerprint);
  });

  it("ignores the window's end in the fingerprint, so a refresh is a cache hit", () => {
    // `to` moves to "now" on every request; including it would force a fresh
    // model call for an unchanged matter.
    const a = buildChangeset(scope(), wholeWindow());
    const b = buildChangeset(scope(), {
      ...wholeWindow(),
      to: "2099-06-01T00:00:00.000Z",
    });
    assert.equal(a.fingerprint, b.fingerprint);
  });

  it("changes the fingerprint when the permitted kinds change", () => {
    const all = buildChangeset(scope(), wholeWindow());
    const narrow = buildChangeset(
      { matterId: MATTER, kinds: ["task"] },
      wholeWindow(),
    );
    assert.notEqual(all.fingerprint, narrow.fingerprint);
  });
});

describe("timestamp format", () => {
  it("writes every compared instant as an ISO instant", () => {
    // ' ' (0x20) sorts below 'T' (0x54), so a `datetime('now')` default on a
    // compared column would make the window query silently drop events.
    const rows = getDb()
      .prepare("SELECT observed_at FROM source_revisions WHERE matter_id = ?")
      .all(MATTER) as unknown as { observed_at: string }[];

    assert.ok(rows.length > 0);
    for (const row of rows) {
      assert.match(row.observed_at, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
    }
  });
});
