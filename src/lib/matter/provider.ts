/**
 * What one treating provider may see of one matter.
 *
 * Built as an allow-list, not a filter: nothing is copied out of a record
 * unless a line below names it. Attorney notes, custom fields (coverage
 * amounts, case value, liability), expenses, other contacts and the client's
 * identifiers are never read into the result, so there is nothing to redact.
 *
 * From a record that involves this provider, only what the provider already
 * has is used: the subject and date of messages exchanged with their own
 * office, the name and due date of a task that names them, and the title and
 * time of a calendar entry that names them. Bodies and descriptions are left
 * out — a task description is the firm's reasoning, not a request.
 *
 * Pure: no Clio, no database, no clock.
 */

import type { SourceRecord } from "@/lib/rag/sources";

import { classifyRole, toMillis } from "./derive";

export interface ProviderRequest {
  /** Citation ref of the task, e.g. `task:123`. */
  ref: string;
  title: string;
  due: number | null;
  overdue: boolean;
}

export interface ProviderMessage {
  ref: string;
  t: number;
  /** "email" or "call". */
  how: "email" | "call";
  /** True when the firm sent it; false when the provider's office did. */
  fromFirm: boolean;
  subject: string;
  /** A firm email with nothing from the provider since. */
  unanswered: boolean;
}

export interface ProviderVisit {
  ref: string;
  t: number;
  title: string;
  past: boolean;
}

export interface ProviderCaseView {
  matterId: number;
  today: number;
  provider: { id: string; name: string; role: string | null };
  patient: { name: string | null };
  case: {
    stage: string | null;
    status: string | null;
    /** The date of the most recent dated record on the matter; no content. */
    lastActivity: number | null;
    /** Whether an insurance carrier is recorded at all. Never the amount. */
    coverageOnFile: boolean;
  };
  requests: ProviderRequest[];
  messages: ProviderMessage[];
  visits: ProviderVisit[];
  /** Documents on file whose name mentions the provider. Name and date only. */
  documents: Array<{ ref: string; title: string; t: number | null }>;
}

/** Words that say what kind of entity a contact is, not which one. */
const GENERIC = /^(the|of|and|new|york|pllc|pc|p\.c\.|llc|inc|md|m\.d\.|dc|d\.c\.|associates|services|offices?|center|group|company|corp)$/i;

/**
 * Phrases that identify this provider inside free text: the full name, its
 * first two distinctive words, and for a person the surname.
 */
export function providerNeedles(contact: SourceRecord): string[] {
  const name = contact.title.trim();
  const words = name.split(/[\s,]+/).filter((word) => word && !GENERIC.test(word));
  const needles = new Set<string>([name.toLowerCase()]);
  if (words.length >= 2) needles.add(`${words[0]} ${words[1]}`.toLowerCase());
  if (contact.metadata.type === "Person" && words.length >= 2) {
    needles.add(words[words.length - 1].toLowerCase());
  }
  // A one-word needle has to be distinctive enough not to match by accident.
  return [...needles].filter((needle) => needle.length >= 6 || needle.includes(" "));
}

function mentions(text: string | null | undefined, needles: string[]): boolean {
  if (!text) return false;
  const lower = text.toLowerCase();
  return needles.some((needle) => lower.includes(needle));
}

/** "By medical provider: Example Clinic - Updated records" → "Updated records". */
function requestTitle(title: string, needles: string[]): string {
  const dash = title.lastIndexOf(" - ");
  if (dash > 0 && mentions(title.slice(0, dash), needles)) return title.slice(dash + 3).trim();
  return title;
}

type PartyRef = { id?: unknown };
const hasParty = (refs: unknown, id: number) =>
  (Array.isArray(refs) ? (refs as PartyRef[]) : []).some((ref) => Number(ref.id) === id);

export class ProviderNotOnMatterError extends Error {
  constructor(providerId: string, matterId: number) {
    super(`Contact ${providerId} is not a treating provider on matter ${matterId}.`);
    this.name = "ProviderNotOnMatterError";
  }
}

/** The medical-provider contacts on a matter: who a provider view can be opened for. */
export function listProviders(records: SourceRecord[]): Array<{ id: string; name: string; role: string | null }> {
  return records
    .filter((r) => r.kind === "contact" && r.metadata.isClient !== true)
    .map((r) => ({ id: r.clioId, name: r.title, role: typeof r.metadata.role === "string" ? r.metadata.role : null }))
    .filter((p) => classifyRole(p.role) === "medical");
}

