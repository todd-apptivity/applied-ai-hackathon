/**
 * Typed reads against Clio Manage v4.
 *
 * Every function here is a GET. Clio returns a thin record unless you ask
 * for `fields`, so each call names the fields the pipeline needs. All
 * filters are generic (matter id, updated-since); nothing here names a
 * specific matter, person, or provider.
 */

import { clioFetch, clioGet, clioGetAll } from "./client";
import type {
  ClioActivity,
  ClioCalendar,
  ClioCalendarEntry,
  ClioCommunication,
  ClioContact,
  ClioCustomField,
  ClioDocument,
  ClioFolder,
  ClioMatter,
  ClioNote,
  ClioPracticeArea,
  ClioRelationship,
  ClioTask,
  ClioUser,
} from "./types";

const AUDIT = "created_at,updated_at";

// Clio's `fields` parser only supports one level of nesting, and refuses any
// nesting at all inside `custom_field_values`. Every spec below is flat
// within its sub-object; verified against the live API.
const MATTER_FIELDS = [
  "id,etag,number,display_number,description,status",
  "open_date,close_date,pending_date",
  // Clio models a matter's limitations date as an associated Task, not a date.
  "statute_of_limitations{id,name,due_at,status}",
  "client{id,name,type,primary_email_address,primary_phone_number}",
  "practice_area{id,name}",
  "matter_stage{id,name}",
  "responsible_attorney{id,name,email}",
  "originating_attorney{id,name,email}",
  "custom_field_values{id,field_type,field_name,value}",
  AUDIT,
].join(",");

const CONTACT_FIELDS = [
  "id,etag,name,type,first_name,last_name,prefix,title",
  "primary_email_address,primary_phone_number",
  "email_addresses{name,address,default_email}",
  "phone_numbers{name,number,default_number}",
  "addresses{name,street,city,province,postal_code,country}",
  AUDIT,
].join(",");

/** Flat subset, for embedding inside another record's sub-object. */
const CONTACT_SUMMARY_FIELDS = [
  "id,etag,name,type,first_name,last_name,prefix,title",
  "primary_email_address,primary_phone_number",
].join(",");

const NOTE_FIELDS = `id,etag,subject,detail,date,type,matter{id,display_number},${AUDIT}`;

const COMMUNICATION_FIELDS = [
  "id,etag,subject,body,type,date,received_at",
  "senders{id,name,type}",
  "receivers{id,name,type}",
  "matter{id,display_number}",
  AUDIT,
].join(",");

const TASK_FIELDS = [
  "id,etag,name,description,due_at,status,priority,completed_at",
  "statute_of_limitations",
  "assignee{id,name,type}",
  "matter{id,display_number}",
  AUDIT,
].join(",");

const CALENDAR_ENTRY_FIELDS = [
  "id,etag,summary,description,location,start_at,end_at,all_day",
  "calendar_owner{id,name}",
  "matter{id,display_number}",
  AUDIT,
].join(",");

const ACTIVITY_FIELDS = [
  "id,etag,type,date,quantity,price,total,note",
  "activity_description{id,name}",
  "matter{id,display_number}",
  AUDIT,
].join(",");

const DOCUMENT_FIELDS = [
  "id,etag,name,filename,content_type,size,received_at",
  "document_category{id,name}",
  "parent{id,name,type}",
  "matter{id,display_number}",
  "latest_document_version{id,version_number,received_at,fully_uploaded}",
  AUDIT,
].join(",");

/** Shared filters. `updatedSince` drives incremental refresh. */
export interface ReadOptions {
  /** ISO-8601 instant; only records changed at or after it are returned. */
  updatedSince?: string;
  signal?: AbortSignal;
}

function listParams(options: ReadOptions, extra: Record<string, unknown> = {}) {
  return {
    ...extra,
    ...(options.updatedSince ? { updated_since: options.updatedSince } : {}),
  } as Record<string, string | number | boolean | undefined>;
}

/* --- Account-level reads ------------------------------------------------ */

