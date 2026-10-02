/**
 * Pulls everything the RAG index needs for one matter from Clio, using GET
 * requests only, and maps it into source-neutral inputs.
 *
 * The `fields` lists follow Clio API v4 conventions (nested resources in
 * braces, one level deep). They are kept here in one place so they are easy
 * to adjust if a Clio account returns a 400 for a field.
 */
import { buildCaseRecords, type MatterParts } from "../rag/records";
import type { MatterSnapshot } from "../rag/ingest";
import type { CaseDocument } from "../rag/types";
import { toLocalDate } from "../rag/util";
import { ClioClient } from "./client";

export const CLIO_FIELDS = {
  matter:
    "id,display_number,description,status,open_date,close_date,updated_at," +
    "client{id,name},practice_area{id,name},matter_stage{id,name}," +
    "statute_of_limitations{id,due_at,status}",
  customFieldValues: "custom_field_values{id,field_name,field_type,value,updated_at}",
  relationships: "id,description,contact{id,name}",
  contact:
    "id,name,type,title,date_of_birth,updated_at,company{id,name}," +
    "email_addresses{address,name},phone_numbers{number,name}," +
    "addresses{street,city,province,postal_code,country,name}",
  notes: "id,subject,detail,date,updated_at,author{id,name}",
  communications: "id,type,subject,body,date,updated_at,senders{id,name,type},receivers{id,name,type}",
  tasks: "id,name,description,status,priority,due_at,completed_at,statute_of_limitations,updated_at,assignee{id,name}",
  calendarEntries: "id,summary,description,location,start_at,end_at,all_day,updated_at",
  expenses: "id,type,date,quantity,price,total,note,updated_at",
  documents:
    "id,name,received_at,updated_at,parent{id,name,type},latest_document_version{id,uuid,updated_at}",
} as const;

type Named = { id?: number | string; name?: string | null; type?: string | null } | null | undefined;

interface ClioMatter {
  id: number;
  display_number?: string;
  description?: string;
  status?: string;
  open_date?: string;
  close_date?: string;
  updated_at?: string;
  client?: Named;
  practice_area?: Named;
  matter_stage?: Named;
  statute_of_limitations?: { due_at?: string; status?: string } | string | null;
  custom_field_values?: Array<{ id: string | number; field_name?: string; value?: unknown; updated_at?: string }>;
}

interface ClioContact {
  id: number;
  name: string;
  type?: string;
  title?: string;
  date_of_birth?: string;
  updated_at?: string;
  company?: Named;
  email_addresses?: Array<{ address?: string; name?: string }>;
  phone_numbers?: Array<{ number?: string; name?: string }>;
  addresses?: Array<{
    street?: string;
    city?: string;
    province?: string;
    postal_code?: string;
    country?: string;
    name?: string;
  }>;
}

