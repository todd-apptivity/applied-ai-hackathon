/**
 * Case-file RAG: a per-matter index of Clio records and document pages in
 * SQLite, with vector search (sqlite-vec) and keyword search (FTS5).
 *
 * Server-only. Ingest with `npm run rag:ingest`; query with searchCaseFile or
 * hand searchCaseFileTool to a Claude chat agent.
 */
import { openRagDb, type RagDatabase } from "./db";
import { createEmbedder, type Embedder } from "./embeddings";

export { openRagDb, closeRagDb, ragDbPath, type RagDatabase } from "./db";
export { createEmbedder, VoyageEmbedder, HashEmbedder, type Embedder } from "./embeddings";
export { ingestMatter, syncVectors, type MatterSnapshot, type IngestStats } from "./ingest";
export { searchCaseFile, type SearchOptions } from "./search";
export {
  searchCaseFileTool,
  runSearchCaseFile,
  formatResultsForModel,
  SEARCH_CASE_FILE_TOOL_NAME,
} from "./tool";
export { createClaudeOcr, type OcrFn } from "./ocr";
export * from "./types";

export interface RagContext {
  db: RagDatabase;
  /** Undefined when no embedding provider is configured; search is then keyword-only. */
  embedder: Embedder | undefined;
}

let embedder: Embedder | undefined | null = null;

/** Shared database handle and query embedder for route handlers and agents. */
export function getRagContext(): RagContext {
  if (embedder === null) {
    try {
      embedder = createEmbedder();
    } catch {
      embedder = undefined;
    }
  }
  return { db: openRagDb(), embedder };
}