export function getCurrentUser(options: ReadOptions = {}): Promise<ClioUser> {
  return clioGet<ClioUser>("/users/who_am_i.json", {
    params: { fields: "id,etag,name,first_name,last_name,email,account{id,name}" },
    signal: options.signal,
  });
}

export function listPracticeAreas(
  options: ReadOptions = {},
): Promise<ClioPracticeArea[]> {
  return clioGetAll<ClioPracticeArea>("/practice_areas.json", {
    params: { fields: "id,etag,name,code" },
    signal: options.signal,
  });
}

export function listCalendars(options: ReadOptions = {}): Promise<ClioCalendar[]> {
  return clioGetAll<ClioCalendar>("/calendars.json", {
    params: { fields: "id,etag,name,type" },
    signal: options.signal,
  });
}

export function listCustomFields(
  options: ReadOptions = {},
): Promise<ClioCustomField[]> {
  return clioGetAll<ClioCustomField>("/custom_fields.json", {
    params: listParams(options, {
      fields: `id,etag,name,parent_type,field_type,displayed,deleted,${AUDIT}`,
    }),
    signal: options.signal,
  });
}

/* --- Matters ------------------------------------------------------------ */

export function listMatters(
  options: ReadOptions & { status?: string; query?: string } = {},
): Promise<ClioMatter[]> {
  return clioGetAll<ClioMatter>("/matters.json", {
    params: listParams(options, {
      fields: MATTER_FIELDS,
      status: options.status,
      query: options.query,
      order: "id(asc)",
    }),
    signal: options.signal,
  });
}

export function getMatter(
  matterId: number,
  options: ReadOptions = {},
): Promise<ClioMatter> {
  return clioGet<ClioMatter>(`/matters/${matterId}.json`, {
    params: { fields: MATTER_FIELDS },
    signal: options.signal,
  });
}

export function listMatterContacts(
  matterId: number,
  options: ReadOptions = {},
): Promise<ClioRelationship[]> {
  return clioGetAll<ClioRelationship>("/relationships.json", {
    params: listParams(options, {
      matter_id: matterId,
      fields: `id,etag,description,contact{${CONTACT_SUMMARY_FIELDS}},matter{id}`,
    }),
    signal: options.signal,
  });
}

export function getContact(
  contactId: number,
  options: ReadOptions = {},
): Promise<ClioContact> {
  return clioGet<ClioContact>(`/contacts/${contactId}.json`, {
    params: { fields: CONTACT_FIELDS },
    signal: options.signal,
  });
}

/* --- Matter children ---------------------------------------------------- */

export function listNotes(
  matterId: number,
  options: ReadOptions = {},
): Promise<ClioNote[]> {
  return clioGetAll<ClioNote>("/notes.json", {
    params: listParams(options, {
      // /notes.json rejects the request without an explicit parent type.
      type: "Matter",
      matter_id: matterId,
      fields: NOTE_FIELDS,
      order: "date(asc)",
    }),
    signal: options.signal,
  });
}

export function listCommunications(
  matterId: number,
  options: ReadOptions = {},
): Promise<ClioCommunication[]> {
  return clioGetAll<ClioCommunication>("/communications.json", {
    params: listParams(options, {
      matter_id: matterId,
      fields: COMMUNICATION_FIELDS,
      order: "date(asc)",
    }),
    signal: options.signal,
  });
}

export function listTasks(
  matterId: number,
  options: ReadOptions = {},
): Promise<ClioTask[]> {
  return clioGetAll<ClioTask>("/tasks.json", {
    params: listParams(options, {
      matter_id: matterId,
      fields: TASK_FIELDS,
      order: "due_at(asc)",
    }),
    signal: options.signal,
  });
}

export function listCalendarEntries(
  matterId: number,
  options: ReadOptions = {},
): Promise<ClioCalendarEntry[]> {
  return clioGetAll<ClioCalendarEntry>("/calendar_entries.json", {
    params: listParams(options, {
      matter_id: matterId,
      fields: CALENDAR_ENTRY_FIELDS,
      order: "start_at(asc)",
    }),
    signal: options.signal,
  });
}

