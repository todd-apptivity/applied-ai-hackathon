/**
 * The wire shape of a change, between the changeset query and the UI.
 *
 * Types and pure helpers only. The browser bundle imports this, so — like
 * `@/lib/chat/types` — it must not reach anything that touches `node:sqlite`,
 * the filesystem, or the Clio client. A change arrives with its Clio URL
 * already built rather than with the ingredients to build one.
 */

import type { ResolvedWindow } from "./checkpoint";

/**
 * What happened, in terms a lawyer recognises rather than terms the database
 * does. "A row's hash changed" is true and useless; "the limitations date
 * moved" is the thing someone needs to see.
 */
export type ChangeEventType =
  | "matter_status_changed"
  | "matter_stage_changed"
  | "matter_revised"
  | "field_changed"
  | "task_created"
  | "task_completed"
  | "task_reopened"
  | "task_due_moved"
  | "task_reassigned"
  | "task_revised"
  | "calendar_added"
  | "calendar_rescheduled"
  | "calendar_cancelled"
  | "note_added"
  | "note_revised"
  | "communication_logged"
  | "communication_revised"
  | "document_added"
  | "document_revised"
  | "document_text_indexed"
  | "contact_added"
  | "contact_revised"
  | "activity_logged"
  | "activity_revised"
  | "record_removed";

export interface FieldDelta {
  field: string;
  from: string | null;
  to: string | null;
}

export interface ChangeEvent {
  /**
   * Citation key, from `passageRef` — the same `note:4821` /
   * `document_page:9912#p47` the chat agent cites, so a digest citation and a
   * chat citation are the same object and resolve through the same link.
   */
  ref: string;
  type: ChangeEventType;
  kind: string;
  clioId: string;
  page: number | null;
  title: string;
  /**
   * A plain-code description of the change. The model may reword it but may not
   * contradict it, and it is what the panel falls back to when there is no
   * model available at all.
   */
  summary: string;
  /** When it happened in the world. */
  occurredAt: string | null;
  /** When we learned. */
  observedAt: string;
  clioUpdatedAt: string | null;
  /**
   * True when `occurredAt` predates `observedAt` by more than
   * `BACKDATE_DAYS` — a record about an old event, added to the file recently.
   * Reporting those as if they just happened is the single most misleading
   * thing a change digest can do.
   */
  backdated: boolean;
  deltas: FieldDelta[];
  excerpt: string | null;
  clioUrl: string | null;
  /** Significance, for ordering. Decided by code, never by the model. */
  weight: number;
}

export interface ChangeCounts {
  total: number;
  byType: Partial<Record<ChangeEventType, number>>;
  byKind: Record<string, number>;
}

export interface Changeset {
  matterId: number;
  window: ResolvedWindow;
  events: ChangeEvent[];
  counts: ChangeCounts;
  history: {
    /** Instant from which the change log is complete, or null if never. */
    startsAt: string | null;
    /** True when the window reaches back past `startsAt`. */
    truncated: boolean;
  };
  /** True when events came from the fallback, not the change log. */
  degraded: boolean;
  /** How many records the matter holds in total, for the "no history" case. */
  totalSources: number;
  /** Hash of (kinds, window start, events). The digest cache key. */
  fingerprint: string;
}

/** A record older than this, newly added, is reported as backdated. */
export const BACKDATE_DAYS = 14;

export const EVENT_LABELS: Record<ChangeEventType, string> = {
  matter_status_changed: "Matter status changed",
  matter_stage_changed: "Matter stage changed",
  matter_revised: "Matter details revised",
  field_changed: "Matter field changed",
  task_created: "Task created",
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
  record_removed: "Record removed from the file",
};

export function eventLabel(type: ChangeEventType): string {
  return EVENT_LABELS[type] ?? type;
}

export function emptyCounts(): ChangeCounts {
  return { total: 0, byType: {}, byKind: {} };
}

export function countEvents(events: ChangeEvent[]): ChangeCounts {
  const counts = emptyCounts();
  for (const event of events) {
    counts.total += 1;
    counts.byType[event.type] = (counts.byType[event.type] ?? 0) + 1;
    counts.byKind[event.kind] = (counts.byKind[event.kind] ?? 0) + 1;
  }
  return counts;
}
