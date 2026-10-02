/**
 * The permission filter, applied to change events.
 *
 * The PRD's target — "provider portal fields outside the attorney's approved
 * set: 0" — has to hold for the digest as well as for search, and a change
 * event has a wider surface than a passage: the excerpt and every delta's
 * before and after value also reach the model.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { filterChangeEvents, withheldCount } from "@/lib/permissions/policy";
import type { FirmPrincipal, ProviderPrincipal } from "@/lib/permissions/types";
import type { ChangeEvent, FieldDelta } from "@/lib/changes/types";

const MATTER = 4242;

const firm: FirmPrincipal = { kind: "firm", userId: "u1", name: "Firm staff" };

function provider(overrides: Partial<ProviderPrincipal> = {}): ProviderPrincipal {
  return {
    kind: "provider",
    providerId: "p1",
    name: "Treating provider",
    matterId: MATTER,
    shareId: "s1",
    approvedKinds: ["matter", "task", "calendar_entry", "document", "document_page"],
    releasedTopics: [],
    ...overrides,
  };
}

function event(overrides: Partial<ChangeEvent> = {}): ChangeEvent {
  return {
    ref: "task:100",
    type: "task_completed",
    kind: "task",
    clioId: "100",
    page: null,
    title: "Request records",
    summary: "Task completed: Request records",
    occurredAt: "2026-10-01",
    observedAt: "2026-10-02T18:00:00.000Z",
    clioUpdatedAt: null,
    backdated: false,
    deltas: [],
    excerpt: null,
    clioUrl: null,
    weight: 80,
    ...overrides,
  };
}

const PRIVILEGED_KINDS = ["note", "communication", "activity", "custom_field", "contact"];

describe("firm staff", () => {
  it("see every change, withholding nothing", () => {
    const events = [event(), event({ kind: "note", ref: "note:1" })];
    const { allowed, withheld } = filterChangeEvents(firm, events);
    assert.equal(allowed.length, 2);
    assert.equal(withheldCount(withheld), 0);
  });
});

describe("a provider", () => {
  it("never sees a privileged kind, and the drop is counted", () => {
    const events = PRIVILEGED_KINDS.map((kind) =>
      event({ kind, ref: `${kind}:1` }),
    );
    const { allowed, withheld } = filterChangeEvents(provider(), events);

    assert.deepEqual(allowed, []);
    assert.equal(withheld.byKind, PRIVILEGED_KINDS.length);
  });

  it("sees an ordinary task", () => {
    const { allowed } = filterChangeEvents(provider(), [event()]);
    assert.equal(allowed.length, 1);
  });

  it("reports no privileged kind in the allowed set, whatever comes in", () => {
    const events = [
      ...PRIVILEGED_KINDS.map((kind) => event({ kind, ref: `${kind}:1` })),
      event(),
      event({ kind: "calendar_entry", ref: "calendar_entry:5" }),
      event({ kind: "document", ref: "document:9" }),
    ];
    const { allowed } = filterChangeEvents(provider(), events);
    for (const item of allowed) {
      assert.equal(
        PRIVILEGED_KINDS.includes(item.kind),
        false,
        `${item.kind} must not reach a provider`,
      );
    }
  });
});

describe("the wider screening surface", () => {
  it("screens the excerpt", () => {
    const { allowed, withheld } = filterChangeEvents(provider(), [
      event({ excerpt: "Our theory is that the policy limit will not be reached." }),
    ]);
    assert.deepEqual(allowed, []);
    assert.equal(withheld.byTopic, 1);
  });

  it("withholds a delta whose OLD value is privileged even when the new one is clean", () => {
    // The hole a title-and-text screen would leave: the model is handed
    // `from` as well as `to`, so the old value leaks through the diff.
    const deltas: FieldDelta[] = [
      { field: "Notes", from: "BI limit 250/500 per the dec page", to: "Pending review" },
    ];
    const { allowed, withheld } = filterChangeEvents(provider(), [
      event({ title: "Pending review", summary: "Field changed", deltas }),
    ]);

    assert.deepEqual(allowed, []);
    assert.equal(withheld.byTopic, 1);
    assert.ok(withheld.topics.includes("coverage_amounts"));
  });

  it("withholds a delta whose NEW value is privileged", () => {
    const deltas: FieldDelta[] = [
      { field: "Notes", from: "Pending review", to: "Client not credible on prior injury" },
    ];
    const { allowed } = filterChangeEvents(provider(), [event({ deltas })]);
    assert.deepEqual(allowed, []);
  });

  it("screens the delta's field name too", () => {
    const deltas: FieldDelta[] = [{ field: "Case value", from: "1", to: "2" }];
    const { allowed } = filterChangeEvents(provider(), [event({ deltas })]);
    assert.deepEqual(allowed, []);
  });

  it("lets a released topic through", () => {
    const deltas: FieldDelta[] = [
      { field: "Coverage", from: "unknown", to: "BI limit confirmed" },
    ];
    const { allowed } = filterChangeEvents(
      provider({ releasedTopics: ["coverage_amounts"] }),
      [event({ deltas })],
    );
    assert.equal(allowed.length, 1);
  });
});

describe("withheld reporting", () => {
  it("reports counts and topic names, never content", () => {
    const { withheld } = filterChangeEvents(provider(), [
      event({ kind: "note", ref: "note:1" }),
      event({ excerpt: "Settlement value is around the policy limit." }),
    ]);

    assert.equal(withheld.byKind, 1);
    assert.equal(withheld.byTopic, 1);
    assert.equal(withheldCount(withheld), 2);
    // Topic names only: nothing in here quotes the withheld text.
    for (const topic of withheld.topics) {
      assert.match(topic, /^[a-z_]+$/);
    }
  });
});
