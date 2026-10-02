/**
 * Raw revisions to meaningful events.
 *
 * Pure functions over a revision row: no database, no request, no model, so
 * every rule here is testable in milliseconds. The classification is plain
 * code on purpose. A model asked to decide whether a task was completed or
 * merely reworded will sometimes be wrong, and this is the layer the prose is
 * not allowed to contradict.
 *
 * The structured `metadata` the source mappers already store is what makes
 * this possible — diffing two JSON objects says *which field* moved, where
 * diffing two blobs of rendered text only says that something did.
 */

import { passageRef } from "@/lib/chat/types";

import {
  BACKDATE_DAYS,
  type ChangeEvent,
  type ChangeEventType,
  type FieldDelta,
} from "./types";

/** One row of the changeset query, before classification. */
export interface RevisionRow {
  id: number;
  matter_id: number;
  source_id: number | null;
  kind: string;
  clio_id: string;
  page: number;
  change_type: string;
  title: string | null;
  prev_title: string | null;
  excerpt: string | null;
  prev_excerpt: string | null;
  prev_metadata: string | null;
  new_metadata: string | null;
  occurred_at: string | null;
  prev_occurred_at: string | null;
  clio_updated_at: string | null;
  observed_at: string;
}

type Meta = Record<string, unknown>;

function parseMeta(raw: string | null): Meta {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Meta) : {};
  } catch {
    return {};
  }
}

