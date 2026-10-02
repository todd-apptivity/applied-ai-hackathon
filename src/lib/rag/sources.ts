/**
 * Clio records to retrievable sources.
 *
 * One source per atomic record. The `text` is a flattened, labelled rendering
 * of the record's own fields — labels included, because a chunk is retrieved
 * on its own and "Due: 2026-08-25" means something that a bare date does not.
 * `metadata` keeps the structured values so derived checks and source links do
 * not have to re-parse the prose.
 *
 * Mapping is purely structural: nothing here names a matter, person, provider,
 * custom field, or date.
 */

import { createHash } from "node:crypto";

import type { MatterBundle } from "@/lib/clio/resources";
import type {
  ClioActivity,
  ClioCalendarEntry,
  ClioCommunication,
  ClioContact,
  ClioDocument,
  ClioFolder,
  ClioMatter,
  ClioNote,
  ClioRef,
  ClioRelationship,
  ClioTask,
} from "@/lib/clio/types";
import { stripHtml } from "./chunk";

export type SourceKind =
  | "matter"
  | "custom_field"
  | "contact"
  | "note"
  | "communication"
  | "task"
  | "calendar_entry"
  | "activity"
  | "document"
  | "document_page";

export interface SourceRecord {
  matterId: number;
  kind: SourceKind;
  clioId: string;
  /** 0 for everything but `document_page`. */
  page: number;
  title: string;
  text: string;
  /** The record's own date, not when Clio last touched it. */
  occurredAt: string | null;
  clioUpdatedAt: string | null;
  metadata: Record<string, unknown>;
  /** True when Clio holds bytes we have not turned into text yet. */
  needsText: boolean;
}

export function hashContent(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/* --- rendering helpers --------------------------------------------------- */

type Field = [label: string, value: unknown];

/** Render `Label: value` lines, dropping anything empty. */
function lines(fields: Field[]): string[] {
  const out: string[] = [];
  for (const [label, value] of fields) {
    const rendered = renderValue(value);
    if (rendered !== null) out.push(`${label}: ${rendered}`);
  }
  return out;
}

function renderValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : null;
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (Array.isArray(value)) {
    const parts = value.map(renderValue).filter((part): part is string => part !== null);
    return parts.length > 0 ? parts.join(", ") : null;
  }
  if (typeof value === "object") {
    const ref = value as ClioRef;
    if (typeof ref.name === "string" && ref.name.trim().length > 0) return ref.name.trim();
    try {
      const json = JSON.stringify(value);
      return json === "{}" ? null : json;
    } catch {
      return null;
    }
  }
  return null;
}

function names(refs: ClioRef[] | undefined): string | null {
  if (!refs || refs.length === 0) return null;
  const list = refs.map((ref) => ref.name).filter(Boolean);
  return list.length > 0 ? list.join(", ") : null;
}

function body(...blocks: (string | null | undefined)[]): string {
  return blocks
    .map((block) => (typeof block === "string" ? block.trim() : ""))
    .filter((block) => block.length > 0)
    .join("\n\n");
}

/** Walk folder parents to a readable path, so a document says where it lives. */
function folderPath(folders: ClioFolder[], start: ClioRef | undefined): string | null {
  if (!start) return null;
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const segments: string[] = [];
  let current: ClioRef | undefined = start;

  // Bounded by the folder count: a cycle in Clio's parents cannot spin here.
  for (let depth = 0; current && depth <= folders.length + 1; depth += 1) {
    const folder = byId.get(current.id);
    const name = folder?.name ?? current.name;
    if (!name) break;
    segments.unshift(name);
    current = folder?.parent;
  }

  return segments.length > 0 ? segments.join(" / ") : null;
}

/* --- per-resource mapping ------------------------------------------------ */

function matterSource(matterId: number, matter: ClioMatter): SourceRecord {
  const text = body(
    lines([
      ["Matter", matter.display_number],
      ["Description", matter.description],
      ["Status", matter.status],
      ["Stage", matter.matter_stage?.name],
      ["Practice area", matter.practice_area?.name],
      ["Client", matter.client?.name],
      ["Client email", matter.client?.primary_email_address],
      ["Client phone", matter.client?.primary_phone_number],
      ["Responsible attorney", matter.responsible_attorney?.name],
      ["Originating attorney", matter.originating_attorney?.name],
      ["Opened", matter.open_date],
      ["Pending since", matter.pending_date],
      ["Closed", matter.close_date],
      ["Limitations task", matter.statute_of_limitations?.name],
      ["Limitations due", matter.statute_of_limitations?.due_at],
      ["Limitations task status", matter.statute_of_limitations?.status],
    ]).join("\n"),
  );

  return {
    matterId,
    kind: "matter",
    clioId: String(matter.id),
    page: 0,
    title: matter.display_number ?? `Matter ${matter.id}`,
    text,
    occurredAt: matter.open_date ?? null,
    clioUpdatedAt: matter.updated_at ?? null,
    needsText: false,
    metadata: {
      displayNumber: matter.display_number ?? null,
      status: matter.status ?? null,
      stage: matter.matter_stage?.name ?? null,
      practiceArea: matter.practice_area?.name ?? null,
      clientId: matter.client?.id ?? null,
      clientName: matter.client?.name ?? null,
      responsibleAttorney: matter.responsible_attorney?.name ?? null,
      openDate: matter.open_date ?? null,
      closeDate: matter.close_date ?? null,
      statuteOfLimitations: matter.statute_of_limitations ?? null,
    },
  };
}

