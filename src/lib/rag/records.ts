/**
 * Builds CaseRecords from source-neutral inputs. Both the live Clio sync and
 * the local export loader map their data into these shapes, so the text that
 * gets embedded is identical whichever way a matter was loaded.
 */
import type { CaseRecord } from "./types";
import { labeledLines, toLocalDate, toLocalDateTime } from "./util";

export interface MatterInput {
  id: string;
  displayNumber?: string | null;
  description?: string | null;
  status?: string | null;
  clientName?: string | null;
  practiceArea?: string | null;
  stage?: string | null;
  openDate?: string | null;
  closeDate?: string | null;
  statuteOfLimitations?: string | null;
  statuteOfLimitationsStatus?: string | null;
  updatedAt?: string | null;
}

export interface CustomFieldInput {
  id: string;
  name: string;
  value: unknown;
  updatedAt?: string | null;
}

export interface ContactInput {
  id: string;
  name: string;
  /** Relationship to the matter, e.g. "Client" or "Treating orthopedist". */
  role?: string | null;
  type?: string | null;
  title?: string | null;
  company?: string | null;
  dateOfBirth?: string | null;
  emails?: string[];
  phones?: string[];
  addresses?: string[];
  updatedAt?: string | null;
}

export interface NoteInput {
  id: string;
  subject?: string | null;
  detail?: string | null;
  date?: string | null;
  author?: string | null;
  updatedAt?: string | null;
}

export interface CommunicationInput {
  id: string;
  type?: string | null;
  subject?: string | null;
  body?: string | null;
  date?: string | null;
  senders?: string[];
  receivers?: string[];
  updatedAt?: string | null;
}

export interface TaskInput {
  id: string;
  name?: string | null;
  description?: string | null;
  status?: string | null;
  priority?: string | null;
  dueAt?: string | null;
  completedAt?: string | null;
  assignee?: string | null;
  isStatuteOfLimitations?: boolean | null;
  updatedAt?: string | null;
}

export interface CalendarEntryInput {
  id: string;
  summary?: string | null;
  description?: string | null;
  location?: string | null;
  startAt?: string | null;
  endAt?: string | null;
  allDay?: boolean | null;
  updatedAt?: string | null;
}

export interface ExpenseInput {
  id: string;
  date?: string | null;
  quantity?: number | null;
  price?: number | null;
  total?: number | null;
  note?: string | null;
  updatedAt?: string | null;
}

export interface MatterParts {
  matter: MatterInput;
  customFields: CustomFieldInput[];
  contacts: ContactInput[];
  notes: NoteInput[];
  communications: CommunicationInput[];
  tasks: TaskInput[];
  calendarEntries: CalendarEntryInput[];
  expenses: ExpenseInput[];
}

