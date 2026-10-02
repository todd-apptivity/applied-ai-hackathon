# Lawyer views on real data

Updated 2 Oct 2026, 15:05. Provider views are out of scope for now.

## What is built

The Case state and Timeline views now render a real Clio matter, on a desk and on a phone, and the Ask field answers from the case-file index.

| URL | What it is |
| --- | --- |
| `/matters` | The list of cases. Clicking one opens its case page. |
| `/matters/<id>/case` | The case page: the case view framed inside the app, with the chat as a floating widget. It shows the desk design on a wide window and the phone design on a narrow one, switching as the window resizes. |
| `/matters/<id>/case/view?device=desktop\|phone` | The view itself, as a self-contained document. Framed by the case page. |
| `/matters/<id>` | The change digest ("what changed since I last reviewed"), reachable by URL. |
| `POST /api/matters/<id>/ask` | `{ question, record? }` in, `{ answer, citations }` out. Used by the Ask field on a record and the phone view's Ask tab. |

| `/providers` | Firm-side list of treating providers on open cases, with links to the pages they would see. |
| `/provider/<contactId>` | A provider's own page: every case shared with their office. No firm navigation. |
| `/provider/<contactId>/cases/<matterId>` | One patient's case as that provider may see it. |
| `POST /api/speech` | `{ text }` in, WAV audio out. Speaks one line of the brief. |

The floating chat is the existing grounded chat (`CaseChatPanel`). It is hidden on a phone-width window, where the phone view has its own Ask tab.

The dev server runs on port 3123 (`npm run dev`).

### How it fits together

```
route handler  ->  loadMatterView()  ->  matterSource().load()   (adapter: live Clio today)
                         |                     |
                    deriveView()          getMatterBundle() + bundleToSources()
                         |
                 renderLawyerView()   fills src/views/lawyer-{desktop,phone}.html
```

| File | Role |
| --- | --- |
| `src/lib/matter/source.ts` | The adapter seam. `MatterSource.load()` returns `SourceRecord[]`, the same shape the SQLite `sources` table stores. `ClioLiveSource` reads Clio on every request. `MATTER_SOURCE` picks the adapter; a cached one is a SELECT over `sources` and is not built. |
| `src/lib/matter/derive.ts` | Pure: records to lanes, groups, events and case facts. No Clio, database or clock. |
| `src/lib/matter/view.ts` | Joins the two; builds Clio links with `sourceLink()`. |
| `src/lib/matter/render.ts` | Fills a view template with the data as script-safe JSON. |
| `src/lib/matter/respond.ts` | The shared GET handler for both views. |
| `src/views/lawyer-desktop.html`, `lawyer-phone.html` | The design mocks with their sample data removed. Each is one self-contained document, so it renders exactly as designed and shares no styles with the rest of the app. |
| `src/app/api/matters/[matterId]/ask/route.ts` | Reuses the chat agent, its `search_case_file` tool and its permission checks, as a single response. |
| `tests/matter-derive.test.ts` | Lanes, grouping, unanswered messages, overdue tasks, costs, and safe embedding, on an invented matter. |

### Case state on a desk

Two columns. Left, on the dark panel: the client's initials, name, phone and email, the Listen button, "Read the brief instead" and Need to know. Right: the brief (when opened), six tiles, now/next/waiting, activity by party, and the matter fields folded away.

### The brief and its audio

`src/lib/matter/brief.ts` builds the brief on the server from the records and the matter's fields: who, what happened (the summary field, if the matter has one), what to watch, who the firm is waiting on, and what is next. No line is written by a model.

The Listen button plays it. `src/lib/speech/engine.ts` synthesizes each line on this machine with a locally installed speech program (Flite by default, eSpeak NG as an alternative, chosen with `SPEECH_ENGINE`), so case text is not sent to a voice service. If the server has no speech program the views fall back to the browser's own voice, and if there is no voice at all the written brief opens.

### Provider pages

`src/lib/matter/provider.ts` builds a provider's view as an allow-list. From the whole matter it takes only: the subject and date of messages exchanged with that office, the name and due date of open tasks that name it, the title and time of calendar entries that name it, the names of documents that name it, the case stage, the date of the last activity, and whether an insurance carrier is recorded (never the amount). Notes, custom field values, expenses, other contacts, task descriptions and message bodies are never copied. `tests/matter-provider.test.ts` plants forbidden text in a fixture and asserts none of it appears.

These pages are a preview on live data. There is no login, no attorney approval step and no frozen snapshot yet, and providers cannot reply through them.

### Reading Clio live

A dropped connection to Clio is retried twice (`src/lib/matter/retry.ts`). If the read still fails, the view shows a page with a "Try again" button.

### What is computed (no model)

Lanes and groups from contact roles; every note, message, task, calendar entry, expense and document as an event; unanswered firm messages; overdue tasks; upcoming dates; who the firm is waiting on; silence per party; last client contact; firm costs; case age; the limitations task's date and status; the matter's custom fields.

Firm costs count only expense entries that Clio has totalled. Entries with a price but no total are shown on the file lane but are not counted.

### What is not built yet

- **The composed layer:** headline, story, blocker chain, contradictions, what happened, injuries, letters of representation. The views say "not yet analysed" in their place. The plan is one schema-constrained call, cached in `digests`, with every quote checked against its cited record, following `src/lib/changes/compose.ts`.
- **Limitations "needs review".** The tile shows what Clio records (the limitations task and whether it is marked complete). Flagging a pleaded limitations defense needs the composed layer and document text.
- **Stage history.** Clio gives only the current stage, so the stage strip and band are not drawn.
- **Value estimator.** Not ported; the matter's value fields are listed under Matter fields.
- **A cached source.** Every page load reads Clio (about 8 seconds for this matter).
- **Document contents.** The index holds document names and dates only until `npm run rag:ocr` is run, so Ask cannot yet answer from inside a pleading or a scan.
- **Deploying:** `render.ts` reads the templates from `src/views/` at run time. A serverless deploy needs those files included in the bundle.

## Decisions still open

1. `docs/mockup-firm-dashboard.html` is a second design for the same screen. The case view lives at its own URL for now, linked from the matter page, so neither replaces the other.
2. Whether the change digest on `/matters/<id>` should move into the case view.

## Checking it

- `npm test`, `npm run lint`, `npm run typecheck` (one error in `src/lib/rag/pdf.ts` predates this work).
- Open `/matters/<id>/case` and `/matters/<id>/case/phone`.
- The client's, witness's and providers' names appear nowhere under `src/`.