/**
 * Each custom field value is its own source. Grouping them into one blob would
 * make a single chunk that matches every field query equally; split, a field
 * and its value retrieve as a unit and carry their own provenance.
 */
function customFieldSources(matterId: number, matter: ClioMatter): SourceRecord[] {
  const sources: SourceRecord[] = [];

  for (const field of matter.custom_field_values ?? []) {
    const value = renderValue(field.value);
    const name = field.field_name?.trim();
    if (!name || value === null) continue;

    sources.push({
      matterId,
      kind: "custom_field",
      clioId: field.id,
      page: 0,
      title: name,
      text: `${name}: ${value}`,
      occurredAt: field.field_type === "date" ? value : null,
      clioUpdatedAt: matter.updated_at ?? null,
      needsText: false,
      metadata: {
        fieldName: name,
        fieldType: field.field_type ?? null,
        value: field.value ?? null,
        matterId,
      },
    });
  }

  return sources;
}

/** Render an address sub-object without assuming which parts Clio filled in. */
function addressLine(address: Record<string, unknown>): string | null {
  const parts = ["street", "city", "province", "postal_code", "country"]
    .map((key) => renderValue(address[key]))
    .filter((part): part is string => part !== null);
  if (parts.length === 0) return null;
  const label = renderValue(address.name);
  return label ? `${label}: ${parts.join(", ")}` : parts.join(", ");
}

/**
 * A contact source.
 *
 * `role` comes from the matter relationship when there is one. The client is a
 * structural exception: Clio exposes it as `matter.client` and does not list it
 * among `/relationships`, so it has no relationship description to borrow.
 */
export function contactSource(
  matterId: number,
  contact: ClioContact,
  options: { role?: string | null; isClient?: boolean } = {},
): SourceRecord {
  const role = options.role ?? (options.isClient ? "Client on this matter" : null);

  const emails = (contact.email_addresses ?? [])
    .map((entry) => (entry.address ? `${entry.name ?? "email"}: ${entry.address}` : null))
    .filter((entry): entry is string => entry !== null);
  const phones = (contact.phone_numbers ?? [])
    .map((entry) => (entry.number ? `${entry.name ?? "phone"}: ${entry.number}` : null))
    .filter((entry): entry is string => entry !== null);
  const addresses = (contact.addresses ?? [])
    .map(addressLine)
    .filter((entry): entry is string => entry !== null);

  const text = body(
    lines([
      ["Contact", contact.name],
      ["Role on matter", role],
      ["Type", contact.type],
      ["Title", contact.title],
      ["Email", contact.primary_email_address],
      ["Phone", contact.primary_phone_number],
      ["Other emails", emails.length > 0 ? emails : null],
      ["Other phones", phones.length > 0 ? phones : null],
      ["Addresses", addresses.length > 0 ? addresses : null],
    ]).join("\n"),
  );

  return {
    matterId,
    kind: "contact",
    clioId: String(contact.id),
    page: 0,
    title: contact.name ?? `Contact ${contact.id}`,
    text,
    occurredAt: null,
    clioUpdatedAt: contact.updated_at ?? null,
    needsText: false,
    metadata: {
      contactId: contact.id,
      name: contact.name ?? null,
      role,
      isClient: options.isClient ?? false,
      type: contact.type ?? null,
      email: contact.primary_email_address ?? null,
      phone: contact.primary_phone_number ?? null,
      emails,
      phones,
      addresses: contact.addresses ?? [],
    },
  };
}

/** The role each related contact plays, keyed by contact id. */
export function contactRoles(relationships: ClioRelationship[]): Map<number, string | null> {
  const roles = new Map<number, string | null>();
  for (const relationship of relationships) {
    if (relationship.contact) {
      roles.set(relationship.contact.id, relationship.description ?? null);
    }
  }
  return roles;
}

