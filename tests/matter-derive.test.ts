/**
 * The computed layer of the lawyer views, on an invented matter.
 *
 * `deriveView` is pure, so these run without Clio, a database, or a model.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { classifyRole, deriveView, toMillis } from "../src/lib/matter/derive";
import { DATA_SLOT, embedJson, fillTemplate } from "../src/lib/matter/render";
import type { SourceRecord } from "../src/lib/rag/sources";

const NOW = new Date("2026-10-02T12:00:00");

function record(kind: SourceRecord["kind"], clioId: string, fields: Partial<SourceRecord> = {}): SourceRecord {
  return {
    matterId: 7, kind, clioId, page: 0, title: `${kind} ${clioId}`, text: `Header: x\n\nBody of ${clioId}`,
    occurredAt: null, clioUpdatedAt: null, metadata: {}, needsText: false, ...fields,
  };
}
const message = (id: string, date: string, from: number, to: number, type = "EmailCommunication") =>
  record("communication", id, { occurredAt: date, metadata: { communicationType: type, senders: [{ id: from }], receivers: [{ id: to }] } });

const STAFF = 900; // a Clio user: not among the contacts
const RECORDS: SourceRecord[] = [
  record("matter", "7", {
    title: "00042-Example",
    text: "Matter: 00042-Example\nDescription: Example v. Sample Corp\nStatus: Open",
    metadata: { displayNumber: "00042-Example", stage: "Litigation", status: "Open", practiceArea: "Personal Injury", openDate: "2024-01-10",
      statuteOfLimitations: { due_at: "2027-01-05", status: "pending", name: "Limitations" } },
  }),
  record("contact", "1", { title: "Pat Example", metadata: { isClient: true, role: "Client on this matter" } }),
  record("contact", "2", { title: "Hilltop Clinic", metadata: { role: "Treating provider, physical therapy" } }),
  record("contact", "3", { title: "Sample Corp", metadata: { role: "Defendant" } }),
  record("contact", "4", { title: "A. Bystander", metadata: { role: "Eyewitness" } }),
  record("custom_field", "date-1", { title: "Date of Incident", text: "Date of Incident: 2024-01-02", metadata: { value: "2024-01-02" } }),
  record("note", "10", { occurredAt: "2024-01-11" }),
  // Deliberately out of date order.
  message("22", "2026-06-01", STAFF, 2),
  message("20", "2024-02-01", 2, STAFF),
  message("21", "2026-03-01", STAFF, 2),
  message("23", "2026-09-27", 1, STAFF, "PhoneCommunication"),
  message("24", "2026-09-01", STAFF, 1),
  record("task", "30", { metadata: { dueAt: "2026-08-25", status: "pending" } }),
  record("task", "31", { metadata: { dueAt: "2026-04-01", status: "complete" } }),
  record("task", "32", { metadata: { dueAt: "2026-11-15", status: "pending" } }),
  record("calendar_entry", "40", { metadata: { startAt: "2026-11-12T15:00:00Z" } }),
  record("activity", "50", { occurredAt: "2024-03-01", metadata: { activityType: "ExpenseEntry", total: 85 } }),
  record("activity", "51", { occurredAt: "2024-04-01", metadata: { activityType: "ExpenseEntry", price: 40, quantity: 2 } }),
  record("activity", "52", { occurredAt: "2024-04-02", metadata: { activityType: "TimeEntry", total: 500 } }),
  record("document", "60", { metadata: { receivedAt: "2024-05-01T10:00:00Z" } }),
];

const view = deriveView(RECORDS, { now: NOW, link: (r) => `https://clio.example/${r.kind}/${r.clioId}` });
const event = (ref: string) => view.events.find((e) => e.ref === ref)!;

describe("classifyRole", () => {
  it("groups contacts by generic words in their role", () => {
    assert.equal(classifyRole("Treating provider, orthopedics"), "medical");
    assert.equal(classifyRole("Adverse driver"), "defense");
    assert.equal(classifyRole("Insurance carrier"), "defense");
    assert.equal(classifyRole("Court clerk"), "court");
    assert.equal(classifyRole("Eyewitness"), "other");
    assert.equal(classifyRole(null), "other");
  });
});

describe("deriveView: lanes", () => {
  it("puts the client and the firm first and the file last", () => {
    assert.deepEqual(view.lanes.map((l) => l.id), ["client", "firm", "c2", "c3", "c4", "file"]);
    assert.equal(view.lanes[0].name, "Pat Example");
  });

  it("folds outside parties into groups by class", () => {
    assert.deepEqual(view.groups.map((g) => [g.id, g.lanes, !!g.fold]), [
      ["client", ["client"], false], ["firm", ["firm"], false],
      ["medical", ["c2"], true], ["defense", ["c3"], true], ["other", ["c4"], true],
      ["file", ["file"], false],
    ]);
  });
});

describe("deriveView: events", () => {
  it("sorts by date whatever order the source returned", () => {
    const times = view.events.map((e) => e.t);
    assert.deepEqual(times, [...times].sort((a, b) => a - b));
  });

  it("places a message on its sender's lane, and a staff message on the firm's", () => {
    assert.deepEqual([event("communication:20").lane, event("communication:20").party], ["c2", "c2"]);
    assert.deepEqual([event("communication:21").lane, event("communication:21").party], ["firm", "c2"]);
    assert.equal(event("communication:23").kind, "call");
    assert.equal(event("communication:23").lane, "client");
  });

  it("marks firm messages unanswered only when the party has sent nothing since", () => {
    assert.equal(event("communication:21").open, true);
    assert.equal(event("communication:22").open, true);
    // The client called after this one.
    assert.equal(event("communication:24").open, undefined);
  });

  it("never treats a phone call as waiting on a reply", () => {
    const records = [...RECORDS, message("25", "2026-09-30", STAFF, 2, "PhoneCommunication")];
    const call = deriveView(records, { now: NOW }).events.find((e) => e.ref === "communication:25")!;
    assert.equal(call.kind, "call");
    assert.equal(call.open, undefined);
  });

  it("flags tasks past due, and leaves completed and future ones alone", () => {
    assert.equal(event("task:30").overdue, true);
    assert.equal(event("task:31").overdue, undefined);
    assert.equal(event("task:31").done, true);
    assert.equal(event("task:32").overdue, undefined);
  });

  it("keeps expenses and documents on the file lane and leaves time entries out", () => {
    assert.equal(event("activity:50").lane, "file");
    assert.equal(event("document:60").kind, "doc");
    assert.equal(view.events.some((e) => e.ref === "activity:52"), false);
  });

  it("carries the record's own text and link", () => {
    assert.equal(event("note:10").body, "Body of 10");
    assert.equal(event("note:10").url, "https://clio.example/note/10");
  });
});

describe("deriveView: case facts", () => {
  it("counts only expenses Clio has totalled, and never time entries", () => {
    assert.equal(view.case.costs, 85);
    assert.equal(view.case.expenses, 1);
    // The untotalled expense is still on the file lane.
    assert.equal(event("activity:51").lane, "file");
  });

  it("reads the matter, the limitations task and the custom fields", () => {
    assert.equal(view.title, "00042-Example");
    assert.equal(view.case.description, "Example v. Sample Corp");
    assert.equal(view.case.stage, "Litigation");
    assert.equal(view.case.opened, toMillis("2024-01-10"));
    assert.deepEqual(view.case.statute, { date: toMillis("2027-01-05"), status: "pending", name: "Limitations" });
    assert.deepEqual(view.case.fields.map((f) => [f.name, f.value]), [["Date of Incident", "2024-01-02"]]);
  });
});

describe("deriveView: the brief", () => {
  const line = (label: string) => view.brief.find((l) => l.label === label)?.text;

  it("says who, what to watch, who is silent and what is next, from the records", () => {
    assert.deepEqual(view.brief.map((l) => l.label), ["Who", "Watch out", "Waiting on", "Next"]);
    assert.equal(line("Who"), "Pat Example. Litigation stage, open for 2 years 9 months.");
    assert.equal(line("Watch out"), "1 task is overdue: task 30. 91 days remain to the limitations date.".replace("91", String(Math.round((toMillis("2027-01-05")! - NOW.getTime()) / 864e5))));
    assert.equal(line("Waiting on"), "Hilltop Clinic has not replied to 2 messages since March 2026.");
    assert.equal(line("Next"), "The client was last contacted 5 days ago. Next up: calendar_entry 40, on November 12.");
  });

  it("includes what happened only when the matter has a summary field", () => {
    const withSummary = deriveView([...RECORDS, record("custom_field", "s", { title: "Case Summary", text: "Case Summary: Rear-ended at a light.", metadata: { value: "Rear-ended at a light." } })], { now: NOW });
    assert.equal(withSummary.brief.find((l) => l.label === "What happened")?.text, "Rear-ended at a light.");
  });

  it("carries the client's contact details for the case header", () => {
    const withContact = deriveView(RECORDS.map((r) => (r.clioId === "1" && r.kind === "contact" ? { ...r, metadata: { ...r.metadata, phone: "555-0100", email: "pat@example.test" } } : r)), { now: NOW });
    assert.deepEqual([withContact.case.clientPhone, withContact.case.clientEmail], ["555-0100", "pat@example.test"]);
    assert.equal(view.case.clientPhone, null);
  });
});

describe("embedding the view in a page", () => {
  it("cannot be closed or commented out by record text", () => {
    const json = embedJson({ body: "</script><!-- & \u2028" });
    assert.equal(/[<>&\u2028]/.test(json), false);
    assert.deepEqual(JSON.parse(json), { body: "</script><!-- & \u2028" });
  });

  it("fills the slot literally, including dollar sequences", () => {
    const html = fillTemplate(`<script>const DATA = ${DATA_SLOT};</script>`, { ...view, title: "costs $& and $1" });
    assert.equal(html.includes(DATA_SLOT), false);
    assert.equal(html.includes("costs $\\u0026 and $1"), true);
  });

  it("refuses a template with no slot", () => {
    assert.throws(() => fillTemplate("<html></html>", view));
  });
});