/** Expenses and time entries both live on /activities. */
export function listActivities(
  matterId: number,
  options: ReadOptions & { type?: "TimeEntry" | "ExpenseEntry" } = {},
): Promise<ClioActivity[]> {
  return clioGetAll<ClioActivity>("/activities.json", {
    params: listParams(options, {
      matter_id: matterId,
      type: options.type,
      fields: ACTIVITY_FIELDS,
      order: "date(asc)",
    }),
    signal: options.signal,
  });
}

export function listExpenses(
  matterId: number,
  options: ReadOptions = {},
): Promise<ClioActivity[]> {
  return listActivities(matterId, { ...options, type: "ExpenseEntry" });
}

export function listFolders(
  matterId: number,
  options: ReadOptions = {},
): Promise<ClioFolder[]> {
  return clioGetAll<ClioFolder>("/folders.json", {
    params: listParams(options, {
      matter_id: matterId,
      fields: `id,etag,name,parent{id,name,type},matter{id},${AUDIT}`,
    }),
    signal: options.signal,
  });
}

export function listDocuments(
  matterId: number,
  options: ReadOptions = {},
): Promise<ClioDocument[]> {
  return clioGetAll<ClioDocument>("/documents.json", {
    params: listParams(options, {
      matter_id: matterId,
      fields: DOCUMENT_FIELDS,
      order: "id(asc)",
    }),
    signal: options.signal,
  });
}

/**
 * Stream a document's bytes. Clio answers with a redirect to storage, which
 * `fetch` follows. The caller owns the body (write to disk, hash, OCR).
 */
export async function downloadDocument(
  documentId: number,
  options: ReadOptions = {},
): Promise<{
  body: ReadableStream<Uint8Array> | null;
  contentType: string | null;
  contentLength: number | null;
}> {
  const response = await clioFetch(`/documents/${documentId}/download.json`, {
    signal: options.signal,
  });
  const length = Number(response.headers.get("content-length"));
  return {
    body: response.body,
    contentType: response.headers.get("content-type"),
    contentLength: Number.isFinite(length) ? length : null,
  };
}

/* --- Whole-matter pull -------------------------------------------------- */

export interface MatterBundle {
  matter: ClioMatter;
  relationships: ClioRelationship[];
  notes: ClioNote[];
  communications: ClioCommunication[];
  tasks: ClioTask[];
  calendarEntries: ClioCalendarEntry[];
  activities: ClioActivity[];
  folders: ClioFolder[];
  documents: ClioDocument[];
  /** Echoed back so the caller can store it as the next sync cursor. */
  updatedSince?: string;
  fetchedAt: string;
}

/**
 * Everything the ingestion pipeline needs for one matter, in one call.
 * Pass `updatedSince` to pull only records Clio changed since the last sync;
 * the matter record itself always comes back so the header stays current.
 */
export async function getMatterBundle(
  matterId: number,
  options: ReadOptions = {},
): Promise<MatterBundle> {
  const [
    matter,
    relationships,
    notes,
    communications,
    tasks,
    calendarEntries,
    activities,
    folders,
    documents,
  ] = await Promise.all([
    getMatter(matterId, { signal: options.signal }),
    listMatterContacts(matterId, options),
    listNotes(matterId, options),
    listCommunications(matterId, options),
    listTasks(matterId, options),
    listCalendarEntries(matterId, options),
    listActivities(matterId, options),
    listFolders(matterId, options),
    listDocuments(matterId, options),
  ]);

  return {
    matter,
    relationships,
    notes,
    communications,
    tasks,
    calendarEntries,
    activities,
    folders,
    documents,
    updatedSince: options.updatedSince,
    fetchedAt: new Date().toISOString(),
  };
}

/** Deep links back into Clio, for the source chips on every fact. */
export const clioLinks = {
  matter: (host: string, id: number) => `${host}/matters/${id}`,
  contact: (host: string, id: number) => `${host}/contacts/${id}`,
  document: (host: string, id: number) => `${host}/documents/${id}`,
  task: (host: string, id: number) => `${host}/tasks/${id}`,
  calendarEntry: (host: string, id: number) => `${host}/calendar/entry/${id}`,
  activity: (host: string, id: number) => `${host}/activities/${id}`,
};