function str(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

/** A reference's id, so a reassignment is detected by identity not by name. */
function refId(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const id = (value as { id?: unknown }).id;
  return id === null || id === undefined ? null : String(id);
}

function delta(field: string, before: unknown, after: unknown): FieldDelta | null {
  const from = str(before);
  const to = str(after);
  if (from === to) return null;
  return { field, from, to };
}

/* --- weights -------------------------------------------------------------- */

/**
 * Significance, not recency. The window already handles recency; this decides
 * what leads when twenty things changed and six sentences are allowed.
 */
const WEIGHTS: Record<ChangeEventType, number> = {
  matter_status_changed: 100,
  matter_stage_changed: 85,
  field_changed: 70,
  task_completed: 80,
  task_due_moved: 75,
  task_reopened: 78,
  calendar_rescheduled: 70,
  document_added: 65,
  note_added: 60,
  communication_logged: 55,
  calendar_added: 50,
  calendar_cancelled: 52,
  task_created: 50,
  task_reassigned: 48,
  contact_added: 45,
  document_text_indexed: 40,
  record_removed: 35,
  matter_revised: 32,
  task_revised: 30,
  note_revised: 30,
  communication_revised: 28,
  document_revised: 28,
  contact_revised: 26,
  activity_revised: 18,
  activity_logged: 20,
};

/** A date custom field is usually a deadline, so it outranks a text one. */
const DATE_FIELD_WEIGHT = 90;

export function eventWeight(type: ChangeEventType, isDateField = false): number {
  if (type === "field_changed" && isDateField) return DATE_FIELD_WEIGHT;
  return WEIGHTS[type] ?? 25;
}

/* --- per-kind rules ------------------------------------------------------- */

interface Classified {
  type: ChangeEventType;
  deltas: FieldDelta[];
  /** Set when the weight depends on the data rather than only the type. */
  isDateField?: boolean;
}

function classifyTask(changeType: string, prev: Meta, next: Meta): Classified {
  if (changeType === "created") return { type: "task_created", deltas: [] };

  const deltas: FieldDelta[] = [];
  const status = delta("status", prev.status, next.status);
  const due = delta("dueAt", prev.dueAt, next.dueAt);
  const assignee = delta(
    "assignee",
    (prev.assignee as { name?: string } | null)?.name ?? prev.assignee,
    (next.assignee as { name?: string } | null)?.name ?? next.assignee,
  );
  const reassigned = refId(prev.assignee) !== refId(next.assignee);

  if (status) deltas.push(status);
  if (due) deltas.push(due);
  if (reassigned && assignee) deltas.push(assignee);

  const wasComplete = str(prev.status)?.toLowerCase() === "complete";
  const isComplete = str(next.status)?.toLowerCase() === "complete";

  // Several of these can be true at once; the highest-weight one names the
  // event and the rest stay visible as deltas. A task that was reassigned and
  // then completed reads as "completed", which is what someone needs to know.
  if (!wasComplete && isComplete) return { type: "task_completed", deltas };
  if (wasComplete && !isComplete) return { type: "task_reopened", deltas };
  if (due) return { type: "task_due_moved", deltas };
  if (reassigned) return { type: "task_reassigned", deltas };
  return { type: "task_revised", deltas };
}

function classifyCalendar(changeType: string, prev: Meta, next: Meta): Classified {
  if (changeType === "created") return { type: "calendar_added", deltas: [] };
  if (changeType === "deleted") return { type: "calendar_cancelled", deltas: [] };

  const deltas: FieldDelta[] = [];
  const start = delta("startAt", prev.startAt, next.startAt);
  const end = delta("endAt", prev.endAt, next.endAt);
  const location = delta("location", prev.location, next.location);
  if (start) deltas.push(start);
  if (end) deltas.push(end);
  if (location) deltas.push(location);

  if (start) return { type: "calendar_rescheduled", deltas };
  return { type: "calendar_added", deltas };
}

function classifyCustomField(prev: Meta, next: Meta): Classified {
  const name = str(next.fieldName) ?? str(prev.fieldName) ?? "Field";
  const isDateField =
    str(next.fieldType) === "date" || str(prev.fieldType) === "date";
  const change = delta(name, prev.value, next.value);
  return {
    type: "field_changed",
    deltas: change ? [change] : [],
    isDateField,
  };
}

function classifyMatter(prev: Meta, next: Meta): Classified[] {
  const out: Classified[] = [];

  const status = delta("status", prev.status, next.status);
  const stage = delta("stage", prev.stage, next.stage);

  const prevSol = (prev.statuteOfLimitations as { due_at?: unknown } | null) ?? null;
  const nextSol = (next.statuteOfLimitations as { due_at?: unknown } | null) ?? null;
  const sol = delta("Limitations due", prevSol?.due_at, nextSol?.due_at);

  if (status) out.push({ type: "matter_status_changed", deltas: [status] });
  if (stage) out.push({ type: "matter_stage_changed", deltas: [stage] });
  // A moving limitations date is the highest-stakes change in a PI matter, so
  // it gets its own event rather than hiding as one delta among several.
  if (sol) out.push({ type: "field_changed", deltas: [sol], isDateField: true });

  if (out.length === 0) {
    const deltas = [
      delta("responsibleAttorney", prev.responsibleAttorney, next.responsibleAttorney),
      delta("closeDate", prev.closeDate, next.closeDate),
    ].filter((item): item is FieldDelta => item !== null);
    out.push({ type: "matter_revised", deltas });
  }

  return out;
}

function classifyDocument(changeType: string, prev: Meta, next: Meta): Classified {
  if (changeType === "created") return { type: "document_added", deltas: [] };

  const version = delta(
    "version",
    (prev.latestVersion as { version_number?: unknown } | null)?.version_number,
    (next.latestVersion as { version_number?: unknown } | null)?.version_number,
  );
  const category = delta("category", prev.category, next.category);
  const deltas = [version, category].filter(
    (item): item is FieldDelta => item !== null,
  );
  return { type: "document_revised", deltas };
}

const SIMPLE_RULES: Record<string, { created: ChangeEventType; updated: ChangeEventType }> = {
  note: { created: "note_added", updated: "note_revised" },
  communication: { created: "communication_logged", updated: "communication_revised" },
  contact: { created: "contact_added", updated: "contact_revised" },
  activity: { created: "activity_logged", updated: "activity_revised" },
};

/**
 * Classify one revision. Returns several events only for a matter row, where a
 * status move and a limitations-date move are genuinely two separate things a
 * reader must act on.
 */
export function classifyRow(
  row: RevisionRow,
  context: { clioUrl: string | null; documentExisted?: boolean },
): ChangeEvent[] {
  const prev = parseMeta(row.prev_metadata);
  const next = parseMeta(row.new_metadata);
  const title = row.title ?? row.prev_title ?? `${row.kind} ${row.clio_id}`;

  if (row.change_type === "deleted" && row.kind !== "calendar_entry") {
    return [
      buildEvent(row, title, { type: "record_removed", deltas: [] }, context.clioUrl),
    ];
  }

  let classified: Classified[];

  switch (row.kind) {
    case "task":
      classified = [classifyTask(row.change_type, prev, next)];
      break;
    case "calendar_entry":
      classified = [classifyCalendar(row.change_type, prev, next)];
      break;
    case "custom_field":
      classified = [classifyCustomField(prev, next)];
      break;
    case "matter":
      classified =
        row.change_type === "created"
          ? [{ type: "matter_revised", deltas: [] }]
          : classifyMatter(prev, next);
      break;
    case "document":
      classified = [classifyDocument(row.change_type, prev, next)];
      break;
    case "document_page":
      // A page appearing under a document we already held is the OCR pass
      // finishing, not a new document arriving.
      classified = [
        {
          type: context.documentExisted ? "document_text_indexed" : "document_added",
          deltas: [],
        },
      ];
      break;
    default: {
      const rule = SIMPLE_RULES[row.kind];
      if (rule) {
        classified = [
          {
            type: row.change_type === "created" ? rule.created : rule.updated,
            deltas: [],
          },
        ];
      } else {
        classified = [
          {
            type: row.change_type === "created" ? "note_added" : "matter_revised",
            deltas: [],
          },
        ];
      }
    }
  }

  return classified.map((item) => buildEvent(row, title, item, context.clioUrl));
}

/* --- backdating and phrasing --------------------------------------------- */

export function isBackdated(
  occurredAt: string | null,
  observedAt: string,
  days = BACKDATE_DAYS,
): boolean {
  if (!occurredAt) return false;
  const occurred = Date.parse(occurredAt);
  const observed = Date.parse(observedAt);
  if (!Number.isFinite(occurred) || !Number.isFinite(observed)) return false;
  return observed - occurred > days * 86_400_000;
}

function day(iso: string | null): string | null {
  return iso ? iso.slice(0, 10) : null;
}

function renderDeltas(deltas: FieldDelta[]): string | null {
  if (deltas.length === 0) return null;
  return deltas
    .map((item) => `${item.field}: ${item.from ?? "(none)"} → ${item.to ?? "(none)"}`)
    .join("; ");
}

/**
 * The deterministic sentence for one change.
 *
 * Two phrasings, and the distinction matters more than it looks. A note dated
 * 2023 that landed in the file today is not news from 2023; writing it as
 * "on 7 May 2023 the firm..." would be a confident, cited, wrong statement
 * about when something happened.
 */
export function summarize(
  type: ChangeEventType,
  title: string,
  deltas: FieldDelta[],
  options: { occurredAt: string | null; observedAt: string; backdated: boolean },
): string {
  const label = LABEL_VERBS[type] ?? "Changed";
  const detail = renderDeltas(deltas);
  const occurred = day(options.occurredAt);
  const observed = day(options.observedAt);

  if (options.backdated && occurred && observed) {
    const base = `${label}: ${title} — dated ${occurred}, added to the file ${observed}`;
    return detail ? `${base} (${detail})` : base;
  }

  const base = `${label}: ${title}`;
  const dated = occurred ? `${base} (${occurred})` : base;
  return detail ? `${dated} — ${detail}` : dated;
}

const LABEL_VERBS: Record<ChangeEventType, string> = {
  matter_status_changed: "Matter status changed",
  matter_stage_changed: "Matter stage changed",
  matter_revised: "Matter details revised",
  field_changed: "Field changed",
  task_created: "New task",
  task_completed: "Task completed",
  task_reopened: "Task reopened",
  task_due_moved: "Task due date moved",
  task_reassigned: "Task reassigned",
  task_revised: "Task revised",
  calendar_added: "Calendar entry added",
  calendar_rescheduled: "Calendar entry rescheduled",
  calendar_cancelled: "Calendar entry removed",
  note_added: "Note added",
  note_revised: "Note revised",
  communication_logged: "Communication logged",
  communication_revised: "Communication revised",
  document_added: "Document added",
  document_revised: "Document revised",
  document_text_indexed: "Document text indexed",
  contact_added: "Contact added",
  contact_revised: "Contact revised",
  activity_logged: "Time or expense logged",
  activity_revised: "Time or expense revised",
  record_removed: "Removed from the file",
};

function buildEvent(
  row: RevisionRow,
  title: string,
  classified: Classified,
  clioUrl: string | null,
): ChangeEvent {
  const page = row.page > 0 ? row.page : null;
  const backdated = isBackdated(row.occurred_at, row.observed_at);

  return {
    ref: passageRef(row.kind, row.clio_id, page),
    type: classified.type,
    kind: row.kind,
    clioId: row.clio_id,
    page,
    title,
    summary: summarize(classified.type, title, classified.deltas, {
      occurredAt: row.occurred_at,
      observedAt: row.observed_at,
      backdated,
    }),
    occurredAt: row.occurred_at,
    observedAt: row.observed_at,
    clioUpdatedAt: row.clio_updated_at,
    backdated,
    deltas: classified.deltas,
    // A tombstone's only surviving text is what the revision kept.
    excerpt: row.excerpt ?? row.prev_excerpt ?? null,
    clioUrl,
    weight: eventWeight(classified.type, classified.isDateField),
  };
}

/* --- collapsing ----------------------------------------------------------- */

function entityKey(row: RevisionRow): string {
  return `${row.kind} ${row.clio_id} ${row.page}`;
}

/**
 * One event per record per window.
 *
 * Five syncs that each touched the same note are one change to a reader, and
 * leaving them separate would also break citations: every event carries the
 * record's `ref`, so duplicates would cite the same id five times.
 *
 * The collapse keeps the earliest `prev_*` and the latest `new_*`, which is
 * the net change across the window rather than the last hop of it. A record
 * created and then deleted inside one window is dropped entirely — it never
 * existed as far as this viewer is concerned, and "a note was added and then
 * removed" is noise dressed as news.
 */
export function collapseRevisions(rows: RevisionRow[]): RevisionRow[] {
  const byEntity = new Map<string, RevisionRow[]>();

  for (const row of rows) {
    const key = entityKey(row);
    const list = byEntity.get(key);
    if (list) list.push(row);
    else byEntity.set(key, [row]);
  }

  const collapsed: RevisionRow[] = [];

  for (const group of byEntity.values()) {
    // Oldest first, so "earliest prev" and "latest new" are just the ends.
    const ordered = [...group].sort((a, b) =>
      a.observed_at === b.observed_at
        ? a.id - b.id
        : a.observed_at < b.observed_at
          ? -1
          : 1,
    );

    const first = ordered[0];
    const last = ordered[ordered.length - 1];

    const created = ordered.some((row) => row.change_type === "created");
    const deleted = last.change_type === "deleted";
    if (created && deleted) continue;

    collapsed.push({
      ...last,
      // A record created and then edited inside the window is still new.
      change_type: created ? "created" : last.change_type,
      prev_title: first.prev_title,
      prev_excerpt: first.prev_excerpt,
      prev_metadata: created ? null : first.prev_metadata,
      prev_occurred_at: first.prev_occurred_at,
    });
  }

  return collapsed;
}
