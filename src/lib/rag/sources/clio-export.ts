/**
 * Loads a matter from a Clio setup export: a JSON file of Clio API v4 request
 * bodies with "{{...}}" placeholders for ids, plus the PDFs it references.
 *
 * This is for development and tests, when the Clio API is not reachable. The
 * production path is fetchMatterSnapshot in src/lib/clio/snapshot.ts, which
 * reads the matter live from Clio.
 */
import fs from "node:fs";
import path from "node:path";
import { buildCaseRecords, type MatterParts } from "../records";
import type { MatterSnapshot } from "../ingest";
import type { CaseDocument } from "../types";
import { sha256, toLocalDate } from "../util";

interface Ref {
  id?: unknown;
  type?: string;
}

interface ExportItem<T> {
  ref?: string;
  local_path?: string;
  sha256?: string;
  body: T;
}

interface ClioExport {
  contacts?: {
    items: ExportItem<{
      type?: string;
      name?: string;
      first_name?: string;
      last_name?: string;
      title?: string;
      company?: string;
      date_of_birth?: string;
      email_addresses?: Array<{ address?: string }>;
      phone_numbers?: Array<{ number?: string }>;
      addresses?: Array<{ street?: string; city?: string; province?: string; postal_code?: string; country?: string }>;
    }>[];
  };
  matter?: {
    body: {
      client?: Ref;
      description?: string;
      status?: string;
      open_date?: string;
      statute_of_limitations?: string;
      practice_area?: Ref;
      matter_stage?: Ref;
      custom_field_values?: Array<{ custom_field?: Ref; value?: unknown }>;
    };
  };
  relationships?: { items: ExportItem<{ contact?: Ref; description?: string }>[] };
  notes?: { items: ExportItem<{ subject?: string; detail?: string; date?: string }>[] };
  communications?: {
    items: ExportItem<{
      type?: string;
      date?: string;
      subject?: string;
      body?: string;
      senders?: Ref[];
      receivers?: Ref[];
    }>[];
  };
  tasks?: {
    items: ExportItem<{
      name?: string;
      description?: string;
      due_at?: string;
      status?: string;
      priority?: string;
      assignee?: Ref;
      statute_of_limitations?: boolean;
    }>[];
  };
  calendar_entries?: {
    items: ExportItem<{ summary?: string; description?: string; location?: string; start_at?: string; end_at?: string }>[];
  };
  expenses?: { items: ExportItem<{ date?: string; quantity?: number; price?: number; note?: string }>[] };
  documents?: {
    items: ExportItem<{ name: string; parent?: Ref; received_at?: string }>[];
  };
}

export interface ClioExportOptions {
  /** Path to the export JSON. */
  file: string;
  /** Id to index the matter under (the export has no real Clio ids). */
  matterId: string;
  /**
   * Extra directory to look for the PDFs in, as "<folder>/<file name>" or
   * anywhere below it by file name. The export's own local_path is tried first.
   */
  documentsDir?: string;
}

const PLACEHOLDER = /^\{\{([a-z_]+)(?::(.+))?\}\}$/;

function parsePlaceholder(value: unknown): { kind: string; name?: string } | null {
  if (typeof value !== "string") return null;
  const match = PLACEHOLDER.exec(value);
  return match ? { kind: match[1], name: match[2] } : null;
}

