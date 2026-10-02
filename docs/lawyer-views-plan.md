# Lawyer views: lane timeline and case-state briefing

## Context

The PRD (`reference-material/Ninety PRD for the Sapini Case Dashboard.md`) asks for a matter a lawyer can absorb in 90 seconds. The repo only has the read-only Clio client (`src/lib/clio/`); there is no UI for a matter. The existing products (Clio, CasePeer, Lawmatics) show boxes of fields and a card-list timeline. We want something riskier that reads at a glance.

Agreed direction for the lawyer side (provider side is deferred):

1. **Timeline view** modelled on Gong's account page: a strip of lanes (one per party, plus a file lane) over a reading area, with an AI question field on each event.
2. **Current-state view**: a briefing with contradiction warnings and the task list.

## Defaults I am assuming (not yet confirmed by the user)

- **Documents:** first pass reads Clio text records only (notes, communications, tasks, calendar entries, expenses, custom fields). Documents appear on the file lane by name and date; their contents are not read yet. Contradictions that depend on PDF contents come in a later pass.
- **Data source:** live Clio when connected; otherwise a sample bundle loaded from a path in an env var. Clio is not connected on this machine today.
- **Storage:** a JSON file cache in a gitignored `.ninety/` directory behind an interface (same pattern as `TokenStore` in `src/lib/clio/token-store.ts`), to be swapped for Postgres later.
- **Models:** `claude-sonnet-5-5` for contradiction detection, headline and event questions. Needs `ANTHROPIC_API_KEY`.

## Before writing code

- `AGENTS.md` requires reading the bundled Next.js 16 docs first. Read in `node_modules/next/dist/docs/01-app/`: `01-getting-started/03-layouts-and-pages.md`, `05-server-and-client-components.md`, `06-fetching-data.md`, `08-caching.md`, `15-route-handlers.md`, and `02-guides/streaming.md`.
- Load the `claude-api` skill before writing any Anthropic SDK code.

## Routes

| Route | Purpose |
| --- | --- |
| `src/app/matters/[matterId]/layout.tsx` | Matter header (client, stage, case age, last client contact) and the State / Timeline switch |
| `src/app/matters/[matterId]/page.tsx` | Current-state briefing |
| `src/app/matters/[matterId]/timeline/page.tsx` | Lane timeline |
| `src/app/api/matters/[matterId]/ask/route.ts` | POST: question about one event, streamed answer with cited record ids |

Link each matter on the existing `/clio` page (`src/app/clio/page.tsx`) to `/matters/{id}`. Follow the existing `PageProps<...>` / `RouteContext<...>` typing and async `params` used in `src/app/clio/page.tsx` and `src/app/api/clio/matters/[matterId]/route.ts`.

## Data layer (`src/lib/matter/`)

- **`source.ts`**: `loadMatterBundle(matterId)` returns the existing `MatterBundle` type. Uses `getMatterBundle` from `src/lib/clio/resources.ts` when `isConnected()`; otherwise reads the file named by `NINETY_FIXTURE_PATH`.
- **`seed-adapter.ts`**: converts the seed-format JSON (`reference-material/sapini-clio-data.json` is Clio POST bodies with `{{placeholder}}` ids) into a `MatterBundle` by assigning synthetic numeric ids and resolving placeholders. Generic: it knows the seed format, not the matter.
- **`events.ts`**: normalises a bundle into `TimelineEvent[]`: `id`, `kind` (note, email, call, task, calendar, expense, document), `occurredAt`, `addedAt`, `title`, `body`, `actorPartyId`, `counterpartyIds`, `direction`, `clioUrl` (from `clioLinks` in `resources.ts`).
- **`parties.ts`**: builds lanes from the matter client, `relationships` (the relationship `description` gives the role), and the firm. Communications go on the sender's lane using `senders`/`receivers`. Anything without a clear actor goes on the file lane only.
- **`dates.ts`**: the single place that converts Clio UTC timestamps to the matter's local time (PRD engineering rule).
- **`derive.ts`**: plain code, no model: overdue tasks with days late, items in the next 30 days, waiting-on-others per counterparty (last inbound date, outbound count since), last client contact, expense total. Sort communications by date first; Clio does not return them in order.

## Analysis layer (`src/lib/analysis/`)

- **`cache.ts`**: file cache keyed by a hash of inputs plus a prompt version, so reopening an unchanged matter makes zero model calls (PRD metric).
- **`conflicts.ts`**: one model pass over the text records returning contradictions: check type, severity, two sides (value, event id, supporting quote), and one line on why. Discard any contradiction whose quote does not appear verbatim in its cited record. Prompts name no matter-specific people, dates or amounts.
- **`headline.ts`**: one or two sentences on where the case stands and what holds it, each citing event ids.
- **`ask.ts`**: answers a question about a selected event. Context is that event plus the matter's other text records; the answer must cite record ids, which render as links back to the lanes.

## UI (`src/components/matter/`)

Timeline view, top to bottom:

- **Search and range bar**: search across all record text; zoom presets (3 months, 1 year, all); a Today jump.
- **`LaneStrip`** (client component, SVG): one row per party plus the file lane; icon per event kind; today marker with future deadlines to its right; hollow marks for firm requests with no reply since; arcs joining the two events of a contradiction; thin connectors from a document's file-lane date to the dated event it describes, when both are known.
- **Reading area**: left pane shows the selected event in its thread (neighbouring events with the same counterparty) with previous / next; right pane shows the full record, its Clio source link, and the **Ask** field.

Current-state view, top to bottom:

- **Headline** with source chips.
- **Warnings**: one card per contradiction, both values side by side, each linking to its event on the timeline.
- **Party pulse**: one row per party with days since last heard from, a small activity sparkline, and what they owe.
- **Tasks**: overdue, coming up, waiting on someone else.

Model-backed sections show a "not yet analysed" state when there is no API key or cache, so the code-derived parts work on their own.

Update `src/app/layout.tsx` metadata and `src/app/globals.css` tokens for the new visual language; add `ANTHROPIC_API_KEY` and `NINETY_FIXTURE_PATH` to `.env.example`; add `/.ninety/` to `.gitignore`.

## Build order

1. `npm install`; read the Next docs listed above.
2. Data layer with the seed adapter; unit tests for `derive.ts`.
3. Matter layout, lane strip and reading area on real records (no model).
4. Current-state view from derived data.
5. Analysis layer: cache, contradictions, headline; wire warnings and arcs.
6. Ask route and field.

## Verification

- `npm run lint` and `npx tsc --noEmit` pass.
- Tests (add `vitest` as a dev dependency) run `derive.ts` against the sample bundle and check PRD acceptance values, which live only in tests: last client contact is a phone call on 2026-09-27, costs total $1,410 across five expenses, two overdue tasks, and the provider with no inbound reply since November 2023.
- `NINETY_FIXTURE_PATH=reference-material/sapini-clio-data.json npm run dev`, then open `/matters/1`: lanes render all 162 events, selecting a mark fills the reading area, zoom and Today work, and the state view shows tasks and party pulse.
- With `ANTHROPIC_API_KEY` set: warnings appear with two cited sides, arcs draw on the strip, an event question returns an answer with working record links, and a second load makes no model calls (check the cache directory and server log).
- `grep -ri` for the client's, witness's and providers' names matches only tests, the README and `reference-material/`.
- Confirm no non-GET Clio call was added (`src/lib/clio/client.ts` already throws on other verbs).
