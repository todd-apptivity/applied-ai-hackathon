/**
 * Builds or refreshes the RAG index for one matter.
 *
 *   From Clio (read-only). Connect first: `npm run dev`, then open /clio.
 *     npm run rag:ingest -- --clio-matter <matter id> [--ocr]
 *
 *   From a Clio setup export (offline development):
 *     npm run rag:ingest -- --export <file.json> --matter-id <id> [--documents-dir <dir>] [--ocr]
 *
 * Options:
 *   --ocr        OCR pages without a text layer using Claude (needs ANTHROPIC_API_KEY).
 *                Results are cached, so each page is only OCR'd once.
 *   --no-prune   Keep indexed records that are missing from this snapshot.
 *   --db <path>  SQLite file (default: RAG_DB_PATH or data/rag.sqlite).
 */
import { parseArgs } from "node:util";
import { fetchMatterSnapshot } from "../src/lib/clio/snapshot";
import { openRagDb } from "../src/lib/rag/db";
import { createEmbedder } from "../src/lib/rag/embeddings";
import { ingestMatter, type MatterSnapshot } from "../src/lib/rag/ingest";
import { createClaudeOcr } from "../src/lib/rag/ocr";
import { loadClioExport } from "../src/lib/rag/sources/clio-export";
import { loadEnvFiles } from "./env";

loadEnvFiles();

const { values } = parseArgs({
  options: {
    "clio-matter": { type: "string" },
    export: { type: "string" },
    "matter-id": { type: "string" },
    "documents-dir": { type: "string" },
    ocr: { type: "boolean", default: false },
    "no-prune": { type: "boolean", default: false },
    db: { type: "string" },
  },
});

async function main() {
  let snapshot: MatterSnapshot;
  if (values["clio-matter"]) {
    const matterId = Number(values["clio-matter"]);
    if (!Number.isInteger(matterId) || matterId <= 0) throw new Error("--clio-matter must be a numeric Clio matter id");
    console.log(`Reading matter ${matterId} from Clio...`);
    snapshot = await fetchMatterSnapshot(matterId);
  } else if (values.export && values["matter-id"]) {
    snapshot = loadClioExport({
      file: values.export,
      matterId: values["matter-id"],
      documentsDir: values["documents-dir"],
    });
  } else {
    console.error(
      "Usage:\n" +
        "  npm run rag:ingest -- --clio-matter <id> [--ocr]\n" +
        "  npm run rag:ingest -- --export <file.json> --matter-id <id> [--documents-dir <dir>] [--ocr]",
    );
    process.exit(1);
  }
  console.log(`${snapshot.records.length} records and ${snapshot.documents.length} documents to index.`);

  const db = openRagDb(values.db);
  const started = Date.now();
  const stats = await ingestMatter(db, snapshot, {
    embedder: createEmbedder(),
    ocr: values.ocr ? createClaudeOcr() : undefined,
    prune: !values["no-prune"],
    log: (message) => console.log(message),
  });
  console.log(`\nDone in ${((Date.now() - started) / 1000).toFixed(1)}s`, stats);
  if (stats.pagesWithoutText > 0 && !values.ocr) {
    console.log(
      `${stats.pagesWithoutText} scanned page(s) have no text layer and were not indexed. ` +
        "Re-run with --ocr to transcribe them.",
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