export async function fetchMatterSnapshot(
  client: ClioClient,
  matterId: string,
): Promise<MatterSnapshot> {
  const scope = { matter_id: matterId };
  const [matter, withFields, relationships, notes, communications, tasks, calendarEntries, expenses, documents] =
    await Promise.all([
      client.getOne<ClioMatter>(`/matters/${matterId}.json`, { fields: CLIO_FIELDS.matter }),
      client.getOne<ClioMatter>(`/matters/${matterId}.json`, { fields: CLIO_FIELDS.customFieldValues }),
      client.getAll<{ id: number; description?: string; contact?: Named }>("/relationships.json", {
        ...scope,
        fields: CLIO_FIELDS.relationships,
      }),
      client.getAll<{ id: number; subject?: string; detail?: string; date?: string; updated_at?: string; author?: Named }>(
        "/notes.json",
        { ...scope, type: "Matter", fields: CLIO_FIELDS.notes },
      ),
      client.getAll<{
        id: number;
        type?: string;
        subject?: string;
        body?: string;
        date?: string;
        updated_at?: string;
        senders?: Named[];
        receivers?: Named[];
      }>("/communications.json", { ...scope, fields: CLIO_FIELDS.communications }),
      client.getAll<{
        id: number;
        name?: string;
        description?: string;
        status?: string;
        priority?: string;
        due_at?: string;
        completed_at?: string;
        statute_of_limitations?: boolean;
        updated_at?: string;
        assignee?: Named;
      }>("/tasks.json", { ...scope, fields: CLIO_FIELDS.tasks }),
      client.getAll<{
        id: number;
        summary?: string;
        description?: string;
        location?: string;
        start_at?: string;
        end_at?: string;
        all_day?: boolean;
        updated_at?: string;
      }>("/calendar_entries.json", { ...scope, fields: CLIO_FIELDS.calendarEntries }),
      client.getAll<{
        id: number;
        date?: string;
        quantity?: number;
        price?: number;
        total?: number;
        note?: string;
        updated_at?: string;
      }>("/activities.json", { ...scope, type: "ExpenseEntry", fields: CLIO_FIELDS.expenses }),
      client.getAll<{
        id: number;
        name: string;
        received_at?: string;
        updated_at?: string;
        parent?: Named;
        latest_document_version?: { id?: number; uuid?: string; updated_at?: string } | null;
      }>("/documents.json", { ...scope, fields: CLIO_FIELDS.documents }),
    ]);

  // The client is a contact too; make sure it is included even without a relationship row.
  const roles = new Map<string, string>();
  if (matter.client?.id !== undefined) roles.set(String(matter.client.id), "Client");
  for (const rel of relationships) {
    if (rel.contact?.id === undefined) continue;
    const id = String(rel.contact.id);
    roles.set(id, [roles.get(id), rel.description].filter(Boolean).join("; "));
  }
  const contacts = await Promise.all(
    [...roles.keys()].map((id) =>
      client.getOne<ClioContact>(`/contacts/${id}.json`, { fields: CLIO_FIELDS.contact }),
    ),
  );

  const sol = matter.statute_of_limitations;
  const parts: MatterParts = {
    matter: {
      id: String(matter.id),
      displayNumber: matter.display_number,
      description: matter.description,
      status: matter.status,
      clientName: matter.client?.name,
      practiceArea: matter.practice_area?.name,
      stage: matter.matter_stage?.name,
      openDate: matter.open_date,
      closeDate: matter.close_date,
      statuteOfLimitations: typeof sol === "string" ? sol : sol?.due_at,
      statuteOfLimitationsStatus: typeof sol === "object" ? sol?.status : null,
      updatedAt: matter.updated_at,
    },
    customFields: (withFields.custom_field_values ?? []).map((v) => ({
      id: String(v.id),
      name: v.field_name ?? "Custom field",
      value: v.value,
      updatedAt: v.updated_at,
    })),
    contacts: contacts.map((c) => ({
      id: String(c.id),
      name: c.name,
      role: roles.get(String(c.id)) || null,
      type: c.type,
      title: c.title,
      company: c.company?.name,
      dateOfBirth: c.date_of_birth,
      emails: (c.email_addresses ?? []).map((e) => e.address).filter(isString),
      phones: (c.phone_numbers ?? []).map((p) => p.number).filter(isString),
      addresses: (c.addresses ?? []).map(formatAddress).filter(Boolean),
      updatedAt: c.updated_at,
    })),
    notes: notes.map((n) => ({
      id: String(n.id),
      subject: n.subject,
      detail: n.detail,
      date: n.date,
      author: n.author?.name,
      updatedAt: n.updated_at,
    })),
    communications: communications.map((c) => ({
      id: String(c.id),
      type: c.type,
      subject: c.subject,
      body: c.body,
      date: c.date,
      senders: (c.senders ?? []).map(participantName),
      receivers: (c.receivers ?? []).map(participantName),
      updatedAt: c.updated_at,
    })),
    tasks: tasks.map((t) => ({
      id: String(t.id),
      name: t.name,
      description: t.description,
      status: t.status,
      priority: t.priority,
      dueAt: t.due_at,
      completedAt: t.completed_at,
      assignee: t.assignee?.name,
      isStatuteOfLimitations: t.statute_of_limitations,
      updatedAt: t.updated_at,
    })),
    calendarEntries: calendarEntries.map((e) => ({
      id: String(e.id),
      summary: e.summary,
      description: e.description,
      location: e.location,
      startAt: e.start_at,
      endAt: e.end_at,
      allDay: e.all_day,
      updatedAt: e.updated_at,
    })),
    expenses: expenses.map((x) => ({
      id: String(x.id),
      date: x.date,
      quantity: x.quantity,
      price: x.price,
      total: x.total,
      note: x.note,
      updatedAt: x.updated_at,
    })),
  };

  const caseDocuments: CaseDocument[] = documents
    .filter((d) => /\.pdf$/i.test(d.name))
    .map((d) => ({
      matterId: String(matter.id),
      documentId: String(d.id),
      name: d.name,
      folder: d.parent?.type === "Folder" ? (d.parent.name ?? null) : null,
      receivedDate: toLocalDate(d.received_at),
      versionKey: `clio:${d.id}:${d.latest_document_version?.uuid ?? d.latest_document_version?.id ?? d.updated_at}`,
      load: () => client.download(d.id),
    }));

  return { matterId: String(matter.id), records: buildCaseRecords(parts), documents: caseDocuments };
}

function participantName(p: Named): string {
  return p?.name ?? `${p?.type ?? "Participant"} ${p?.id ?? ""}`.trim();
}

function formatAddress(a: NonNullable<ClioContact["addresses"]>[number]): string {
  return [a.street, a.city, [a.province, a.postal_code].filter(Boolean).join(" "), a.country]
    .filter(Boolean)
    .join(", ");
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
