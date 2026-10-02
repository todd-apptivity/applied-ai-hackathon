/**
 * The provider's view of a matter is an allow-list. These tests hold it to the
 * PRD's "provider portal fields outside the attorney's approved set: 0": the
 * things a provider must never see are planted in the fixture and must not
 * appear anywhere in the result.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ProviderNotOnMatterError, deriveProviderView, listProviders, providerNeedles } from "../src/lib/matter/provider";
import type { SourceRecord } from "../src/lib/rag/sources";

const NOW = new Date("2026-10-02T12:00:00");
const STAFF = 900;

function record(kind: SourceRecord["kind"], clioId: string, fields: Partial<SourceRecord> = {}): SourceRecord {
  return {
    matterId: 7, kind, clioId, page: 0, title: `${kind} ${clioId}`, text: `${kind} ${clioId}`,
    occurredAt: null, clioUpdatedAt: null, metadata: {}, needsText: false, ...fields,
  };
}
const message = (id: string, date: string, from: number, to: number, subject: string, body: string, type = "EmailCommunication") =>
  record("communication", id, { title: subject, text: `Communication: ${subject}\n\n${body}`, occurredAt: date,
    metadata: { communicationType: type, senders: [{ id: from }], receivers: [{ id: to }] } });

const RECORDS: SourceRecord[] = [
  record("matter", "7", { title: "00042-Example", metadata: { stage: "Litigation", status: "Open" } }),
  record("contact", "1", { title: "Pat Example", text: "Contact: Pat Example\nDate of birth: 1990-01-01 SECRET-DOB", metadata: { isClient: true } }),
  record("contact", "2", { title: "Hilltop Physical Therapy, PLLC", metadata: { role: "Treating provider, physical therapy", type: "Company" } }),
  record("contact", "3", { title: "Riverbend Imaging Associates", metadata: { role: "Medical provider: imaging", type: "Company" } }),
  record("contact", "4", { title: "Sample Corp", metadata: { role: "Defendant" } }),
  record("contact", "5", { title: "Jordan Whitfield", metadata: { role: "Treating orthopaedic surgeon", type: "Person" } }),
  record("custom_field", "f1", { title: "Insurance Carrier", text: "Insurance Carrier: Sample Mutual SECRET-CARRIER" }),
  record("custom_field", "f2", { title: "Policy Limits", text: "Policy Limits: $100,000 SECRET-LIMIT" }),
  record("custom_field", "f3", { title: "Estimated Case Value", text: "Estimated Case Value: 375000 SECRET-VALUE" }),
  record("note", "10", { title: "Strategy SECRET-NOTE-TITLE", text: "Note\n\nHilltop Physical Therapy records look weak SECRET-NOTE", occurredAt: "2026-09-30" }),
  message("20", "2023-11-19", 2, STAFF, "Progress notes attached", "SECRET-BODY-IN"),
  message("21", "2024-03-12", STAFF, 2, "Records request", "We cannot value the case until SECRET-BODY-OUT"),
  message("22", "2026-05-05", STAFF, 2, "Records request, again", "Third request SECRET-BODY-OUT-2"),
  message("23", "2026-06-01", STAFF, 2, "Call to front desk", "Left voicemail", "PhoneCommunication"),
  message("24", "2026-06-02", STAFF, 3, "Films request to Riverbend", "SECRET-OTHER-PROVIDER-MESSAGE"),
  record("task", "30", { title: "By medical provider: Hilltop Physical Therapy, PLLC - Updated treatment notes", text: "Task\n\nNeeded before we can SECRET-TASK-DESCRIPTION", metadata: { dueAt: "2026-08-25", status: "pending" } }),
  record("task", "31", { title: "Hilltop Physical Therapy - old request", metadata: { dueAt: "2024-01-01", status: "complete" } }),
  record("task", "32", { title: "Prepare mediation statement SECRET-TASK", metadata: { dueAt: "2026-11-01", status: "pending" } }),
  record("calendar_entry", "40", { title: "Client treatment: Hilltop Physical Therapy", text: "Calendar\n\nSECRET-CALENDAR-DESCRIPTION", metadata: { startAt: "2026-10-10T14:00:00Z" } }),
  record("calendar_entry", "41", { title: "Defense medical exam SECRET-CALENDAR", metadata: { startAt: "2026-10-12T14:00:00Z" } }),
  record("activity", "50", { title: "ExpenseEntry", text: "Expense SECRET-EXPENSE", occurredAt: "2024-03-01", metadata: { activityType: "ExpenseEntry", total: 85 } }),
  record("document", "60", { title: "records-hilltop physical-notes.pdf", metadata: { receivedAt: "2023-12-01T10:00:00Z" } }),
  record("document", "61", { title: "answer-and-defenses SECRET-DOCUMENT.pdf", metadata: { receivedAt: "2024-12-18T10:00:00Z" } }),
];

const view = deriveProviderView(RECORDS, "2", { now: NOW });
const serialized = JSON.stringify(view);

describe("deriveProviderView: what a provider must never see", () => {
  it("leaks nothing planted outside its own correspondence, tasks and visits", () => {
    assert.equal(/SECRET/.test(serialized), false, serialized.match(/SECRET[-A-Z0-9]*/)?.[0]);
  });

  it("names no other party on the matter", () => {
    for (const name of ["Riverbend", "Sample Corp", "Sample Mutual", "Whitfield"]) {
      assert.equal(serialized.includes(name), false, name);
    }
  });

  it("carries no amounts: coverage is a yes or no", () => {
    assert.equal(view.case.coverageOnFile, true);
    assert.equal(/100,000|375000|\b85\b/.test(serialized), false);
  });

  it("refuses a contact who is not a treating provider on the matter", () => {
    assert.throws(() => deriveProviderView(RECORDS, "4", { now: NOW }), ProviderNotOnMatterError);
    assert.throws(() => deriveProviderView(RECORDS, "1", { now: NOW }), ProviderNotOnMatterError);
    assert.throws(() => deriveProviderView(RECORDS, "999", { now: NOW }), ProviderNotOnMatterError);
  });
});

