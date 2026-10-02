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
