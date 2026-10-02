# Changes since last visit

`/matters/<id>` answers one question: **what happened in this case since the last time I reviewed it?** Every sentence of the answer carries a citation that resolves to a Clio record, and the list behind it is an exact query rather than a search.

The chat panel sits beside it, answering the same matter from the same records.

## Why a change log exists

Clio's `updated_at` cannot answer "what is new to me". It records when Clio last touched a record, not when we first saw the touch — so a case imported in one pass has every record stamped with the import, and a window measured on Clio's clock returns either everything or nothing.

So `source_revisions` records our own observation: one row per change we noticed, with the prior content, written inside the transaction `upsertSources` already opens. Three timestamps stay distinct, and conflating them is the most misleading thing this subsystem could do:

| Field | Means |
| --- | --- |
| `occurred_at` | when it happened in the world (note date, task due date) |
| `clio_updated_at` | when Clio says the record was last touched |
| `observed_at` | when **we** learned — the axis every window is measured on |

A note dated 2023 that landed in the file today is not news from 2023. Events where `occurred_at` predates `observed_at` by more than `BACKDATE_DAYS` are flagged `backdated`, and both the prompt and the deterministic summary phrase them as *"a note dated 2023-05-07 was added to the file on 2026-10-02"*.

## The request path

```
/matters/[id]  ──>  <Suspense>  ──>  ChangesPanel   (server component)
                                          │
                                   openMatter()           ← session state machine
                                   resolveWindow()
                                          │
                                   refreshIfStale()        ← syncMatter, skipEmbedding
                                          │
                                   changesForPrincipal()   ← the only changeset seam
                                          │
                                 canAccessMatter → allowedKinds
                                          │
                                   buildChangeset()        ← exact SQL, NO search()
                                          │
                                  filterChangeEvents()
                                          │
                                   digest cache (input_hash)
                                          │
                                   composeDigest()         ← generateObject
                                          │
                                   validateDigest()        ← drops uncited sentences
```

Rendering the panel **is** the visit, which is why it is a server component: resolving the window advances the review session, the refresh talks to Clio, and the compose talks to a model. `POST /api/matters/<id>/changes` is the same path for anything outside the page.

| File | Role |
| --- | --- |
| `src/lib/rag/revisions.ts` | The only writer of `source_revisions`; the history watermark |
| `src/lib/rag/writer.ts` | Hooks the log into the existing hash-compare, insert, and prune paths |
| `src/lib/changes/checkpoint.ts` | The two-pointer review session; window resolution; the view log |
| `src/lib/changes/changeset.ts` | The exact time-window query, and the fallback |
| `src/lib/changes/classify.ts` | Revisions → events a lawyer recognises. Pure, no DB |
| `src/lib/changes/freshness.ts` | When to re-pull from Clio, and how often to force a full pull |
| `src/lib/changes/compose.ts` | The schema, the model call, and the no-model digest |
| `src/lib/changes/validate.ts` | Citation enforcement |
| `src/lib/changes/cache.ts` | `digests`, keyed by input hash |
| `src/lib/changes/digest.ts` | The orchestrator the route and the CLI both call |
| `src/lib/identity/` | `viewers` + the cookie that selects one |
| `src/lib/permissions/guard.ts` | `changesForPrincipal` |

## The checkpoint

One timestamp does not work. If opening the page set "last reviewed" to now, it would consume the very window the page is about to render, and a refresh would report "nothing changed" about changes you had not finished reading.

So there are two pointers per (viewer, matter):

- `reviewed_through` — the **committed** baseline, and the window's lower bound.
- `pending_through` — this **session's** high-water mark, and the upper bound.

Opening the matter moves only `pending_through`. A gap of more than `SESSION_IDLE_MS` (30 minutes, `CHANGES_SESSION_IDLE_MS`) counts as a new sitting: the previous session's `pending_through` is committed into `reviewed_through` first. So the baseline advances by itself — come back tomorrow and you see exactly what arrived since yesterday — while refreshing three times in one sitting changes nothing.

"Mark reviewed" commits early and starts a fresh session. Manual windows (7 / 30 days) are `readOnly` and never touch either pointer: reading a wider window to catch up is not the same act as reviewing the file.

## Grounding and citations

Change detection is a SQL window over `source_revisions`, never `search()`. Retrieval is recall-first by design — it sanitizes a query into OR'd prefix terms and ranks what comes back — which is right for "what does the file say about the left knee" and wrong for "what changed", where a miss is a lie.

The model therefore does one job: write prose over the exact list it was handed. Citations use the same refs as the chat agent (`passageRef`), so `task:1417201808` means the same record and opens the same page in either surface.

Three layers keep a sentence from shipping uncited:

1. **The schema.** `refs` is an `enum` of this changeset's ids with `minItems: 1`, so a conforming response structurally cannot invent an id or make an unsupported claim.
2. **`validateDigest`.** Re-checks every ref against the changeset anyway — schema adherence is a property of the provider, not of the request. Unknown refs are dropped *and reported* in the response.
3. **The fallback.** If nothing survives, `deterministicDigest` writes one sentence per change from the classifier's own summaries. It is cited by construction, needs no API key, and a plain panel beats a blank one.

