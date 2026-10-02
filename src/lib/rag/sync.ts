/**
 * Clio to the local index.
 *
 * A sync is: pull the matter bundle (whole, or only what Clio changed since the
 * last run), flatten it to sources, write what changed, embed what has no
 * vector. The cursor is the fetch time Clio reported, so the next refresh asks
 * for exactly the window we have not seen.
 *
 * Clio is read-only here, as everywhere: this module only ever issues GETs
 * through `@/lib/clio/client`.
 */

import {
  getContact,
  getMatterBundle,
  listMatters,
  type MatterBundle,
} from "@/lib/clio/resources";
import type { ClioContact } from "@/lib/clio/types";
import { bundleToSources, documentPageSources, type SourceRecord } from "./sources";
import {
  clearNeedsText,
  documentsWithPages,
  embedPendingChunks,
  pendingChunkCount,
  recordSyncCursor,
  syncCursor,
  upsertMatter,
  upsertSources,
  type EmbedStats,
  type UpsertStats,
} from "./writer";

export interface SyncOptions {
  /** Ignore the stored cursor and re-pull the whole matter. */
  full?: boolean;
  /** Write sources but skip embedding; `embedPendingChunks` can finish later. */
  skipEmbedding?: boolean;
  /**
   * Skip the per-contact reads that fill in addresses and alternate emails and
   * phones. Faster, at the cost of thinner contact sources.
   */
  skipContactDetails?: boolean;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
}

export interface SyncReport {
  matterId: number;
  displayNumber: string | null;
  mode: "full" | "incremental";
  /** Cursor sent to Clio as `updated_since`, if any. */
  updatedSince: string | null;
  fetchedAt: string;
  counts: {
    notes: number;
    communications: number;
    tasks: number;
    calendarEntries: number;
    activities: number;
    documents: number;
    folders: number;
    relationships: number;
  };
  sources: UpsertStats;
  embedding: EmbedStats;
  pendingChunks: number;
  documentsNeedingText: number;
}

/**
 * Pull the full contact record for the client and every related contact.
 *
 * `/relationships` embeds only a flat subset of each contact, and Clio does not
 * list the matter's own client there at all — so without this the client's
 * contact record would never be indexed, and nobody's addresses or alternate
 * emails and phones would be either. One GET per contact, well inside Clio's
 * 600-per-minute budget.
 *
 * A single contact failing is not worth failing the sync over: the relationship
 * summary still carries the name, so the source is thinner, not missing.
 */
async function fetchFullContacts(
  bundle: MatterBundle,
  options: SyncOptions,
): Promise<ClioContact[]> {
  if (options.skipContactDetails) return [];

  const ids = new Set<number>();
  if (bundle.matter.client) ids.add(bundle.matter.client.id);
  for (const relationship of bundle.relationships) {
    if (relationship.contact) ids.add(relationship.contact.id);
  }

  const contacts: ClioContact[] = [];
  for (const id of ids) {
    try {
      contacts.push(await getContact(id, { signal: options.signal }));
    } catch (error) {
      if (options.signal?.aborted) throw error;
      options.onProgress?.(
        `Could not read contact ${id}; keeping the summary from the matter relationship`,
      );
    }
  }
  return contacts;
}

