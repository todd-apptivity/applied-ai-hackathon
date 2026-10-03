/**
 * Turns a matter's records into what the lawyer views draw: party lanes,
 * dated events, and the facts that can be computed without a model.
 *
 * Pure. No Clio, no database, no clock — `now` is passed in — so it is tested
 * on fixtures. Type-only imports keep it free of anything server-bound.
 *
 * Nothing here names a matter, person, or provider. Parties are classified by
 * generic words in their Clio relationship description.
 */

import { BODY_PATHS, BODY_VIEWBOX } from "@/lib/matters/body-regions";
import { scanInjuries, type InjurySite } from "@/lib/matters/injury-scan";
import type { SourceRecord } from "@/lib/rag/sources";

import { briefLines, type BriefLine } from "./brief";

export type LaneClass = "client" | "firm" | "medical" | "defense" | "court" | "other" | "file";
export type EventKind = "email" | "call" | "note" | "task" | "event" | "doc" | "expense";

export interface ViewLane {
  id: string;
  name: string;
  role: string;
  cls: LaneClass;
}

export interface ViewGroup {
  id: string;
  lanes: string[];
  fold?: boolean;
  name?: string;
}

export interface ViewEvent {
  id: string;
  /** Citation ref shared with the chat agent, e.g. `note:4821`. */
  ref: string;
  /** Milliseconds since the epoch. */
  t: number;
  lane: string;
  kind: EventKind;
  title: string;
  body: string;
  /** The outside party this record is with, when there is one. */
  party?: string;
  /** A firm message with no later reply from that party. */
  open?: boolean;
  overdue?: boolean;
  done?: boolean;
  url: string | null;
}

export interface ViewField {
  name: string;
  value: string;
  ref: string;
  url: string | null;
}

export interface MatterView {
  matterId: number;
  title: string;
  subtitle: string;
  today: number;
  lanes: ViewLane[];
  groups: ViewGroup[];
  events: ViewEvent[];
  /** The short brief, read aloud or shown as text. */
  brief: BriefLine[];
  /**
   * The body map: the regions the records name, heaviest first, each carrying
   * the blobs to draw and the passages that put it there.
   */
  injuries: InjurySite[];
  /**
   * The silhouette those blobs sit on. Shipped with the data because the view
   * is a standalone document: it has no import of its own to reach for, and a
   * second copy of these paths would drift from the one the dashboard draws.
   */
  body: { w: number; h: number; paths: string[] };
  case: {
    clientName: string | null;
    /** How to reach the client, from their Clio contact record. */
    clientPhone: string | null;
    clientEmail: string | null;
    description: string | null;
    stage: string | null;
    status: string | null;
    opened: number | null;
    costs: number;
    expenses: number;
    statute: { date: number | null; status: string | null; name: string | null } | null;
    fields: ViewField[];
  };
}

export interface DeriveOptions {
  now: Date;
  /** Builds the deep link for a record; injected so this module stays pure. */
  link?: (record: SourceRecord) => string | null;
}

/** Words in a relationship description that place a contact in a group. */
export const ROLE_CLASSES: Array<[Exclude<LaneClass, "client" | "firm" | "file" | "other">, RegExp]> = [
  ["court", /court|judge|clerk|arbitrat|mediat/i],
  ["medical", /provider|physician|doctor|surgeon|therap|chiropract|orthop|medical|hospital|clinic|imaging|radiolog|pharmac|nurs/i],
  ["defense", /defend|defense|adverse|opposing|insur|carrier|adjust|claims/i],
];

const GROUP_NAMES: Record<string, string> = {
  medical: "Medical providers",
  defense: "Defense and insurers",
  court: "Court",
  other: "Other parties",
};

export function classifyRole(role: string | null | undefined): LaneClass {
  if (!role) return "other";
  for (const [cls, pattern] of ROLE_CLASSES) if (pattern.test(role)) return cls;
  return "other";
}

/**
 * Date-only values are pinned to local noon so a day never slides across
 * midnight when it is formatted in another time zone.
 */
