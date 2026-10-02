#!/usr/bin/env tsx
/**
 * Coverage audit: does the index hold every Clio record it should?
 *
 * Re-reads the matter from Clio and diffs ids, per resource, against the
 * `sources` table. Also reports what was deliberately dropped (records with no
 * renderable content) and what is still awaiting document text, so "complete"
 * is a checked claim rather than an assumed one.
 *
 *   npx tsx scripts/audit-rag.ts [--matter <id>]
 */

import { getDb } from "../src/lib/db/sqlite";
import {
  getMatterBundle,
  listActivities,
  listMatters,
} from "../src/lib/clio/resources";
import { bundleToSources } from "../src/lib/rag/sources";

try {
  process.loadEnvFile(".env.local");
} catch {
  // Variables may already be exported.
}

function log(message = ""): void {
  process.stdout.write(`${message}\n`);
}

function storedIds(matterId: number, kind: string): Set<string> {
  const rows = getDb()
    .prepare("SELECT clio_id FROM sources WHERE matter_id = ? AND kind = ?")
    .all(matterId, kind) as unknown as { clio_id: string }[];
  return new Set(rows.map((row) => row.clio_id));
}

function compare(
  label: string,
  kind: string,
  matterId: number,
  clioIds: string[],
): boolean {
  const stored = storedIds(matterId, kind);
  const live = new Set(clioIds);
  const missing = [...live].filter((id) => !stored.has(id));
  const extra = [...stored].filter((id) => !live.has(id));
  const ok = missing.length === 0 && extra.length === 0;

  log(
    `${ok ? "OK  " : "GAP "} ${label.padEnd(16)} Clio ${String(live.size).padStart(3)}  ` +
      `indexed ${String(stored.size).padStart(3)}` +
      (missing.length ? `  MISSING ${missing.slice(0, 8).join(",")}` : "") +
      (extra.length ? `  STALE ${extra.slice(0, 8).join(",")}` : ""),
  );
  return ok;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const flag = argv.indexOf("--matter");
  const matterIds =
    flag !== -1
      ? [Number(argv[flag + 1])]
      : (await listMatters({})).map((matter) => matter.id);

  let allOk = true;

  for (const matterId of matterIds) {
    // Deliberately a full pull: an audit must not trust the sync cursor.
    const bundle = await getMatterBundle(matterId);
    log("");
    log(`=== ${bundle.matter.display_number ?? matterId} (${matterId}) ===`);

    const results = [
      compare("matter", "matter", matterId, [String(bundle.matter.id)]),
      compare(
        "custom_field",
        "custom_field",
        matterId,
        (bundle.matter.custom_field_values ?? []).map((field) => field.id),
      ),
      // Expected contacts are the matter's related contacts plus its client —
      // Clio does not list the client among /relationships.
      compare(
        "contact",
        "contact",
        matterId,
        [
          ...new Set(
            [
              bundle.matter.client?.id,
              ...bundle.relationships.map((relationship) => relationship.contact?.id),
            ].filter((id): id is number => id !== undefined),
          ),
        ].map(String),
      ),
      compare("note", "note", matterId, bundle.notes.map((n) => String(n.id))),
      compare(
        "communication",
        "communication",
        matterId,
        bundle.communications.map((c) => String(c.id)),
      ),
      compare("task", "task", matterId, bundle.tasks.map((t) => String(t.id))),
      compare(
        "calendar_entry",
        "calendar_entry",
        matterId,
        bundle.calendarEntries.map((e) => String(e.id)),
      ),
      compare(
        "activity",
        "activity",
        matterId,
        bundle.activities.map((a) => String(a.id)),
      ),
      compare(
        "document",
        "document",
        matterId,
        bundle.documents.map((d) => String(d.id)),
      ),
    ];
    if (results.some((ok) => !ok)) allOk = false;

    // Records the mapper dropped because no field rendered to text. These are
    // intentional, but they should be visible rather than silently absent.
    const mapped = bundleToSources(bundle);
    const customFieldsPresent = (bundle.matter.custom_field_values ?? []).length;
    const customFieldsMapped = mapped.filter((s) => s.kind === "custom_field").length;

    log("");
    log(
      `Custom field values: ${customFieldsPresent} returned by Clio, ` +
        `${customFieldsMapped} indexed ` +
        `(${customFieldsPresent - customFieldsMapped} had an empty value and were dropped)`,
    );

    // Activities cover both time entries and expenses; confirm neither type is
    // being silently skipped.
    const expenses = await listActivities(matterId, { type: "ExpenseEntry" });
    const timeEntries = await listActivities(matterId, { type: "TimeEntry" });
    const expenseTotal = expenses.reduce((sum, item) => sum + (item.total ?? 0), 0);
    log(
      `Activities: ${expenses.length} expenses (total ${expenseTotal.toFixed(2)}), ` +
        `${timeEntries.length} time entries, ${bundle.activities.length} indexed`,
    );
    if (expenses.length + timeEntries.length !== bundle.activities.length) {
      log("GAP  activity type counts do not add up to the indexed total");
      allOk = false;
    }

    // Chunk/embedding integrity for this matter.
    const integrity = getDb()
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM sources s WHERE s.matter_id = ?) AS sources,
           (SELECT COUNT(*) FROM sources s WHERE s.matter_id = ?
              AND NOT EXISTS (SELECT 1 FROM chunks c WHERE c.source_id = s.id)) AS sourcesWithoutChunks,
           (SELECT COUNT(*) FROM chunks c JOIN sources s ON s.id = c.source_id
              WHERE s.matter_id = ? AND c.embedding IS NULL) AS chunksWithoutEmbedding,
           (SELECT COUNT(DISTINCT c.embedding_dim) FROM chunks c JOIN sources s ON s.id = c.source_id
              WHERE s.matter_id = ?) AS distinctDims,
           (SELECT COUNT(*) FROM sources s WHERE s.matter_id = ?
              AND s.kind = 'document' AND s.needs_text = 1) AS documentsAwaitingText`,
      )
      .get(matterId, matterId, matterId, matterId, matterId) as unknown as {
      sources: number;
      sourcesWithoutChunks: number;
      chunksWithoutEmbedding: number;
      distinctDims: number;
      documentsAwaitingText: number;
    };

    // Document text: every document should have page sources, and none should
    // still be flagged as awaiting text once the OCR pass has run.
    const pageCoverage = getDb()
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM sources WHERE matter_id = ? AND kind = 'document_page') AS pages,
           (SELECT COUNT(DISTINCT clio_id) FROM sources
              WHERE matter_id = ? AND kind = 'document_page') AS documentsWithPages,
           (SELECT COUNT(*) FROM sources WHERE matter_id = ? AND kind = 'document') AS documents`,
      )
      .get(matterId, matterId, matterId) as unknown as {
      pages: number;
      documentsWithPages: number;
      documents: number;
    };

    const ocrPages = getDb()
      .prepare(
        `SELECT COUNT(*) AS n FROM sources
         WHERE matter_id = ? AND kind = 'document_page'
           AND json_extract(metadata, '$.viaOcr') = 1`,
      )
      .get(matterId) as unknown as { n: number };

    const pagesOk = pageCoverage.documentsWithPages === pageCoverage.documents;
    log("");
    log(
      `${pagesOk ? "OK  " : "GAP "} document text   ` +
        `${pageCoverage.documentsWithPages}/${pageCoverage.documents} documents have page text, ` +
        `${pageCoverage.pages} pages indexed (${ocrPages.n} transcribed, ` +
        `${pageCoverage.pages - ocrPages.n} from a text layer)`,
    );
    if (!pagesOk) allOk = false;

    log("");
    log(
      `Integrity: ${integrity.sources} sources, ` +
        `${integrity.sourcesWithoutChunks} without chunks, ` +
        `${integrity.chunksWithoutEmbedding} chunks without an embedding, ` +
        `${integrity.distinctDims} distinct embedding dimension(s)`,
    );
    if (
      integrity.sourcesWithoutChunks > 0 ||
      integrity.chunksWithoutEmbedding > 0 ||
      integrity.distinctDims > 1
    ) {
      allOk = false;
    }
    log(`Documents awaiting page text (OCR pass): ${integrity.documentsAwaitingText}`);

    // Round-trip the FTS index: every chunk should be findable by its own text.
    const ftsCount = getDb()
      .prepare("SELECT COUNT(*) AS n FROM chunks_fts")
      .get() as unknown as { n: number };
    const chunkCount = getDb()
      .prepare("SELECT COUNT(*) AS n FROM chunks")
      .get() as unknown as { n: number };
    const ftsOk = ftsCount.n === chunkCount.n;
    log(
      `${ftsOk ? "OK  " : "GAP "} FTS index rows ${ftsCount.n} vs chunks ${chunkCount.n}`,
    );
    if (!ftsOk) allOk = false;
  }

  log("");
  log(allOk ? "AUDIT PASSED — no gaps." : "AUDIT FOUND GAPS (see GAP lines above).");
  if (!allOk) process.exitCode = 1;
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});
