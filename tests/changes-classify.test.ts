/**
 * The change classifier, tested without a database or a model.
 *
 * Every rule here decides what a reader is told happened, so a wrong rule is a
 * confidently cited false statement. The metadata shapes below are the ones the
 * source mappers in `@/lib/rag/sources` actually store.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  classifyRow,
  collapseRevisions,
  eventWeight,
  isBackdated,
  summarize,
  type RevisionRow,
} from "@/lib/changes/classify";

const OBSERVED = "2026-10-02T18:00:00.000Z";

function row(overrides: Partial<RevisionRow> = {}): RevisionRow {
  return {
    id: 1,
    matter_id: 4242,
    source_id: 10,
    kind: "task",
    clio_id: "100",
    page: 0,
    change_type: "updated",
    title: "Serve letter of representation",
    prev_title: "Serve letter of representation",
    excerpt: null,
    prev_excerpt: null,
    prev_metadata: null,
    new_metadata: null,
    occurred_at: "2026-09-30",
    prev_occurred_at: null,
    clio_updated_at: OBSERVED,
    observed_at: OBSERVED,
    ...overrides,
  };
}

function meta(value: Record<string, unknown>): string {
  return JSON.stringify(value);
}

function classify(input: Partial<RevisionRow>, documentExisted = false) {
  return classifyRow(row(input), { clioUrl: null, documentExisted });
}

describe("task rules", () => {
  it("reads a status move into complete as a completion", () => {
    const [event] = classify({
      prev_metadata: meta({ status: "incomplete", dueAt: "2026-09-30" }),
      new_metadata: meta({ status: "complete", dueAt: "2026-09-30" }),
    });
    assert.equal(event.type, "task_completed");
    assert.deepEqual(event.deltas, [
      { field: "status", from: "incomplete", to: "complete" },
    ]);
  });

  it("reads the reverse as a reopen", () => {
    const [event] = classify({
      prev_metadata: meta({ status: "complete" }),
      new_metadata: meta({ status: "incomplete" }),
    });
    assert.equal(event.type, "task_reopened");
  });

  it("reports a moved due date", () => {
    const [event] = classify({
      prev_metadata: meta({ status: "incomplete", dueAt: "2026-09-30" }),
      new_metadata: meta({ status: "incomplete", dueAt: "2026-11-15" }),
    });
    assert.equal(event.type, "task_due_moved");
  });

  it("detects reassignment by id, not by name", () => {
    const [renamed] = classify({
      prev_metadata: meta({ status: "incomplete", assignee: { id: 7, name: "A. Ruiz" } }),
      new_metadata: meta({ status: "incomplete", assignee: { id: 7, name: "Ana Ruiz" } }),
    });
    // Same person, corrected spelling: not a reassignment.
    assert.equal(renamed.type, "task_revised");

    const [moved] = classify({
      prev_metadata: meta({ status: "incomplete", assignee: { id: 7, name: "A. Ruiz" } }),
      new_metadata: meta({ status: "incomplete", assignee: { id: 9, name: "B. Chen" } }),
    });
    assert.equal(moved.type, "task_reassigned");
  });

  it("names the highest-weight change and keeps the rest as deltas", () => {
    // Reassigned and completed at once: a reader needs "completed" first.
    const [event] = classify({
      prev_metadata: meta({
        status: "incomplete",
        dueAt: "2026-09-30",
        assignee: { id: 7, name: "A. Ruiz" },
      }),
      new_metadata: meta({
        status: "complete",
        dueAt: "2026-10-01",
        assignee: { id: 9, name: "B. Chen" },
      }),
    });
    assert.equal(event.type, "task_completed");
    assert.equal(event.deltas.length, 3);
  });

  it("calls a first sighting a new task", () => {
    const [event] = classify({
      change_type: "created",
      new_metadata: meta({ status: "incomplete" }),
    });
    assert.equal(event.type, "task_created");
  });
});

describe("calendar rules", () => {
  it("reports a moved start as a reschedule", () => {
    const [event] = classify({
      kind: "calendar_entry",
      prev_metadata: meta({ startAt: "2026-10-10T14:00:00Z" }),
      new_metadata: meta({ startAt: "2026-10-17T14:00:00Z" }),
    });
    assert.equal(event.type, "calendar_rescheduled");
  });

  it("treats a deleted entry as cancelled rather than merely removed", () => {
    const [event] = classify({ kind: "calendar_entry", change_type: "deleted" });
    assert.equal(event.type, "calendar_cancelled");
  });
});

describe("matter and custom field rules", () => {
  it("splits a status move and a limitations move into two events", () => {
    const events = classify({
      kind: "matter",
      prev_metadata: meta({
        status: "Open",
        stage: "Treating",
        statuteOfLimitations: { due_at: "2026-04-22" },
      }),
      new_metadata: meta({
        status: "Pending",
        stage: "Treating",
        statuteOfLimitations: { due_at: "2026-06-01" },
      }),
    });

    const types = events.map((event) => event.type);
    assert.deepEqual(types, ["matter_status_changed", "field_changed"]);
  });

  it("weights a date field above a text one", () => {
    const [dateField] = classify({
      kind: "custom_field",
      prev_metadata: meta({ fieldName: "Limitations Date", fieldType: "date", value: "2026-04-22" }),
      new_metadata: meta({ fieldName: "Limitations Date", fieldType: "date", value: "2026-06-01" }),
    });
    const [textField] = classify({
      kind: "custom_field",
      prev_metadata: meta({ fieldName: "Referral source", fieldType: "text", value: "Web" }),
      new_metadata: meta({ fieldName: "Referral source", fieldType: "text", value: "Phone" }),
    });

    assert.equal(dateField.type, "field_changed");
    assert.ok(dateField.weight > textField.weight);
    assert.deepEqual(dateField.deltas, [
      { field: "Limitations Date", from: "2026-04-22", to: "2026-06-01" },
    ]);
  });
});

describe("document rules", () => {
  it("calls a page under a known document an indexing event", () => {
    const [event] = classify(
      { kind: "document_page", clio_id: "900", page: 47, change_type: "created" },
      true,
    );
    assert.equal(event.type, "document_text_indexed");
    // The page belongs in the ref, or two pages of one document collide.
    assert.equal(event.ref, "document_page:900#p47");
  });

  it("calls a page under an unknown document a new document", () => {
    const [event] = classify(
      { kind: "document_page", clio_id: "901", page: 1, change_type: "created" },
      false,
    );
    assert.equal(event.type, "document_added");
  });
});

describe("backdating", () => {
  it("flags a record about an old event added recently", () => {
    assert.equal(isBackdated("2023-05-07", OBSERVED), true);
  });

  it("does not flag something that just happened", () => {
    assert.equal(isBackdated("2026-10-01", OBSERVED), false);
  });

  it("does not flag a record with no date of its own", () => {
    assert.equal(isBackdated(null, OBSERVED), false);
  });

  it("says a backdated record was ADDED on the date we learned", () => {
    const text = summarize("note_added", "Call with client", [], {
      occurredAt: "2023-05-07",
      observedAt: OBSERVED,
      backdated: true,
    });
    // The failure this guards: reporting an import as news from 2023.
    assert.match(text, /dated 2023-05-07/);
    assert.match(text, /added to the file 2026-10-02/);
  });

  it("keeps the plain phrasing for a current record", () => {
    const text = summarize("task_completed", "Serve letter", [], {
      occurredAt: "2026-10-01",
      observedAt: OBSERVED,
      backdated: false,
    });
    assert.match(text, /^Task completed: Serve letter/);
    assert.doesNotMatch(text, /added to the file/);
  });
});

describe("weights", () => {
  it("ranks a status change above routine logging", () => {
    assert.ok(eventWeight("matter_status_changed") > eventWeight("activity_logged"));
    assert.ok(eventWeight("task_completed") > eventWeight("note_revised"));
  });
});

describe("collapsing", () => {
  it("reduces several revisions of one record to a single event", () => {
    const rows = [
      row({ id: 1, observed_at: "2026-10-01T00:00:00.000Z", prev_metadata: meta({ status: "incomplete" }) }),
      row({ id: 2, observed_at: "2026-10-02T00:00:00.000Z", prev_metadata: meta({ status: "pending" }) }),
    ];
    const collapsed = collapseRevisions(rows);
    assert.equal(collapsed.length, 1);
    // Earliest "before" and latest "after": the net change, not the last hop.
    assert.equal(collapsed[0].id, 2);
    assert.equal(collapsed[0].prev_metadata, meta({ status: "incomplete" }));
  });

  it("keeps separate records separate", () => {
    const collapsed = collapseRevisions([
      row({ id: 1, clio_id: "100" }),
      row({ id: 2, clio_id: "200" }),
    ]);
    assert.equal(collapsed.length, 2);
  });

  it("distinguishes two pages of the same document", () => {
    const collapsed = collapseRevisions([
      row({ id: 1, kind: "document_page", clio_id: "900", page: 1 }),
      row({ id: 2, kind: "document_page", clio_id: "900", page: 2 }),
    ]);
    assert.equal(collapsed.length, 2);
  });

  it("drops a record created and deleted inside one window", () => {
    // It never existed as far as this viewer is concerned.
    const collapsed = collapseRevisions([
      row({ id: 1, change_type: "created", observed_at: "2026-10-01T00:00:00.000Z" }),
      row({ id: 2, change_type: "deleted", observed_at: "2026-10-02T00:00:00.000Z" }),
    ]);
    assert.deepEqual(collapsed, []);
  });

  it("still reports a record that was created then edited as new", () => {
    const collapsed = collapseRevisions([
      row({ id: 1, change_type: "created", observed_at: "2026-10-01T00:00:00.000Z" }),
      row({ id: 2, change_type: "updated", observed_at: "2026-10-02T00:00:00.000Z" }),
    ]);
    assert.equal(collapsed.length, 1);
    assert.equal(collapsed[0].change_type, "created");
  });
});
