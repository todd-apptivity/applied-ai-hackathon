This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

## Clio Manage connection

The app reads a matter live from the Clio Manage API v4. **Clio is input only.**
The developer app is granted read permissions, and `src/lib/clio/client.ts` is
the single place that talks to Clio — it issues `GET` and throws on any other
verb. Everything the app produces lives in its own database.

### 1. Create a Clio developer app

In Clio: **Settings → Developer applications → Add**.

- Redirect URI: `http://localhost:3000/api/clio/callback` (must match exactly)
- Permissions, **read only**: Users, Practice Areas, Contacts, Matters,
  Custom Fields, Documents, Notes, Communications, Tasks, Calendars, Activities

Clio has no OAuth `scope` request parameter; permissions are set on the app
itself, so the read-only promise is enforced on Clio's side as well as ours.

### 2. Configure

```bash
cp .env.example .env.local
# fill in CLIO_CLIENT_ID and CLIO_CLIENT_SECRET
```

`CLIO_REGION` selects the Clio host (`us`, `eu`, `ca`, `au`).

### 3. Connect

Run `npm run dev` and open [/clio](http://localhost:3000/clio), then
**Connect to Clio**. The callback stores the tokens in `.clio/tokens.json`
(gitignored, mode 600) so the dev server can restart without re-authorizing.
Access tokens refresh automatically.

### Routes

| Route | Purpose |
| --- | --- |
| `GET /clio` | Connection status, connect button, open matters |
| `GET /api/clio/connect` | Starts the OAuth flow |
| `GET /api/clio/callback` | OAuth redirect target; stores tokens |
| `GET /api/clio/status` | `configured` / `connected` / current Clio user |
| `POST /api/clio/disconnect` | Revokes the token and clears local storage |
| `GET /api/clio/matters` | Matter list (`?status=Open&query=…`) |
| `GET /api/clio/matters/{id}` | Full matter bundle (`?updated_since=…`) |

### Using it from code

```ts
import { getMatterBundle, downloadDocument } from "@/lib/clio/resources";

// Everything the pipeline needs for one matter, in one call.
const bundle = await getMatterBundle(matterId);

// Incremental refresh: only what Clio changed since the last sync.
const delta = await getMatterBundle(matterId, { updatedSince: lastSyncIso });

// Document bytes, for hashing / OCR.
const { body, contentType } = await downloadDocument(documentId);
```

The client handles pagination (`meta.paging.next`), the 600 requests/minute
account limit, `429 Retry-After`, 5xx backoff, and single-flight token refresh.

### Files

- `src/lib/clio/config.ts` — env, regions, required read permissions
- `src/lib/clio/oauth.ts` — authorize URL, code exchange, refresh, revoke
- `src/lib/clio/token-store.ts` — token persistence (`TokenStore` interface)
- `src/lib/clio/client.ts` — read-only HTTP, rate limiting, pagination
- `src/lib/clio/resources.ts` — typed reads per Clio resource
- `src/lib/clio/types.ts` — Clio record shapes

## Retrieval index (local SQLite cache)

Clio case data is cached in SQLite and indexed for hybrid retrieval. **Clio stays
read-only**: the sync issues `GET`s only, and everything the app derives lives in
its own database.

### Stack

| Piece | Choice |
| --- | --- |
| Store | SQLite via Node's built-in `node:sqlite` — no native dependency, no build step |
| Keyword search | SQLite FTS5 (`porter unicode61`), BM25 ranked |
| Embeddings | Voyage `voyage-4-large`, 1024 dimensions |
| Reranking | Voyage `rerank-2.5` |
| Fusion | Reciprocal rank fusion over both arms, then rerank |

Anthropic has no embeddings endpoint, so retrieval runs on Voyage (which
Anthropic recommends) while Claude handles extraction and composition.

### Configure

Add to `.env.local`:

```bash
VOYAGE_API_KEY=            # required for embedding and reranking
# Optional overrides
RAG_DB_PATH=.data/ninety.db
VOYAGE_EMBED_MODEL=voyage-4-large
VOYAGE_RERANK_MODEL=rerank-2.5
```

The database file lives in the gitignored `.data/` directory.

### Seed and query

Connect to Clio first (see above) — the CLI reads the same `.clio/tokens.json`
the dev server uses.

```bash
npm run rag:seed                            # every open matter
npm run rag:seed -- --matter 1811206913     # one matter
npm run rag:seed -- --matter 123 --full     # re-pull everything and prune
npm run rag:status                          # what is indexed
npm run rag:query -- "what is overdue"
npm run rag:embed                           # finish any pending embeddings
npm run rag:audit                           # prove nothing is missing
```

`rag:audit` re-reads each matter from Clio and diffs ids per resource against
the index, so coverage is a checked claim and not an assumed one. It also
verifies that no source lacks chunks, no chunk lacks an embedding, the embedding
dimensions are uniform, and the FTS row count matches the chunk count. It exits
non-zero on a gap, so it works in CI.

**Contacts need two reads.** `/relationships` embeds only a flat subset of each
contact and omits the matter's own client entirely, so the sync also fetches the
full record for the client and every related contact — otherwise the client's
contact record is never indexed and nobody's addresses or alternate emails and
phones are either. Pass `skipContactDetails` to skip those reads.

### How it stays cheap

Each Clio record becomes one `sources` row carrying a content hash. A refresh
asks Clio only for records changed since the stored cursor, and re-chunks and
re-embeds only rows whose hash moved — so reopening an unchanged matter costs
zero model calls. Embedding is a separate pass over rows with no vector, so an
interrupted seed resumes rather than restarting, and changing
`VOYAGE_EMBED_MODEL` just re-embeds.

### Routes

| Route | Purpose |
| --- | --- |
| `GET /api/rag/status` | Index contents, model names, pending embeddings |
| `GET /api/rag/search` | `?q=…&matter_id=…&limit=…&kinds=note,task&rerank=false` |
| `POST /api/rag/sync` | `{ matterId?, full?, skipEmbedding?, status? }` |

Every search hit carries its source kind, Clio id, page, and a deep link back
into Clio.

### Files

- `src/lib/db/schema.ts` — tables, FTS5 index, and the triggers that keep it in sync
- `src/lib/db/sqlite.ts` — the single connection, pragmas, transactions
- `src/lib/rag/sources.ts` — Clio records to retrievable sources (no matter-specific strings)
- `src/lib/rag/chunk.ts` — chunking and HTML stripping
- `src/lib/rag/voyage.ts` — embeddings and reranking, batched and retried
- `src/lib/rag/writer.ts` — hash-based upsert, chunking, embedding pass
- `src/lib/rag/search.ts` — hybrid search, RRF fusion, index stats
- `src/lib/rag/sync.ts` — Clio to index, full and incremental
- `scripts/rag.ts` — the CLI behind the `rag:*` npm scripts
- `scripts/audit-rag.ts` — coverage and integrity audit (`npm run rag:audit`)

### Document text and OCR

Document bytes are turned into page text by a separate pass, so a retrieved fact
can cite the page a reader would turn to:

```bash
npm run rag:ocr                  # documents still awaiting text
npm run rag:ocr -- --all         # redo every document
npm run rag:ocr -- --document 123
npm run rag:ocr -- --no-ocr      # text layer only, no model calls
npm run rag:ocr -- --dry-run     # report the workload without spending
```

**The text layer comes first.** Where a PDF has one it is used directly — exact,
free, and instant. Only pages that come back empty go to the model. On this
matter that is 349 of 361 pages from the text layer and 12 scans transcribed, so
OCR is a rounding error rather than the bulk of the cost.

Transcription uses Claude's PDF vision (`OCR_MODEL`, default `claude-opus-5`)
via the official Anthropic SDK. No OCR engine and no rasterising step: the pages
without text are carved into their own small PDF with `pdf-lib` and sent as a
document block. This is the one deliberately Claude-specific path — the chat
speaks the provider-agnostic AI SDK so it can run against a local model, but
transcribing scanned legal records is not a job a small local model does well.

**Page identity is never inferred from the output.** Each request carries a known
page count and the reply must return exactly that many entries, numbered by
position in the PDF it was given; the worker maps those positions back to real
page numbers. A reply with the wrong count is retried one page at a time, and a
page that still fails is omitted rather than stored with text that might belong
to its neighbour. Illegible words are transcribed as `[illegible]` rather than
guessed.

`indexDocumentText(matterId, document, pages)` in `src/lib/rag/sync.ts` is the
seam the pass writes through, so an external OCR engine could replace it without
touching the index.

- `src/lib/rag/pdf.ts` — text-layer reading and page extraction
- `src/lib/rag/ocr.ts` — Claude transcription, batched with per-page fallback
- `src/lib/rag/document-text.ts` — download, text layer, OCR, merge
- `scripts/ocr.ts` — the worker behind `npm run rag:ocr`

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Note: the file-based token store is for local development. On Vercel, move
`TokenStore` to the database before deploying.