export function deriveProviderView(
  records: SourceRecord[],
  providerId: string,
  options: { now: Date },
): ProviderCaseView {
  const today = options.now.getTime();
  const matter = records.find((r) => r.kind === "matter");
  const matterId = matter?.matterId ?? records[0]?.matterId ?? 0;

  const contact = records.find((r) => r.kind === "contact" && r.clioId === providerId);
  const role = contact && typeof contact.metadata.role === "string" ? contact.metadata.role : null;
  // Only a treating provider gets a view; a defendant or insurer never does.
  if (!contact || contact.metadata.isClient === true || classifyRole(role) !== "medical") {
    throw new ProviderNotOnMatterError(providerId, matterId);
  }

  const id = Number(providerId);
  const needles = providerNeedles(contact);
  const client = records.find((r) => r.kind === "contact" && r.metadata.isClient === true);
  const meta = (matter?.metadata ?? {}) as Record<string, unknown>;

  // --- Messages exchanged with this office: subject and date only ----------
  const messages: ProviderMessage[] = [];
  for (const record of records) {
    if (record.kind !== "communication") continue;
    const from = hasParty(record.metadata.senders, id);
    const to = hasParty(record.metadata.receivers, id);
    const t = toMillis(record.occurredAt);
    if ((!from && !to) || t === null) continue;
    messages.push({
      ref: `communication:${record.clioId}`,
      t,
      how: /phone/i.test(String(record.metadata.communicationType ?? "")) ? "call" : "email",
      fromFirm: !from,
      subject: record.title,
      unanswered: false,
    });
  }
  messages.sort((a, b) => a.t - b.t);
  const lastFromProvider = messages.filter((m) => !m.fromFirm && m.t <= today).pop()?.t ?? -Infinity;
  for (const message of messages) {
    if (message.fromFirm && message.how === "email" && message.t <= today && message.t > lastFromProvider) {
      message.unanswered = true;
    }
  }

  // --- Open tasks that name this office: name and due date only ------------
  const requests: ProviderRequest[] = [];
  for (const record of records) {
    if (record.kind !== "task" || !mentions(record.title, needles)) continue;
    if (/complete/i.test(String(record.metadata.status ?? ""))) continue;
    const due = toMillis(record.metadata.dueAt ?? record.occurredAt);
    requests.push({
      ref: `task:${record.clioId}`,
      title: requestTitle(record.title, needles),
      due,
      overdue: due !== null && due < today,
    });
  }
  requests.sort((a, b) => (a.due ?? Infinity) - (b.due ?? Infinity));

  // --- Calendar entries that name this office: title and time only ---------
  const visits: ProviderVisit[] = [];
  for (const record of records) {
    if (record.kind !== "calendar_entry" || !mentions(record.title, needles)) continue;
    const t = toMillis(record.metadata.startAt ?? record.occurredAt);
    if (t !== null) visits.push({ ref: `calendar_entry:${record.clioId}`, t, title: record.title, past: t < today });
  }
  visits.sort((a, b) => a.t - b.t);

  // --- Documents whose own name mentions this office ------------------------
  const documents = records
    .filter((r) => r.kind === "document" && mentions(r.title, needles))
    .map((r) => ({ ref: `document:${r.clioId}`, title: r.title, t: toMillis(r.metadata.receivedAt ?? r.occurredAt) }));

  // --- Case status: a stage, a date, and a yes/no ---------------------------
  let lastActivity: number | null = null;
  for (const record of records) {
    if (!["note", "communication", "task", "calendar_entry", "document"].includes(record.kind)) continue;
    const t = toMillis(record.kind === "calendar_entry" ? record.metadata.startAt : record.occurredAt);
    if (t !== null && t <= today && (lastActivity === null || t > lastActivity)) lastActivity = t;
  }
  const coverageOnFile = records.some(
    (r) => r.kind === "custom_field" && /insurance carrier/i.test(r.title) && r.text.trim().length > r.title.length + 2,
  );

  return {
    matterId,
    today,
    provider: { id: providerId, name: contact.title, role },
    patient: { name: client?.title ?? null },
    case: {
      stage: typeof meta.stage === "string" ? meta.stage : null,
      status: typeof meta.status === "string" ? meta.status : null,
      lastActivity,
      coverageOnFile,
    },
    requests,
    messages,
    visits,
    documents,
  };
}