export function toMillis(value: unknown): number | null {
  if (typeof value !== "string" || !value) return null;
  const ms = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T12:00:00` : value);
  return Number.isFinite(ms) ? ms : null;
}

/** The record's own prose: sources carry a header block, then a blank line, then the body. */
function bodyOf(record: SourceRecord): string {
  const cut = record.text.indexOf("\n\n");
  const text = cut >= 0 ? record.text.slice(cut + 2).trim() : "";
  return (text || record.text).slice(0, 6000);
}

function refOf(record: SourceRecord): string {
  return `${record.kind}:${record.clioId}`;
}

type PartyRef = { id?: unknown; name?: unknown };

export function deriveView(records: SourceRecord[], options: DeriveOptions): MatterView {
  const today = options.now.getTime();
  const link = options.link ?? (() => null);
  const matter = records.find((r) => r.kind === "matter");
  const meta = (matter?.metadata ?? {}) as Record<string, unknown>;

  // --- Lanes -------------------------------------------------------------
  const lanes: ViewLane[] = [];
  const laneOfContact = new Map<number, string>();
  const byClass = new Map<LaneClass, string[]>();

  const contacts = records.filter((r) => r.kind === "contact");
  const client = contacts.find((r) => r.metadata.isClient === true);
  if (client) {
    lanes.push({ id: "client", name: client.title, role: "Client", cls: "client" });
    laneOfContact.set(Number(client.clioId), "client");
  }
  lanes.push({ id: "firm", name: "Our firm", role: "Attorneys and staff", cls: "firm" });

  for (const contact of contacts) {
    if (contact === client) continue;
    const role = typeof contact.metadata.role === "string" ? contact.metadata.role : null;
    const cls = classifyRole(role);
    const id = `c${contact.clioId}`;
    lanes.push({ id, name: contact.title, role: role ?? "Related contact", cls });
    laneOfContact.set(Number(contact.clioId), id);
    byClass.set(cls, [...(byClass.get(cls) ?? []), id]);
  }
  lanes.push({ id: "file", name: "File", role: "When records were added", cls: "file" });

  const groups: ViewGroup[] = [];
  if (client) groups.push({ id: "client", lanes: ["client"] });
  groups.push({ id: "firm", lanes: ["firm"] });
  for (const cls of ["medical", "defense", "court", "other"] as const) {
    const ids = byClass.get(cls);
    if (ids?.length) groups.push({ id: cls, lanes: ids, fold: true, name: GROUP_NAMES[cls] });
  }
  groups.push({ id: "file", lanes: ["file"] });

  // --- Events ------------------------------------------------------------
  const events: ViewEvent[] = [];
  const add = (record: SourceRecord, t: number | null, rest: Omit<ViewEvent, "id" | "ref" | "t" | "title" | "body" | "url">) => {
    if (t === null) return;
    events.push({ id: "", ref: refOf(record), t, title: record.title, body: bodyOf(record), url: link(record), ...rest });
  };
  const laneFor = (refs: unknown): string | null => {
    for (const ref of (Array.isArray(refs) ? refs : []) as PartyRef[]) {
      const lane = laneOfContact.get(Number(ref.id));
      if (lane) return lane;
    }
    return null;
  };

  let costs = 0;
  let expenses = 0;

  for (const record of records) {
    const m = record.metadata;
    switch (record.kind) {
      case "note":
        add(record, toMillis(record.occurredAt), { lane: "firm", kind: "note" });
        break;
      case "communication": {
        const kind: EventKind = /phone/i.test(String(m.communicationType ?? "")) ? "call" : "email";
        const from = laneFor(m.senders);
        const to = laneFor(m.receivers);
        // From an outside party: it sits on their lane. Otherwise the firm sent it.
        if (from) add(record, toMillis(record.occurredAt), { lane: from, kind, party: from });
        else add(record, toMillis(record.occurredAt), { lane: "firm", kind, ...(to ? { party: to } : {}) });
        break;
      }
      case "task": {
        const t = toMillis(m.dueAt ?? record.occurredAt);
        const done = /complete/i.test(String(m.status ?? ""));
        add(record, t, { lane: "firm", kind: "task", ...(done ? { done } : {}), ...(!done && t !== null && t < today ? { overdue: true } : {}) });
        break;
      }
      case "calendar_entry":
        add(record, toMillis(m.startAt ?? record.occurredAt), { lane: "firm", kind: "event" });
        break;
      case "activity": {
        if (!/expense/i.test(String(m.activityType ?? ""))) break;
        // Only entries Clio has totalled count as firm costs. An entry with a
        // price but no total is on the file, but is not money the firm spent.
        if (typeof m.total === "number" && Number.isFinite(m.total)) {
          costs += m.total;
          expenses += 1;
        }
        add(record, toMillis(record.occurredAt), { lane: "file", kind: "expense" });
        break;
      }
      case "document":
        add(record, toMillis(m.receivedAt ?? record.occurredAt), { lane: "file", kind: "doc" });
        break;
      default:
        break;
    }
  }

  // Clio does not return communications in date order.
  events.sort((a, b) => a.t - b.t);
  events.forEach((event, index) => { event.id = `e${index}`; });

  // A firm message is unanswered when that party has sent nothing since.
  const lastInbound = new Map<string, number>();
  for (const event of events) {
    if (event.lane !== "firm" && event.lane !== "file" && event.t <= today) lastInbound.set(event.lane, event.t);
  }
  for (const event of events) {
    // Only written messages wait on a reply; a phone call was the conversation.
    const isMessage = event.kind === "email";
    if (isMessage && event.lane === "firm" && event.party && event.t <= today && event.t > (lastInbound.get(event.party) ?? -Infinity)) {
      event.open = true;
    }
  }

  // --- Case facts --------------------------------------------------------
  const sol = meta.statuteOfLimitations as { due_at?: string; status?: string; name?: string } | null | undefined;
  const fields: ViewField[] = records
    .filter((r) => r.kind === "custom_field")
    .map((r) => {
      const value = r.metadata.value;
      return {
        name: r.title,
        value: typeof value === "string" ? value : typeof value === "number" || typeof value === "boolean" ? String(value) : r.text.replace(`${r.title}: `, ""),
        ref: refOf(r),
        url: link(r),
      };
    });

  const display = typeof meta.displayNumber === "string" ? meta.displayNumber : matter?.title ?? "Matter";
  const stage = typeof meta.stage === "string" ? meta.stage : null;
  const practice = typeof meta.practiceArea === "string" ? meta.practiceArea : null;

  const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);
  const view = {
    matterId: matter?.matterId ?? records[0]?.matterId ?? 0,
    title: display,
    subtitle: [practice, stage, typeof meta.status === "string" ? meta.status : null].filter(Boolean).join(" · "),
    today,
    lanes,
    groups,
    events,
    case: {
      clientName: client?.title ?? (typeof meta.clientName === "string" ? meta.clientName : null),
      clientPhone: text(client?.metadata.phone),
      clientEmail: text(client?.metadata.email),
      description: descriptionOf(matter),
      stage,
      status: typeof meta.status === "string" ? meta.status : null,
      opened: toMillis(meta.openDate),
      costs: Math.round(costs * 100) / 100,
      expenses,
      statute: sol ? { date: toMillis(sol.due_at), status: sol.status ?? null, name: sol.name ?? null } : null,
      fields,
    },
    injuries: scanInjuries(records, { link }),
    body: { w: BODY_VIEWBOX.width, h: BODY_VIEWBOX.height, paths: [...BODY_PATHS] },
  };

  return { ...view, brief: briefLines(view) };
}

/** The matter description is a labelled line inside the matter record's text. */
function descriptionOf(matter: SourceRecord | undefined): string | null {
  const line = matter?.text.split("\n").find((l) => /^description:/i.test(l));
  return line ? line.replace(/^description:\s*/i, "").trim() || null : null;
}
