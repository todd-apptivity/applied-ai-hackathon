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

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Note: the file-based token store is for local development. On Vercel, move
`TokenStore` to the database before deploying.
