/**
 * Query the RAG index from the command line.
 *
 *   npm run rag:search -- --matter-id <id> "what injuries were claimed?"
 *   npm run rag:search -- --matter-id <id> --type note --type communication "client contact"
 */
import { parseArgs } from "node:util";
import { openRagDb } from "../src/lib/rag/db";
import { createEmbedder, type Embedder } from "../src/lib/rag/embeddings";
import { formatResultsForModel } from "../src/lib/rag/tool";
import { searchCaseFile } from "../src/lib/rag/search";
import { isSourceType } from "../src/lib/rag/types";
import { loadEnvFiles } from "./env";

loadEnvFiles();

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    "matter-id": { type: "string" },
    type: { type: "string", multiple: true },
    from: { type: "string" },
    to: { type: "string" },
    limit: { type: "string" },
    db: { type: "string" },
  },
});

async function main() {
  const query = positionals.join(" ").trim();
  if (!values["matter-id"] || !query) {
    console.error('Usage: npm run rag:search -- --matter-id <id> [--type note] "question"');
    process.exit(1);
  }
  const types = values.type ?? [];
  const bad = types.filter((t) => !isSourceType(t));
  if (bad.length) throw new Error(`Unknown source type(s): ${bad.join(", ")}`);

  let embedder: Embedder | undefined;
  try {
    embedder = createEmbedder();
  } catch {
    console.warn("No embedding provider configured; using keyword search only.\n");
  }
  const results = await searchCaseFile(openRagDb(values.db), {
    matterId: values["matter-id"],
    query,
    limit: values.limit ? Number(values.limit) : 8,
    embedder,
    filters: {
      sourceTypes: types.filter(isSourceType),
      dateFrom: values.from,
      dateTo: values.to,
    },
  });
  console.log(formatResultsForModel(results));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
