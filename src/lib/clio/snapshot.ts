/**
 * Maps a Clio matter bundle (see resources.ts) into the source-neutral
 * records the RAG index is built from. All reads go through the read-only
 * client; nothing here talks to Clio directly.
 */
import { buildCaseRecords, type MatterParts } from "../rag/records";
import type { MatterSnapshot } from "../rag/ingest";
import type { CaseDocument } from "../rag/types";
import { toLocalDate } from "../rag/util";
import { downloadDocument, getMatterBundle } from "./resources";
import type { ClioContact, ClioRef } from "./types";

export async function fetchMatterSnapshot(matterId: number): Promise<MatterSnapshot> {
  const bundle = await getMatterBundle(matterId);
  const { matter } = bundle;
  const id = String(matter.id);

  // The client is a contact too; include it even without a relationship row.
  const contacts = new Map<number, { contact: ClioContact; roles: string[] }>();
  const addContact = (contact: ClioContact | undefined, role: string | undefined) => {
    if (!contact?.id) return;
    const entry = contacts.get(contact.id) ?? { contact, roles: [] };
    if (role && !entry.roles.includes(role)) entry.roles.push(role);
    // Prefer the fuller record from the relationship over the matter's client stub.
    entry.contact = { ...entry.contact, ...contact };
    contacts.set(contact.id, entry);
  };
  addContact(matter.client, "Client");
  for (const rel of bundle.relationships) addContact(rel.contact, rel.description);

  // Clio returns the limitations date as an associated Task.
  const sol = matter.statute_of_limitations;

  const parts: MatterParts = {
    matter: {
      id,
      displayNumber: matter.display_number,
      description: matter.description,
      status: matter.status,
      clientName: matter.client?.name,
      practiceArea: matter.practice_area?.name,
      stage: matter.matter_stage?.name,
      openDate: matter.open_date,
      closeDate: matter.close_date,
      statuteOfLimitations: sol?.due_at,
      statuteOfLimitationsStatus: sol?.status,
      updatedAt: matter.updated_at,
    },
    customFields: (matter.custom_field_values ?? []).map((v) => ({
      id: String(v.id),
      name: v.field_name ?? "Custom field",
      value: v.value,
    })),
    contacts: [...contacts.values()].map(({ contact: c, roles }) => ({
      id: String(c.id),
      name: c.name ?? [c.first_name, c.last_name].filter(Boolean).join(" "),
      role: roles.join("; ") || null,
      type: c.type,
      title: c.title,
      emails: uniq([c.primary_email_address, ...(c.email_addresses ?? []).map((e) => e.address)]),
      phones: uniq([c.primary_phone_number, ...(c.phone_numbers ?? []).map((p) => p.number)]),
      addresses: uniq((c.addresses ?? []).map(formatAddress)),
      updatedAt: c.updated_at,
    })),
    notes: bundle.notes.map((n) => ({
      id: String(n.id),
      subject: n.subject,
      detail: n.detail,
      date: n.date,
      updatedAt: n.updated_at,
    })),
    communications: bundle.communications.map((c) => ({
      id: String(c.id),
      type: c.type,
      subject: c.subject,
      body: c.body,
      date: c.date ?? c.received_at,
      senders: (c.senders ?? []).map(participantName),
      receivers: (c.receivers ?? []).map(participantName),
      updatedAt: c.updated_at,
    })),
    tasks: bundle.tasks.map((t) => ({
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
    calendarEntries: bundle.calendarEntries.map((e) => ({
      id: String(e.id),
      summary: e.summary,
      description: e.description,
      location: e.location,
      startAt: e.start_at,
      endAt: e.end_at,
      allDay: e.all_day,
      updatedAt: e.updated_at,
    })),
    expenses: bundle.activities
      .filter((a) => a.type === "ExpenseEntry")
      .map((x) => ({
        id: String(x.id),
        date: x.date,
        quantity: x.quantity,
        price: x.price,
        total: x.total,
        note: x.note,
        updatedAt: x.updated_at,
      })),
  };

  const documents: CaseDocument[] = bundle.documents
    .filter((d) => /\.pdf$/i.test(d.name ?? d.filename ?? "") || d.content_type === "application/pdf")
    .map((d) => ({
      matterId: id,
      documentId: String(d.id),
      name: d.name ?? d.filename ?? `Document ${d.id}`,
      folder: d.parent?.type === "Folder" ? (d.parent.name ?? null) : null,
      receivedDate: toLocalDate(d.received_at),
      versionKey: `clio:${d.id}:${d.latest_document_version?.id ?? d.updated_at ?? d.etag}`,
      load: async () => {
        const { body } = await downloadDocument(d.id);
        return new Uint8Array(await new Response(body).arrayBuffer());
      },
    }));

  return { matterId: id, records: buildCaseRecords(parts), documents };
}

function participantName(p: ClioRef): string {
  return p.name ?? `${p.type ?? "Participant"} ${p.id}`;
}

function formatAddress(a: Record<string, unknown>): string {
  const s = (key: string) => (typeof a[key] === "string" ? (a[key] as string) : "");
  return [s("street"), s("city"), [s("province"), s("postal_code")].filter(Boolean).join(" "), s("country")]
    .filter(Boolean)
    .join(", ");
}

function uniq(values: Array<string | undefined | null>): string[] {
  return [...new Set(values.filter((v): v is string => !!v))];
}
