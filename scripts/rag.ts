#!/usr/bin/env tsx
/**
 * Seed, refresh, inspect, and query the local index from the terminal.
 *
 *   npm run rag:seed                      # sync every open matter, then embed
 *   npm run rag:seed -- --matter 123 --full
 *   npm run rag:status
 *   npm run rag:query -- "what is overdue"
 *
 * Clio tokens come from the same gitignored `.clio/tokens.json` the dev server
 * uses, so connect once at /clio and the CLI works too.
 */

import { databasePath } from "../src/lib/db/sqlite";
import { indexStats, search } from "../src/lib/rag/search";
import { isVoyageConfigured, ragConfig } from "../src/lib/rag/config";
import { embedPendingChunks, pendingChunkCount } from "../src/lib/rag/writer";
import { syncAllMatters, syncMatter, type SyncReport } from "../src/lib/rag/sync";

try {
  process.loadEnvFile(".env.local");
} catch {
  // Fine if it is absent — the variables may already be exported.
}

type Command = "seed" | "embed" | "status" | "query";

interface Args {
  command: Command;
  matterId?: number;
  status?: string;
  full: boolean;
  skipEmbedding: boolean;
  limit: number;
  noRerank: boolean;
  query: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    command: "seed",
    full: false,
    skipEmbedding: false,
    limit: 8,
    noRerank: false,
    query: "",
  };
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    switch (token) {
      case "--matter":
        args.matterId = Number(argv[(i += 1)]);
        break;
      case "--status":
        args.status = argv[(i += 1)];
        break;
      case "--limit":
        args.limit = Number(argv[(i += 1)]);
        break;
      case "--full":
        args.full = true;
        break;
      case "--skip-embedding":
        args.skipEmbedding = true;
        break;
      case "--no-rerank":
        args.noRerank = true;
        break;
      default:
        positional.push(token);
    }
  }

  const [first, ...rest] = positional;
  if (first === "seed" || first === "embed" || first === "status" || first === "query") {
    args.command = first;
    args.query = rest.join(" ");
  } else if (positional.length > 0) {
    args.query = positional.join(" ");
  }

  if (args.matterId !== undefined && !Number.isFinite(args.matterId)) {
    throw new Error("--matter expects a numeric Clio matter id");
  }

  return args;
}

function log(message: string): void {
  process.stdout.write(`${message}\n`);
}

function reportLine(report: SyncReport): void {
  const { counts, sources, embedding } = report;
  log("");
  log(`Matter ${report.displayNumber ?? report.matterId} (${report.mode})`);
  log(
    `  Clio: ${counts.notes} notes, ${counts.communications} communications, ` +
      `${counts.tasks} tasks, ${counts.calendarEntries} calendar entries, ` +
      `${counts.activities} activities, ${counts.documents} documents, ` +
      `${counts.relationships} contacts`,
  );
  log(
    `  Sources: +${sources.inserted} new, ${sources.updated} changed, ` +
      `${sources.unchanged} unchanged, -${sources.removed} gone`,
  );
  log(
    `  Chunks: ${sources.chunksWritten} written, ${embedding.chunksEmbedded} embedded ` +
      `(${embedding.totalTokens.toLocaleString()} tokens, ${embedding.batches} request(s))`,
  );
  if (report.pendingChunks > 0) {
    log(`  Pending embeddings: ${report.pendingChunks}`);
  }
  if (report.documentsNeedingText > 0) {
    log(
      `  Documents without extracted text: ${report.documentsNeedingText} ` +
        `(metadata is indexed; page text awaits the text/OCR pass)`,
    );
  }
}

function printStats(): void {
  const stats = indexStats();
  log(`Database:     ${databasePath()}`);
  log(`Embed model:  ${stats.embedModel}`);
  log(`Rerank model: ${ragConfig.rerankModel}`);
  log(
    `Totals:       ${stats.totals.sources} sources, ${stats.totals.chunks} chunks, ` +
      `${stats.totals.embedded} embedded`,
  );

  if (stats.matters.length === 0) {
    log("");
    log("Index is empty. Run `npm run rag:seed` to pull from Clio.");
    return;
  }

  log("");
  log("By matter:");
  for (const matter of stats.matters) {
    log(
      `  ${matter.displayNumber ?? matter.matterId}: ${matter.sources} sources, ` +
        `${matter.embedded}/${matter.chunks} chunks embedded, ` +
        `last synced ${matter.lastSyncedAt ?? "never"}` +
        (matter.documentsNeedingText > 0
          ? `, ${matter.documentsNeedingText} documents awaiting text`
          : ""),
    );
  }

  log("");
  log("By source kind:");
  for (const row of stats.byKind) {
    log(
      `  ${row.kind.padEnd(16)} ${String(row.sources).padStart(5)} sources  ` +
        `${String(row.embedded)}/${row.chunks} chunks embedded`,
    );
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.command === "status") {
    printStats();
    return;
  }

  if (args.command === "embed") {
    if (!isVoyageConfigured()) throw new Error("VOYAGE_API_KEY is not set.");
    const pending = pendingChunkCount(args.matterId);
    if (pending === 0) {
      log("Nothing to embed.");
      return;
    }
    log(`Embedding ${pending} chunk(s) with ${ragConfig.embedModel}...`);
    const stats = await embedPendingChunks({
      matterId: args.matterId,
      onProgress: (done, total) => log(`  ${done}/${total}`),
    });
    log(
      `Embedded ${stats.chunksEmbedded} chunk(s) in ${stats.batches} request(s), ` +
        `${stats.totalTokens.toLocaleString()} tokens.`,
    );
    return;
  }

  if (args.command === "query") {
    if (!args.query) throw new Error('Usage: npm run rag:query -- "your question"');
    const result = await search(args.query, {
      matterId: args.matterId,
      limit: args.limit,
      rerank: !args.noRerank,
    });

    log(`Query: ${result.query}`);
    log(
      `${result.hits.length} hit(s) in ${result.timings.totalMs.toFixed(0)}ms ` +
        `(keyword ${result.timings.keywordMs.toFixed(0)}ms, ` +
        `vector ${result.timings.vectorMs.toFixed(0)}ms, ` +
        `rerank ${result.timings.rerankMs.toFixed(0)}ms)`,
    );

    result.hits.forEach((hit, index) => {
      const arms = [
        hit.matchedBy.keyword !== null ? `kw#${hit.matchedBy.keyword}` : null,
        hit.matchedBy.vector !== null ? `vec#${hit.matchedBy.vector}` : null,
      ]
        .filter(Boolean)
        .join(" ");
      const score = hit.rerankScore ?? hit.score;

      log("");
      log(
        `${index + 1}. [${hit.kind}] ${hit.title}  ` +
          `(score ${score.toFixed(4)}, ${arms}, source ${hit.sourceId})`,
      );
      log(
        hit.text
          .split("\n")
          .slice(0, 6)
          .map((line) => `   ${line}`)
          .join("\n"),
      );
    });
    return;
  }

  // seed
  if (!args.skipEmbedding && !isVoyageConfigured()) {
    throw new Error(
      "VOYAGE_API_KEY is not set. Set it in .env.local, or pass --skip-embedding.",
    );
  }

  const options = {
    full: args.full,
    skipEmbedding: args.skipEmbedding,
    onProgress: (message: string) => log(`  ${message}`),
  };

  const reports =
    args.matterId !== undefined
      ? [await syncMatter(args.matterId, options)]
      : await syncAllMatters({ ...options, status: args.status });

  reports.forEach(reportLine);
  log("");
  printStats();
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
