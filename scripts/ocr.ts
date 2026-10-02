#!/usr/bin/env tsx
/**
 * The text/OCR pass.
 *
 * Turns every cached Clio document into indexed page text: the PDF text layer
 * where there is one, Claude transcription for the scanned pages that have
 * none. Each page becomes its own `document_page` source, so a retrieved fact
 * cites a real page number.
 *
 *   npm run rag:ocr                       # documents still awaiting text
 *   npm run rag:ocr -- --all              # redo every document
 *   npm run rag:ocr -- --document 123
 *   npm run rag:ocr -- --no-ocr           # text layer only, no model calls
 *   npm run rag:ocr -- --dry-run          # report what would happen
 *
 * Resumable: documents already indexed are skipped unless --all is passed, and
 * embedding is a separate pass, so an interrupted run loses nothing.
 */

import { listDocuments, listMatters } from "../src/lib/clio/resources";
import { getDb } from "../src/lib/db/sqlite";
import { extractDocumentText } from "../src/lib/rag/document-text";
import { ocrModel } from "../src/lib/rag/ocr";
import { indexDocumentText } from "../src/lib/rag/sync";
import { embedPendingChunks, pendingChunkCount } from "../src/lib/rag/writer";

try {
  process.loadEnvFile(".env.local");
} catch {
  // Variables may already be exported.
}

function log(message = ""): void {
  process.stdout.write(`${message}\n`);
}

interface Args {
  matterId?: number;
  documentId?: number;
  all: boolean;
  ocr: boolean;
  dryRun: boolean;
  batchSize?: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { all: false, ocr: true, dryRun: false };

  for (let i = 0; i < argv.length; i += 1) {
    switch (argv[i]) {
      case "--matter":
        args.matterId = Number(argv[(i += 1)]);
        break;
      case "--document":
        args.documentId = Number(argv[(i += 1)]);
        break;
      case "--batch":
        args.batchSize = Number(argv[(i += 1)]);
        break;
      case "--all":
        args.all = true;
        break;
      case "--no-ocr":
        args.ocr = false;
        break;
      case "--dry-run":
        args.dryRun = true;
        break;
      default:
        throw new Error(`Unknown argument: ${argv[i]}`);
    }
  }

  return args;
}

/** Documents still flagged as awaiting text, per matter. */
function awaitingText(matterId: number): Set<string> {
  const rows = getDb()
    .prepare(
      `SELECT clio_id FROM sources
       WHERE matter_id = ? AND kind = 'document' AND needs_text = 1`,
    )
    .all(matterId) as unknown as { clio_id: string }[];
  return new Set(rows.map((row) => row.clio_id));
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const matterIds =
    args.matterId !== undefined
      ? [args.matterId]
      : (await listMatters({})).map((matter) => matter.id);

  if (args.ocr) log(`OCR model: ${ocrModel()}`);
  if (args.dryRun) log("Dry run — nothing will be written.");

  const totals = {
    documents: 0,
    pages: 0,
    textLayer: 0,
    ocr: 0,
    empty: 0,
    skipped: 0,
    sourcesWritten: 0,
  };

  for (const matterId of matterIds) {
    const documents = await listDocuments(matterId);
    const pending = awaitingText(matterId);

    const queue = documents.filter((document) => {
      if (args.documentId !== undefined) return document.id === args.documentId;
      if (args.all) return true;
      return pending.has(String(document.id));
    });

    log("");
    log(
      `Matter ${matterId}: ${queue.length} of ${documents.length} document(s) to process`,
    );

    for (const document of queue) {
      const result = await extractDocumentText(document, {
        // A dry run reads text layers but never calls the model, so it can
        // report the transcription workload without paying for it.
        ocr: args.ocr && !args.dryRun,
        batchSize: args.batchSize,
        onProgress: (message) => log(`  ${message}`),
      });

      totals.documents += 1;
      totals.pages += result.pageCount;
      totals.textLayer += result.fromTextLayer;
      totals.ocr += result.fromOcr;
      totals.empty += result.empty;

      if (result.skipped) {
        totals.skipped += 1;
        log(`  skipped: ${result.skipped}`);
        continue;
      }

      if (args.dryRun) {
        log(
          `  would index ${result.pages.length} page(s) from the text layer` +
            (result.empty > 0 ? ` and transcribe ${result.empty}` : ""),
        );
        continue;
      }

      // Embedding is deferred to one pass at the end so pages are batched
      // together rather than one small request per document.
      const written = await indexDocumentText(
        matterId,
        {
          id: document.id,
          name: document.name,
          filename: document.filename,
          receivedAt: document.received_at,
        },
        result.pages,
        { skipEmbedding: true },
      );

      totals.sourcesWritten += written.sources.inserted + written.sources.updated;
      log(
        `  indexed ${result.pages.length} page(s): ` +
          `+${written.sources.inserted} new, ${written.sources.updated} changed, ` +
          `${written.sources.unchanged} unchanged` +
          (result.empty > 0 ? `, ${result.empty} page(s) had no text` : ""),
      );
    }
  }

  log("");
  log(
    `Documents ${totals.documents} (${totals.skipped} skipped) | ` +
      `pages ${totals.pages}: ${totals.textLayer} text layer, ${totals.ocr} transcribed, ` +
      `${totals.empty} with no text`,
  );

  if (args.dryRun) return;

  const pending = pendingChunkCount();
  if (pending > 0) {
    log("");
    log(`Embedding ${pending} new chunk(s)...`);
    const stats = await embedPendingChunks({
      onProgress: (done, total) => log(`  ${done}/${total}`),
    });
    log(
      `Embedded ${stats.chunksEmbedded} chunk(s) in ${stats.batches} request(s), ` +
        `${stats.totalTokens.toLocaleString()} tokens.`,
    );
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});