function noteSource(matterId: number, note: ClioNote): SourceRecord {
  const text = body(
    lines([
      ["Note", note.subject],
      ["Date", note.date],
    ]).join("\n"),
    stripHtml(note.detail ?? ""),
  );

  return {
    matterId,
    kind: "note",
    clioId: String(note.id),
    page: 0,
    title: note.subject ?? `Note ${note.id}`,
    text,
    occurredAt: note.date ?? null,
    clioUpdatedAt: note.updated_at ?? null,
    needsText: false,
    metadata: {
      subject: note.subject ?? null,
      date: note.date ?? null,
      noteType: note.type ?? null,
    },
  };
}

function communicationSource(matterId: number, item: ClioCommunication): SourceRecord {
  const text = body(
    lines([
      ["Communication", item.subject],
      ["Kind", item.type],
      ["Date", item.date ?? item.received_at],
      ["From", names(item.senders)],
      ["To", names(item.receivers)],
    ]).join("\n"),
    stripHtml(item.body ?? ""),
  );

  return {
    matterId,
    kind: "communication",
    clioId: String(item.id),
    page: 0,
    title: item.subject ?? `${item.type ?? "Communication"} ${item.id}`,
    text,
    occurredAt: item.date ?? item.received_at ?? null,
    clioUpdatedAt: item.updated_at ?? null,
    needsText: false,
    metadata: {
      subject: item.subject ?? null,
      communicationType: item.type ?? null,
      date: item.date ?? null,
      receivedAt: item.received_at ?? null,
      senders: (item.senders ?? []).map((ref) => ({ id: ref.id, name: ref.name ?? null })),
      receivers: (item.receivers ?? []).map((ref) => ({ id: ref.id, name: ref.name ?? null })),
    },
  };
}

function taskSource(matterId: number, task: ClioTask): SourceRecord {
  const text = body(
    lines([
      ["Task", task.name],
      ["Status", task.status],
      ["Due", task.due_at],
      ["Completed", task.completed_at],
      ["Priority", task.priority],
      ["Assignee", task.assignee?.name],
      ["Limitations task", task.statute_of_limitations],
    ]).join("\n"),
    task.description ? stripHtml(task.description) : null,
  );

  return {
    matterId,
    kind: "task",
    clioId: String(task.id),
    page: 0,
    title: task.name ?? `Task ${task.id}`,
    text,
    occurredAt: task.due_at ?? null,
    clioUpdatedAt: task.updated_at ?? null,
    needsText: false,
    metadata: {
      name: task.name ?? null,
      status: task.status ?? null,
      dueAt: task.due_at ?? null,
      completedAt: task.completed_at ?? null,
      priority: task.priority ?? null,
      assignee: task.assignee ? { id: task.assignee.id, name: task.assignee.name ?? null } : null,
      statuteOfLimitations: task.statute_of_limitations ?? false,
    },
  };
}

function calendarEntrySource(matterId: number, entry: ClioCalendarEntry): SourceRecord {
  const text = body(
    lines([
      ["Calendar entry", entry.summary],
      ["Starts", entry.start_at],
      ["Ends", entry.end_at],
      ["All day", entry.all_day],
      ["Location", entry.location],
      ["Owner", entry.calendar_owner?.name],
    ]).join("\n"),
    entry.description ? stripHtml(entry.description) : null,
  );

  return {
    matterId,
    kind: "calendar_entry",
    clioId: String(entry.id),
    page: 0,
    title: entry.summary ?? `Calendar entry ${entry.id}`,
    text,
    occurredAt: entry.start_at ?? null,
    clioUpdatedAt: entry.updated_at ?? null,
    needsText: false,
    metadata: {
      summary: entry.summary ?? null,
      startAt: entry.start_at ?? null,
      endAt: entry.end_at ?? null,
      allDay: entry.all_day ?? false,
      location: entry.location ?? null,
      owner: entry.calendar_owner
        ? { id: entry.calendar_owner.id, name: entry.calendar_owner.name ?? null }
        : null,
    },
  };
}

function activitySource(matterId: number, activity: ClioActivity): SourceRecord {
  const text = body(
    lines([
      ["Activity", activity.activity_description?.name],
      ["Kind", activity.type],
      ["Date", activity.date],
      ["Quantity", activity.quantity],
      ["Price", activity.price],
      ["Total", activity.total],
    ]).join("\n"),
    activity.note ? stripHtml(activity.note) : null,
  );

  return {
    matterId,
    kind: "activity",
    clioId: String(activity.id),
    page: 0,
    title: activity.activity_description?.name ?? `${activity.type ?? "Activity"} ${activity.id}`,
    text,
    occurredAt: activity.date ?? null,
    clioUpdatedAt: activity.updated_at ?? null,
    needsText: false,
    metadata: {
      activityType: activity.type ?? null,
      description: activity.activity_description?.name ?? null,
      date: activity.date ?? null,
      quantity: activity.quantity ?? null,
      price: activity.price ?? null,
      total: activity.total ?? null,
    },
  };
}