describe("deriveProviderView: what it does show", () => {
  it("lists only open tasks that name the office, by name and due date", () => {
    assert.deepEqual(view.requests.map((r) => [r.ref, r.title, r.overdue]), [["task:30", "Updated treatment notes", true]]);
  });

  it("shows the office's own messages by subject, and which emails are unanswered", () => {
    assert.deepEqual(view.messages.map((m) => [m.ref, m.fromFirm, m.how, m.unanswered]), [
      ["communication:20", false, "email", false],
      ["communication:21", true, "email", true],
      ["communication:22", true, "email", true],
      ["communication:23", true, "call", false],
    ]);
    assert.equal(view.messages[1].subject, "Records request");
  });

  it("shows calendar entries and documents that name the office", () => {
    assert.deepEqual(view.visits.map((v) => [v.ref, v.past]), [["calendar_entry:40", false]]);
    assert.deepEqual(view.documents.map((d) => d.ref), ["document:60"]);
  });

  it("gives the patient, the stage and the date of the last activity", () => {
    assert.equal(view.patient.name, "Pat Example");
    assert.equal(view.case.stage, "Litigation");
    assert.equal(new Date(view.case.lastActivity!).toISOString().slice(0, 10), "2026-09-30");
  });
});

describe("finding a provider in text", () => {
  it("uses the full name and its first two distinctive words", () => {
    assert.deepEqual(providerNeedles(RECORDS[2]), ["hilltop physical therapy, pllc", "hilltop physical"]);
  });

  it("adds the surname for a person", () => {
    assert.equal(providerNeedles(RECORDS[5]).includes("whitfield"), true);
  });

  it("lists only medical providers as openable", () => {
    assert.deepEqual(listProviders(RECORDS).map((p) => p.id), ["2", "3", "5"]);
  });
});