`npm run digest:compose` prints the validation report. **`strippedSentences: 0` and `unknownRefs: []` is the target; anything else is a prompt bug, not a model quirk.**

## Caching

The PRD's target is "model calls when reopening an unchanged matter → 0". A digest is stored under a hash of `(kind, scope, prompt version, model, changeset fingerprint)`.

The fingerprint covers the permitted kinds, the window's **start**, and each event's ref, type, observation time, and deltas. It deliberately excludes the window's **end**, which moves to "now" on every request — including it would change the hash on every refresh and defeat the cache. The stored row keeps its own `window_to` so the UI can still say what the prose was composed against.

Including the model and prompt version means editing the prompt invalidates every cached digest automatically.

## Permissions

The same `Principal` and the same rules as the chat path, and the filter runs **before anything reaches the model** — see `src/lib/permissions/guard.ts`. Firm staff see the whole matter; a provider is scoped to one matter and to `PROVIDER_BASELINE_KINDS`, pushed into the SQL `WHERE` so privileged text is never read into the process.

One difference from `filterHits` matters. A search passage exposes its title and text; a change event exposes **more** — the excerpt and every delta's `from` and `to`. A custom field whose old value was a policy limit and whose new value is innocuous would pass a title-and-text screen while handing the model the limit in `delta.from`. So `filterChangeEvents` screens the title, summary, excerpt, and every delta field and value. `tests/changes-permissions.test.ts` covers that case specifically.

Unlike the chat stub, the matter-scope check is genuinely reachable here: a provider viewer carries its own `matter_id` from the `viewers` row rather than from the request, so replaying one against another matter raises `PermissionError` instead of silently re-scoping.

Provider digests are a demonstration of where the check goes, not a tested privacy boundary — `screenText` is still the keyword stub `docs/chat.md` describes.

The withheld counter under-reports, for the same reason it does on the chat path: denied kinds are excluded in the SQL rather than dropped afterwards — the right order, since privileged text is never read into the process — so `withheld.byKind` is usually 0 and a provider whose window contained forty notes still reports zero withheld. Counting them honestly needs a separate `COUNT(*)` per denied kind.

## The five answers

Every empty case is resolved before a model is involved.

| `state` | When | Model calls |
| --- | --- | --- |
| `first_visit` | No baseline yet, so "since" has no meaning | **0** |
| `no_changes` | The window resolved and held nothing | **0** |
| `no_history` | The window predates the change log and too much is unknown | **0** |
| `changes` (degraded) | Inferred from record timestamps, not tracked changes | 1, then 0 |
| `changes` | The normal path | 1, then 0 |

A matter indexed before the change log existed starts in `no_history`: saying "456 records are new" would be true of the index and false of the case. Change tracking begins at the next sync, and the watermark in `index_state` is what makes that claim honest.

## Running it

```sh
npm run rag:seed -- --matter <matter id>        # pull from Clio; writes the change log
npm run digest:viewers -- --seed                # a firm viewer keyed on the real Clio user
npm run digest:changes -- --matter <id> --days 30 --no-model
npm run digest:compose -- --matter <id>         # with the model, prints the validation report
npm run digest:review  -- --matter <id>         # commit the checkpoint
npm run dev                                     # then open /matters/<id>
```

`--no-model` prints the deterministic digest, so the whole changeset half is demonstrable with no API key and no UI — and it is the fastest way to tell a bad changeset from a bad prompt.

## Known gaps

- **Deletions lag.** `syncMatter` only prunes on a full pull, because an incremental response omits unchanged records and absence would look like removal. So tombstones — and the `record_removed` events that need them — appear only after a full sync. `refreshIfStale` forces one every `FULL_SYNC_EVERY_MS` (24h), which bounds the lag rather than removing it.
- **Metadata-only changes are invisible.** The content hash is over the rendered `text`, so a field that changed without changing that text does not register. In practice the source mappers render what matters — task status, due dates, custom field values, document versions all do change the hash — but it is a real limit, not a theoretical one.
- **`screenText` is a keyword stub**, and the digest widens its surface with deltas and prior excerpts. The rules are real and tested; the classifier behind them is not a privacy guarantee.
- **The demo data has no real change history.** Every `clio_updated_at` in the seeded index is the import day, so a fresh clone lands in `no_history` and the only tracked changes are the backfill. Showing anything interesting needs a genuine edit in Clio — complete a task, move a due date, then reload.
- **Prior text is capped** at `PREV_TEXT_CAP` (4000 chars) per revision. Fine for quoting, not a full version history.
- **No eval.** Whether the prose is faithful to the changeset beyond the citation check is untested.
- **`viewers` is not authentication.** A cookie names a row and anyone can change it. It exists so read state has a stable key and so the provider view can be demonstrated; the real version is a staff session plus a revocable `provider_shares` token.