export function loadClioExport(options: ClioExportOptions): MatterSnapshot {
  const data = JSON.parse(fs.readFileSync(options.file, "utf8")) as ClioExport;
  const matterId = options.matterId;
  const exportDir = path.dirname(path.resolve(options.file));

  const contactsByRef = new Map<string, NonNullable<ClioExport["contacts"]>["items"][number]>();
  for (const item of data.contacts?.items ?? []) {
    if (item.ref) contactsByRef.set(item.ref, item);
  }
  const contactName = (ref: string): string => {
    const body = contactsByRef.get(ref)?.body;
    if (!body) return ref;
    return body.name ?? ([body.first_name, body.last_name].filter(Boolean).join(" ") || ref);
  };
  const participant = (r: Ref | undefined): string => {
    const p = parsePlaceholder(r?.id);
    if (p?.kind === "contact" && p.name) return contactName(p.name);
    if (p?.kind === "user_id") return "Firm user";
    return String(r?.id ?? "Unknown");
  };

  const matter = data.matter?.body ?? {};
  const clientRef = parsePlaceholder(matter.client?.id)?.name;

  const roles = new Map<string, string>();
  if (clientRef) roles.set(clientRef, "Client");
  for (const rel of data.relationships?.items ?? []) {
    const ref = parsePlaceholder(rel.body.contact?.id)?.name;
    if (!ref) continue;
    roles.set(ref, [roles.get(ref), rel.body.description].filter(Boolean).join("; "));
  }

  const parts: MatterParts = {
    matter: {
      id: matterId,
      description: matter.description,
      status: matter.status,
      clientName: clientRef ? contactName(clientRef) : null,
      stage: parsePlaceholder(matter.matter_stage?.id)?.name ?? null,
      openDate: matter.open_date,
      statuteOfLimitations: matter.statute_of_limitations,
    },
    customFields: (matter.custom_field_values ?? []).map((v, i) => {
      const name = parsePlaceholder(v.custom_field?.id)?.name ?? `Custom field ${i + 1}`;
      return { id: `custom_field-${i + 1}`, name, value: v.value };
    }),
    contacts: [...roles.entries()].map(([ref, role]) => {
      const body = contactsByRef.get(ref)?.body ?? {};
      return {
        id: `contact-${ref}`,
        name: contactName(ref),
        role,
        type: body.type,
        title: body.title,
        company: body.company,
        dateOfBirth: body.date_of_birth,
        emails: (body.email_addresses ?? []).map((e) => e.address ?? "").filter(Boolean),
        phones: (body.phone_numbers ?? []).map((p) => p.number ?? "").filter(Boolean),
        addresses: (body.addresses ?? [])
          .map((a) =>
            [a.street, a.city, [a.province, a.postal_code].filter(Boolean).join(" "), a.country]
              .filter(Boolean)
              .join(", "),
          )
          .filter(Boolean),
      };
    }),
    notes: (data.notes?.items ?? []).map(({ body }, i) => ({
      id: `note-${i + 1}`,
      subject: body.subject,
      detail: body.detail,
      date: body.date,
    })),
    communications: (data.communications?.items ?? []).map(({ body }, i) => ({
      id: `communication-${i + 1}`,
      type: body.type,
      subject: body.subject,
      body: body.body,
      date: body.date,
      senders: (body.senders ?? []).map(participant),
      receivers: (body.receivers ?? []).map(participant),
    })),
    tasks: (data.tasks?.items ?? []).map(({ body }, i) => ({
      id: `task-${i + 1}`,
      name: body.name,
      description: body.description,
      status: body.status,
      priority: body.priority,
      dueAt: body.due_at,
      assignee: participant(body.assignee),
      isStatuteOfLimitations: body.statute_of_limitations,
    })),
    calendarEntries: (data.calendar_entries?.items ?? []).map(({ body }, i) => ({
      id: `calendar_entry-${i + 1}`,
      summary: body.summary,
      description: body.description,
      location: body.location,
      startAt: body.start_at,
      endAt: body.end_at,
    })),
    expenses: (data.expenses?.items ?? []).map(({ body }, i) => ({
      id: `expense-${i + 1}`,
      date: body.date,
      quantity: body.quantity,
      price: body.price,
      note: body.note,
    })),
  };

  const documents: CaseDocument[] = [];
  (data.documents?.items ?? []).forEach((item, i) => {
    const folder = parsePlaceholder(item.body.parent?.id)?.name ?? null;
    const file = resolveDocument(exportDir, item.local_path, folder, item.body.name, options.documentsDir);
    if (!file) {
      console.warn(`Document not found, skipping: ${item.body.name}`);
      return;
    }
    documents.push({
      matterId,
      documentId: `document-${i + 1}`,
      name: item.body.name,
      folder,
      receivedDate: toLocalDate(item.body.received_at),
      versionKey: `file:${item.sha256 ?? sha256(fs.readFileSync(file))}`,
      load: async () => new Uint8Array(fs.readFileSync(file)),
    });
  });

  return { matterId, records: buildCaseRecords(parts), documents };
}

function resolveDocument(
  exportDir: string,
  localPath: string | undefined,
  folder: string | null,
  name: string,
  documentsDir?: string,
): string | null {
  const candidates = [
    localPath ? path.join(exportDir, localPath) : null,
    documentsDir && folder ? path.join(documentsDir, folder, name) : null,
    folder ? path.join(exportDir, folder, name) : null,
  ].filter((p): p is string => !!p);
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  for (const dir of [documentsDir, exportDir]) {
    if (!dir) continue;
    const found = findFile(dir, name, 4);
    if (found) return found;
  }
  return null;
}

function findFile(dir: string, name: string, depth: number): string | null {
  if (depth < 0 || !fs.existsSync(dir)) return null;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isFile() && entry.name === name) return full;
    if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules") {
      const found = findFile(full, name, depth - 1);
      if (found) return found;
    }
  }
  return null;
}
