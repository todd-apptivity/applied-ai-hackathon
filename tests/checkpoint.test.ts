/**
 * The review checkpoint.
 *
 * The property under test is the one that is easy to get wrong and invisible
 * when you do: opening the page must not consume the window you are about to
 * read. Everything here runs against a throwaway database file.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import {
  SESSION_IDLE_MS,
  getReviewState,
  markReviewed,
  openMatter,
  recordViewEvent,
  resolveWindow,
  viewEventCount,
} from "@/lib/changes/checkpoint";

/**
 * A scratch database. `databasePath()` reads the variable when the handle is
 * first opened, which is lazy, so setting it here — after the imports but
 * before any test body — is enough.
 */
const scratch = mkdtempSync(join(tmpdir(), "ninety-checkpoint-"));
process.env.RAG_DB_PATH = join(scratch, "test.db");

const MATTER = 4242;

/**
 * Every time is passed in explicitly rather than overridden through the
 * environment: `SESSION_IDLE_MS` is read once at module load, and a test that
 * depends on import order is a test that will fail for the wrong reason.
 */
const SAME_SITTING_MS = 500;
const NEW_SITTING_MS = SESSION_IDLE_MS * 4;

function plus(base: string, ms: number): string {
  return new Date(Date.parse(base) + ms).toISOString();
}

function minus(base: string, ms: number): string {
  return new Date(Date.parse(base) - ms).toISOString();
}

let viewerSeq = 0;
function viewer(): string {
  viewerSeq += 1;
  return `firm:test-${viewerSeq}`;
}

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("first visit", () => {
  it("has no baseline, so nothing is 'since' yet", () => {
    const id = viewer();
    const state = openMatter(id, MATTER);

    assert.equal(state.reviewedThrough, null);
    assert.ok(state.pendingThrough);

    const window = resolveWindow(state, { kind: "checkpoint" });
    assert.equal(window.kind, "first_visit");
    assert.equal(window.from, null);
    assert.equal(window.readOnly, false);
  });
});

describe("a single sitting", () => {
  it("returns the same window when the page is refreshed", () => {
    const id = viewer();
    const t0 = "2026-10-02T10:00:00.000Z";

    // A previous session, committed.
    openMatter(id, MATTER, minus(t0, NEW_SITTING_MS));
    openMatter(id, MATTER, t0);

    const first = resolveWindow(getReviewState(id, MATTER), { kind: "checkpoint" }, t0);
    // Refresh, refresh again — well inside the idle window.
    openMatter(id, MATTER, plus(t0, SAME_SITTING_MS));
    openMatter(id, MATTER, plus(t0, SAME_SITTING_MS * 2));
    const third = resolveWindow(
      getReviewState(id, MATTER),
      { kind: "checkpoint" },
      t0,
    );

    // This is the whole point: the baseline did not move, so the reader does
    // not get "nothing changed" about changes they were mid-way through.
    assert.equal(third.from, first.from);
    assert.equal(third.kind, "checkpoint");
  });

  it("extends the upper bound without moving the baseline", () => {
    const id = viewer();
    const t0 = "2026-10-02T10:00:00.000Z";
    openMatter(id, MATTER, minus(t0, NEW_SITTING_MS));
    openMatter(id, MATTER, t0);

    const before = getReviewState(id, MATTER)!;
    const later = plus(t0, SAME_SITTING_MS);
    const after = openMatter(id, MATTER, later);

    assert.equal(after.reviewedThrough, before.reviewedThrough);
    assert.equal(after.pendingThrough, later);
  });
});