/**
 * A document's metadata is itself retrievable — name, category, folder path,
 * and received date answer "do we have X on file?". The bytes are a separate
 * step: `needsText` is set so the text/OCR pass can find every document whose
 * pages have not been indexed yet and add `document_page` sources.
 */
function documentSource(
  matterId: number,
  document: ClioDocument,
  folders: ClioFolder[],
  hasPages: boolean,
): SourceRecord {
  const path = folderPath(folders, document.parent);

  const text = body(
    lines([
      ["Document", document.name],
      ["Filename", document.filename],
      ["Category", document.document_category?.name],
      ["Folder", path],
      ["Received", document.received_at],
      ["Content type", document.content_type],
      ["Size (bytes)", document.size],
      ["Version", document.latest_document_version?.version_number],
    ]).join("\n"),
  );

  return {
    matterId,
    kind: "document",
    clioId: String(document.id),
    page: 0,
    title: document.name ?? document.filename ?? `Document ${document.id}`,
    text,
    occurredAt: document.received_at ?? null,
    clioUpdatedAt: document.updated_at ?? null,
    needsText: !hasPages,
    metadata: {
      name: document.name ?? null,
      filename: document.filename ?? null,
      category: document.document_category?.name ?? null,
      folderPath: path,
      receivedAt: document.received_at ?? null,
      contentType: document.content_type ?? null,
      size: document.size ?? null,
      latestVersion: document.latest_document_version ?? null,
    },
  };
}

/** One source per page of extracted or OCR'd document text. */
export function documentPageSources(
  matterId: number,
  document: Pick<ClioDocument, "id" | "name" | "filename" | "updated_at" | "received_at">,
  pages: { page: number; text: string; viaOcr?: boolean }[],
): SourceRecord[] {
  const label = document.name ?? document.filename ?? `Document ${document.id}`;

  return pages
    .filter((page) => page.text.trim().length > 0)
    .map((page) => ({
      matterId,
      kind: "document_page" as const,
      clioId: String(document.id),
      page: page.page,
      title: `${label} — page ${page.page}`,
      text: body(`Document: ${label}\nPage: ${page.page}`, page.text),
      occurredAt: document.received_at ?? null,
      clioUpdatedAt: document.updated_at ?? null,
      needsText: false,
      metadata: {
        documentId: document.id,
        documentName: label,
        page: page.page,
        viaOcr: page.viaOcr ?? false,
      },
    }));
}

/* --- bundle ------------------------------------------------------------- */

/**
 * Flatten a whole matter bundle into sources.
 *
 * `documentsWithPages` lets the caller say which documents already have page
 * text indexed, so a refresh does not reset their `needsText` flag.
 *
 * `contacts` carries fully-populated contact records (addresses, alternate
 * emails and phones) that the relationship read does not return, plus the
 * client, which Clio omits from `/relationships` entirely. Without them the
 * contact sources fall back to the thin summary embedded in each relationship.
 */
export function bundleToSources(
  bundle: MatterBundle,
  options: {
    documentsWithPages?: ReadonlySet<string>;
    contacts?: ClioContact[];
  } = {},
): SourceRecord[] {
  const matterId = bundle.matter.id;
  const withPages = options.documentsWithPages ?? new Set<string>();
  const roles = contactRoles(bundle.relationships);
  const clientId = bundle.matter.client?.id;

  // Prefer the full record for a contact; fall back to the relationship's
  // summary, and include the client even when only the summary exists.
  const byId = new Map<number, ClioContact>();
  for (const relationship of bundle.relationships) {
    if (relationship.contact) byId.set(relationship.contact.id, relationship.contact);
  }
  if (bundle.matter.client) byId.set(bundle.matter.client.id, bundle.matter.client);
  for (const contact of options.contacts ?? []) byId.set(contact.id, contact);

  const sources: SourceRecord[] = [
    matterSource(matterId, bundle.matter),
    ...customFieldSources(matterId, bundle.matter),
    ...[...byId.values()].map((contact) =>
      contactSource(matterId, contact, {
        role: roles.get(contact.id) ?? null,
        isClient: contact.id === clientId,
      }),
    ),
    ...bundle.notes.map((note) => noteSource(matterId, note)),
    ...bundle.communications.map((item) => communicationSource(matterId, item)),
    ...bundle.tasks.map((task) => taskSource(matterId, task)),
    ...bundle.calendarEntries.map((entry) => calendarEntrySource(matterId, entry)),
    ...bundle.activities.map((activity) => activitySource(matterId, activity)),
    ...bundle.documents.map((document) =>
      documentSource(matterId, document, bundle.folders, withPages.has(String(document.id))),
    ),
  ];

  // A record with no renderable field would index as an empty chunk.
  return sources.filter((source) => source.text.trim().length > 0);
}