export async function syncMatter(
  matterId: number,
  options: SyncOptions = {},
): Promise<SyncReport> {
  const log = options.onProgress ?? (() => {});
  const cursor = options.full ? null : syncCursor(matterId);
  const mode = cursor ? "incremental" : "full";

  log(`Pulling matter ${matterId} from Clio (${mode}${cursor ? ` since ${cursor}` : ""})`);

  const bundle = await getMatterBundle(matterId, {
    updatedSince: cursor ?? undefined,
    signal: options.signal,
  });

  // The matter row has to exist before sources can reference it.
  upsertMatter({
    id: bundle.matter.id,
    displayNumber: bundle.matter.display_number,
    description: bundle.matter.description,
    status: bundle.matter.status,
    clientName: bundle.matter.client?.name,
  });

  const contacts = await fetchFullContacts(bundle, options);
  if (contacts.length > 0) log(`Fetched ${contacts.length} full contact record(s)`);

  const sources = bundleToSources(bundle, {
    documentsWithPages: documentsWithPages(matterId),
    contacts,
  });

  log(`Flattened ${sources.length} sources`);

  // Pruning is only correct when the pull was complete; an incremental pull
  // returns deltas, so absence means unchanged, not deleted.
  const stats = upsertSources(matterId, sources, { prune: mode === "full" });
  log(
    `Sources: +${stats.inserted} new, ${stats.updated} changed, ${stats.unchanged} unchanged, ` +
      `-${stats.removed} gone (${stats.chunksWritten} chunks written, ` +
      `${stats.revisions} change log entries)`,
  );

  let embedding: EmbedStats = {
    chunksEmbedded: 0,
    batches: 0,
    totalTokens: 0,
    model: "",
  };

  if (!options.skipEmbedding) {
    embedding = await embedPendingChunks({
      matterId,
      signal: options.signal,
      onProgress: (done, total) => log(`Embedded ${done}/${total} chunks`),
    });
  }

  recordSyncCursor(matterId, {
    lastSyncedAt: bundle.fetchedAt,
    lastFetchedAt: bundle.fetchedAt,
  });

  const documentsNeedingText = sources.filter(
    (source) => source.kind === "document" && source.needsText,
  ).length;

  return {
    matterId,
    displayNumber: bundle.matter.display_number ?? null,
    mode,
    updatedSince: cursor,
    fetchedAt: bundle.fetchedAt,
    counts: {
      notes: bundle.notes.length,
      communications: bundle.communications.length,
      tasks: bundle.tasks.length,
      calendarEntries: bundle.calendarEntries.length,
      activities: bundle.activities.length,
      documents: bundle.documents.length,
      folders: bundle.folders.length,
      relationships: bundle.relationships.length,
    },
    sources: stats,
    embedding,
    pendingChunks: pendingChunkCount(matterId),
    documentsNeedingText,
  };
}

/** Sync every matter with the given status (default all open matters). */
export async function syncAllMatters(
  options: SyncOptions & { status?: string } = {},
): Promise<SyncReport[]> {
  const log = options.onProgress ?? (() => {});
  const matters = await listMatters({
    status: options.status ?? "Open",
    signal: options.signal,
  });

  log(`Found ${matters.length} matter(s) to sync`);

  const reports: SyncReport[] = [];
  for (const matter of matters) {
    reports.push(await syncMatter(matter.id, options));
  }
  return reports;
}

/**
 * Index extracted or OCR'd page text for one document.
 *
 * The text/OCR worker owns getting bytes to text; this is the seam it writes
 * through. Pages are merged into the same `sources` table as every other
 * record, so they rank, cite, and refresh the same way.
 */
export async function indexDocumentText(
  matterId: number,
  document: { id: number; name?: string; filename?: string; receivedAt?: string },
  pages: { page: number; text: string; viaOcr?: boolean }[],
  options: { skipEmbedding?: boolean; signal?: AbortSignal } = {},
): Promise<{ sources: UpsertStats; embedding: EmbedStats }> {
  const pageSources: SourceRecord[] = documentPageSources(
    matterId,
    {
      id: document.id,
      name: document.name,
      filename: document.filename,
      received_at: document.receivedAt,
    },
    pages,
  );

  // Page sources are keyed per page, and a partial re-extract should not drop
  // pages this call did not cover — never prune here.
  const sources = upsertSources(matterId, pageSources, { prune: false });

  if (pageSources.length > 0) {
    clearNeedsText(matterId, String(document.id));
  }

  const embedding = options.skipEmbedding
    ? { chunksEmbedded: 0, batches: 0, totalTokens: 0, model: "" }
    : await embedPendingChunks({ matterId, signal: options.signal });

  return { sources, embedding };
}