describe("a new sitting", () => {
  it("commits the previous session's high-water mark", () => {
    const id = viewer();
    const first = "2026-10-02T10:00:00.000Z";
    openMatter(id, MATTER, first);
    const afterFirst = getReviewState(id, MATTER)!;

    // Past the idle gap: a new sitting.
    const second = plus(first, NEW_SITTING_MS);
    const state = openMatter(id, MATTER, second);

    assert.equal(state.reviewedThrough, afterFirst.pendingThrough);
    assert.equal(state.pendingThrough, second);

    const window = resolveWindow(state, { kind: "checkpoint" }, second);
    assert.equal(window.kind, "checkpoint");
    assert.equal(window.from, afterFirst.pendingThrough);
  });
});

describe("manual windows", () => {
  it("are read-only and leave the baseline byte-identical", () => {
    const id = viewer();
    const t0 = "2026-10-02T10:00:00.000Z";
    openMatter(id, MATTER, minus(t0, NEW_SITTING_MS));
    openMatter(id, MATTER, t0);

    const before = getReviewState(id, MATTER)!;

    const relative = resolveWindow(before, { kind: "relative", days: 7 }, t0);
    const absolute = resolveWindow(before, { kind: "absolute", since: "2026-09-01" }, t0);

    assert.equal(relative.readOnly, true);
    assert.equal(absolute.readOnly, true);

    // Resolving a window is pure; nothing was written.
    const after = getReviewState(id, MATTER)!;
    assert.deepEqual(after, before);
  });

  it("measures a relative window back from now", () => {
    const t0 = "2026-10-02T10:00:00.000Z";
    const window = resolveWindow(null, { kind: "relative", days: 7 }, t0);
    assert.equal(window.from, "2026-09-25T10:00:00.000Z");
    assert.equal(window.to, t0);
  });
});

describe("mark reviewed", () => {
  it("commits immediately so the next visit starts here", () => {
    const id = viewer();
    const t0 = "2026-10-02T10:00:00.000Z";
    openMatter(id, MATTER, t0);

    const state = markReviewed(id, MATTER, t0);
    assert.equal(state.reviewedThrough, t0);

    const window = resolveWindow(state, { kind: "checkpoint" }, t0);
    assert.equal(window.kind, "checkpoint");
    assert.equal(window.from, t0);
  });

  it("is idempotent", () => {
    const id = viewer();
    const t0 = "2026-10-02T10:00:00.000Z";
    const first = markReviewed(id, MATTER, t0);
    const second = markReviewed(id, MATTER, t0);
    assert.equal(second.reviewedThrough, first.reviewedThrough);
  });

  it("never moves the baseline backwards", () => {
    // A resubmitted form carrying a stale instant must not resurrect changes
    // the viewer already dismissed.
    const id = viewer();
    const late = "2026-10-02T10:00:00.000Z";
    const early = "2026-09-01T10:00:00.000Z";

    markReviewed(id, MATTER, late);
    const state = markReviewed(id, MATTER, early);
    assert.equal(state.reviewedThrough, late);
  });
});

describe("the view log", () => {
  it("records what the viewer was shown, not just when", () => {
    const id = viewer();
    const t0 = "2026-10-02T10:00:00.000Z";
    const state = openMatter(id, MATTER, t0);
    const window = resolveWindow(state, { kind: "checkpoint" }, t0);

    recordViewEvent({ viewerId: id, matterId: MATTER, event: "digest_viewed", window });
    assert.equal(viewEventCount(id, MATTER), 1);
  });
});

describe("timestamp format", () => {
  it("writes every compared instant as an ISO instant", () => {
    // The trap: `datetime('now')` yields "2026-10-02 18:55:27" while every
    // TypeScript write yields "2026-10-02T18:55:27.013Z", and ' ' (0x20) sorts
    // below 'T' (0x54). The window query is a string comparison, so mixing the
    // two formats would silently drop events rather than erroring.
    const id = viewer();
    const state = openMatter(id, MATTER);

    for (const value of [
      state.reviewedThrough,
      state.pendingThrough,
      state.sessionStartedAt,
      state.lastViewedAt,
    ]) {
      if (value === null) continue;
      assert.match(value, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/, `bad instant: ${value}`);
    }
  });
});