export function buildCaseRecords(parts: MatterParts): CaseRecord[] {
  const matterId = parts.matter.id;
  const records: CaseRecord[] = [];
  const push = (record: Omit<CaseRecord, "matterId">) => {
    if (record.text.trim()) records.push({ matterId, ...record });
  };

  const m = parts.matter;
  push({
    sourceType: "matter",
    sourceId: matterId,
    title: "Matter overview",
    date: toLocalDate(m.openDate),
    updatedAt: m.updatedAt,
    text: labeledLines([
      ["Matter", m.description],
      ["Matter number", m.displayNumber],
      ["Client", m.clientName],
      ["Status", m.status],
      ["Practice area", m.practiceArea],
      ["Stage", m.stage],
      ["Opened", toLocalDate(m.openDate)],
      ["Closed", toLocalDate(m.closeDate)],
      ["Statute of limitations date (Clio field)", toLocalDate(m.statuteOfLimitations)],
      ["Statute of limitations task status", m.statuteOfLimitationsStatus],
    ]),
  });

  for (const field of parts.customFields) {
    const value = formatFieldValue(field.value);
    if (value === null) continue;
    push({
      sourceType: "custom_field",
      sourceId: field.id,
      title: field.name,
      date: null,
      updatedAt: field.updatedAt,
      text: `${field.name}: ${value}`,
      metadata: { field: field.name },
    });
  }

  for (const c of parts.contacts) {
    push({
      sourceType: "contact",
      sourceId: c.id,
      title: c.role ? `${c.name} (${c.role})` : c.name,
      date: null,
      updatedAt: c.updatedAt,
      text: labeledLines([
        ["Name", c.name],
        ["Role on matter", c.role],
        ["Contact type", c.type],
        ["Title", c.title],
        ["Company", c.company],
        ["Date of birth", c.dateOfBirth],
        ["Email", c.emails?.join("; ")],
        ["Phone", c.phones?.join("; ")],
        ["Address", c.addresses?.join("; ")],
      ]),
      metadata: { role: c.role ?? null },
    });
  }

  for (const n of parts.notes) {
    const subject = n.subject?.trim() || "Note";
    push({
      sourceType: "note",
      sourceId: n.id,
      title: subject,
      date: toLocalDate(n.date),
      updatedAt: n.updatedAt,
      text: [labeledLines([["Subject", subject], ["Date", toLocalDate(n.date)], ["Author", n.author]]), n.detail?.trim()]
        .filter(Boolean)
        .join("\n\n"),
    });
  }

  for (const c of parts.communications) {
    const kind = communicationKind(c.type);
    push({
      sourceType: "communication",
      sourceId: c.id,
      title: c.subject?.trim() || `${kind} (no subject)`,
      date: toLocalDate(c.date),
      updatedAt: c.updatedAt,
      text: [
        labeledLines([
          ["Type", kind],
          ["Date", toLocalDate(c.date)],
          ["From", c.senders?.join("; ")],
          ["To", c.receivers?.join("; ")],
          ["Subject", c.subject],
        ]),
        c.body?.trim(),
      ]
        .filter(Boolean)
        .join("\n\n"),
      metadata: { kind, from: c.senders ?? [], to: c.receivers ?? [] },
    });
  }

  for (const t of parts.tasks) {
    const name = t.name?.trim() || "Task";
    push({
      sourceType: "task",
      sourceId: t.id,
      title: name,
      date: toLocalDate(t.dueAt),
      updatedAt: t.updatedAt,
      text: labeledLines([
        ["Task", name],
        ["Status", t.status],
        ["Due", toLocalDate(t.dueAt)],
        ["Completed", toLocalDate(t.completedAt)],
        ["Priority", t.priority],
        ["Assigned to", t.assignee],
        ["Statute of limitations task", t.isStatuteOfLimitations ? "Yes" : null],
        ["Description", t.description],
      ]),
      metadata: { status: t.status ?? null },
    });
  }

  for (const e of parts.calendarEntries) {
    const summary = e.summary?.trim() || "Calendar entry";
    push({
      sourceType: "calendar_entry",
      sourceId: e.id,
      title: summary,
      date: toLocalDate(e.startAt),
      updatedAt: e.updatedAt,
      text: labeledLines([
        ["Event", summary],
        ["Starts", e.allDay ? toLocalDate(e.startAt) : toLocalDateTime(e.startAt)],
        ["Ends", e.allDay ? toLocalDate(e.endAt) : toLocalDateTime(e.endAt)],
        ["Location", e.location],
        ["Description", e.description],
      ]),
    });
  }

  for (const x of parts.expenses) {
    const total = x.total ?? (x.quantity ?? 1) * (x.price ?? 0);
    const firstLine = x.note?.split("\n")[0]?.trim();
    push({
      sourceType: "expense",
      sourceId: x.id,
      title: firstLine ? truncate(firstLine, 80) : "Expense",
      date: toLocalDate(x.date),
      updatedAt: x.updatedAt,
      text: labeledLines([
        ["Expense date", toLocalDate(x.date)],
        ["Amount", formatMoney(total)],
        ["Quantity", x.quantity],
        ["Unit price", x.price !== null && x.price !== undefined ? formatMoney(x.price) : null],
        ["Description", x.note],
      ]),
      metadata: { amount: total },
    });
  }

  return records;
}

function communicationKind(type: string | null | undefined): string {
  switch (type) {
    case "EmailCommunication":
      return "Email";
    case "PhoneCommunication":
      return "Phone call";
    default:
      return type?.replace(/Communication$/, "") || "Communication";
  }
}

function formatFieldValue(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "object") {
    // Picklist and contact fields come back as objects.
    const v = value as Record<string, unknown>;
    return String(v.option ?? v.name ?? JSON.stringify(value));
  }
  return String(value);
}

function formatMoney(value: number): string {
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
