# Case-file RAG

The app keeps a searchable index of each matter in a local SQLite file. A chat agent can search it to answer questions about a case and cite where each answer came from.

The index covers everything in the Clio matter: matter fields, custom fields, contacts, notes, communications, tasks, calendar entries, expenses, and the text of every document page. Scanned pages are included once they are OCR'd.

## How it works

1. **Read from Clio.** `src/lib/clio/snapshot.ts` pulls the matter through the shared read-only Clio client (`resources.ts`), which sends GET requests only. A test fails if anything in `src/lib/clio/` other than the OAuth token calls uses another HTTP method.
2. **Normalize.** Each record becomes a `CaseRecord` with a source type, Clio id, title, local date, and plain text (`src/lib/rag/records.ts`). Each document page becomes its own record, so search results can point at a page.
3. **Extract page text.** PDFs are read with their own text layer. Pages without one are skipped, or transcribed by Claude when you pass `--ocr`. Page text is cached by document version, so each page is parsed or OCR'd once (`documents.ts`, `ocr.ts`).
4. **Chunk.** Long text is split at paragraph and sentence boundaries into chunks of about 1,200 characters, with a short overlap. Every chunk carries a header line with the record type, date, title, and page, so it still makes sense when read alone (`chunking.ts`).
5. **Embed.** Chunks are embedded with Voyage AI and stored in a `sqlite-vec` table, partitioned by matter. Embeddings are cached by content hash. Re-running ingestion on a matter that hasn't changed makes no embedding calls (`ingest.ts`).
6. **Search.** Each query runs two searches and merges them with reciprocal rank fusion: vector similarity for meaning, and SQLite FTS5 (BM25) for exact names, dates, claim numbers, and amounts. Results are always limited to one matter (`search.ts`).

## Setup

```bash
cp .env.example .env.local   # then fill in the keys
npm install
```

| Variable | Needed for |
| --- | --- |
| `CLIO_CLIENT_ID`, `CLIO_CLIENT_SECRET` | Connecting to Clio. See "Clio Manage connection" in the README. |
| `VOYAGE_API_KEY` | Embeddings. Without it, search falls back to keywords only. |
| `ANTHROPIC_API_KEY` | OCR of scanned pages (`--ocr`). |
| `RAG_API_TOKEN` | Bearer token for `POST /api/rag/search`. Required in production. |

Before indexing from Clio, connect once: run `npm run dev`, open `/clio`, and click **Connect to Clio**. The tokens are saved in `.clio/tokens.json`, and the ingest command reuses them.

## Commands

```bash
# Index a matter from Clio (read-only)
npm run rag:ingest -- --clio-matter <matter id>

# Also OCR scanned pages with Claude (results are cached)
npm run rag:ingest -- --clio-matter <matter id> --ocr

# Index from a Clio setup export instead (offline development)
npm run rag:ingest -- --export <file.json> --matter-id <id> --documents-dir <pdf folder>

# Try a query
npm run rag:search -- --matter-id <id> "what injuries were claimed?"
npm run rag:search -- --matter-id <id> --type communication --from 2026-09-01 "client call"

npm test
```

Ingestion is safe to repeat. Changed records are re-chunked and re-embedded, unchanged ones are left alone, and records deleted in Clio are removed from the index. Pass `--no-prune` to keep them.

## Using it from a chat agent

`searchCaseFileTool` is a Claude tool definition. The server binds the matter when the tool runs, so the model can only search the matter the conversation belongs to.

```ts
import Anthropic from "@anthropic-ai/sdk";
import { getRagContext, runSearchCaseFile, searchCaseFileTool } from "@/lib/rag";

const { db, embedder } = getRagContext();

// Pass `tools: [searchCaseFileTool]` to client.messages.create(...).
// When Claude calls it, run the search for the current matter:
async function handleToolUse(block: Anthropic.ToolUseBlock, matterId: string) {
  try {
    const content = await runSearchCaseFile(db, embedder, matterId, block.input);
    return { type: "tool_result" as const, tool_use_id: block.id, content };
  } catch (error) {
    return { type: "tool_result" as const, tool_use_id: block.id, content: String(error), is_error: true };
  }
}
```

Each result comes back as a `<passage>` with `source_type`, `source_id`, `date`, `title`, and `page`, so the agent can cite its sources and the UI can link to the Clio record or document page.

## HTTP endpoint

`POST /api/rag/search` with `Authorization: Bearer $RAG_API_TOKEN`:

```json
{ "matterId": "123", "query": "surgery dates", "limit": 8, "sourceTypes": ["document_page"], "dateFrom": "2023-01-01" }
```

## Tables

| Table | Holds |
| --- | --- |
| `records` | One row per source record or document page, with its Clio id and a content hash |
| `chunks` / `chunks_fts` | Chunk text and the FTS5 keyword index |
| `chunk_vectors` | `sqlite-vec` embeddings, partitioned by matter |
| `embedding_cache` | Embeddings by model and content hash |
| `page_text` | Extracted or OCR'd text for each PDF page, by document version |
| `documents` | Page counts and pages still lacking text, per document |

## Things to know

- **Firm-side only.** The index holds everything in the file, including dates of birth and attorney notes. Don't use it to build the provider portal.
- **The index file is client data.** `data/` is gitignored. Don't commit it or upload it anywhere public.
- **Not yet tested against a live Clio account.** If Clio rejects a request, its error message is printed. The `fields` lists for each resource are in `src/lib/clio/resources.ts`.
- **OCR cost.** OCR sends four pages per request to Claude. The model is set by `RAG_OCR_MODEL`. OCR'd text is cached, so you pay once per page. The OCR prompt tells Claude to replace government ID numbers (license, passport, SSN) with a placeholder. That is an instruction, not a guarantee, so spot-check ID documents.
- **Deploying to Vercel.** The serverless file system is read-only and temporary. Run ingestion locally or on a worker and deploy the finished `.sqlite` file with the app, or move the store to a hosted SQLite such as Turso.
- **Changing embedding models** rebuilds the vector table on the next ingest. A query embedder that doesn't match the index fails with a clear error instead of returning bad results.
