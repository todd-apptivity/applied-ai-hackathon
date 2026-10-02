# Design mocks: state as of 2 Oct 2026, 12:45

Read this first if you are picking up the dashboard design work. It covers what exists in `design/`, the decisions already made, and what is still open.

## What this folder is

Static HTML mocks for the Ninety case dashboard (PRD: `reference-material/Ninety PRD for the Sapini Case Dashboard.md`). They are being designed in plain HTML first and will be ported into the Next.js app afterwards. Nothing in `src/` has been touched by this work.

Each page is one self-contained file: inline CSS, inline JS, no build step, no dependencies. Open it directly in a browser.

| File | Audience | What it is |
| --- | --- | --- |
| `timeline.html` | Lawyer | Lane timeline of every record in a matter, with a reading area and an Ask field |
| `provider.html` | Provider | One patient's case as shared with one provider's office |
| `provider-home.html` | Provider | All of a provider's patients across shared cases |

`timeline.html` holds two views behind the tabs in its top bar: **Case state** (the landing view, a first guess to be refined) and **Timeline**. `timeline.html#timeline` opens straight on the timeline.

## Rules that apply to every mock

- **All data is invented.** The matter is "Whitlock v. Harbor Transit", client Dana Whitlock, firm Marlow & Finch LLP, providers Ridgeline Orthopedics and Northside Physical Therapy. Do not put real case names (Sapini, etc.) in these files: the PRD requires that no matter-specific strings appear in code. The invented matter mirrors the shape of the real one.
- **"Today" is fixed at 2026-10-02** in each file's script (`TODAY`).
- **Mock data sits at the top of each `<script>`**, clearly separated from rendering code, so it can be swapped for real data.
- **No fake-working features.** Anything that is a placeholder says so on screen (for example the Ask answer is labelled "Sample answer · design mock").
- **Every page must work at phone width** (checked at 400px) with no horizontal page scroll.
- **Faces are drawn SVG placeholders.** The real build crops the face from the client's photo ID. The PRD lists the client's ID as never shown to providers by default, so the photo should be an attorney-controlled share toggle. This is not decided.

## Palette: Evergreen (decided)

The user chose this over a near-black "Ink" and a violet "Plum". The tokens are duplicated in a `:root` block at the top of each file; they port to `src/app/globals.css` under Tailwind v4 `@theme` at integration.

| Role | Value |
| --- | --- |
| Strip background (`--ink`) | `#0e3b35` |
| Strip raised / line | `#165048` / `#22635a` |
| Strip text 1 / 2 / 3 | `#f5f1e4` / `#c2d8cf` / `#8fb3a7` |
| Paper / card / line | `#f5f1e4` / `#fffef9` / `#e3dcc6` |
| Paper text 1 / 2 / 3 | `#10231f` / `#4d5e58` / `#86948e` |
| Accent (buttons, links) | `#0e6b57` |
| Contradiction (reserved) | `#fab219` amber |
| Overdue / critical (reserved) | `#d03b3b` red |

Lane colors identify a party. On the dark strip / on paper:

| Lane | Strip | Paper |
| --- | --- | --- |
| Client | `#62aefc` | `#2a78d6` |
| Firm | `#6fe0b3` | `#12855d` |
| Providers | `#c4b5ff` | `#4a3aa7` |
| Defense | `#f0629a` | `#c9457a` |
| Court | `#f5f1e4` | `#10231f` |
| File | `#8fb3a7` | `#86948e` |

Rules for color:

- The structure is a dark green "instrument" strip on top and warm paper below for anything meant to be read.
- Amber and red are status colors only. Never use them for a lane or as decoration, and always pair them with an icon or label.
- Lane order is fixed (client, firm, providers, defense, court, file). Blue/violet and green/magenta are too close to tell apart side by side, so lanes always carry a text label and keep this order.
- Lane colors on the strip are lighter than the dataviz validator's recommended band, on purpose, so marks stand out on a saturated background. A near-identical set passed the neighbour-separation and contrast checks; the exact four shipped were not re-run.
- Typography: system sans for UI, a serif (`Iowan Old Style` / Palatino / Georgia) for headings and big numbers.

## `timeline.html` (lawyer)

Layout follows Gong's account page: a compact strip of lanes on top, a reading area below.

- **Lanes:** client, firm, a foldable "Medical providers" group (two providers), a foldable "Defense and court" group, and a file lane. Groups are folded by default and open with a `+` box. Folded, the label says how many parties have gone quiet.
- **Marks:** every record is a disc with a glyph for its type (email, call, note, task, hearing, document, expense). A hollow disc means sent with no reply yet.
- **Stacks:** records that would overlap on a lane collapse into one mark with shadow discs behind it and a count badge from three up. Clicking steps through them. Stacks regroup when the zoom changes.
- **Bands:** a record that involves several parties (a hearing, a deposition) appears on each lane with a soft column joining them. For an email or call the column appears on hover or selection.
- **Silence:** a dotted line and a "silent for 2 yr 11 mo" label on a lane whose party has not been heard from in 120 days or more. Only drawn when that lane is unfolded.
- **Contradictions:** amber arcs join the two records that disagree. Clicking one shows both quotes side by side. Three exist in the mock data.
- **File lane:** documents sit on the date they were added to the file. A dashed connector joins a document to the dated event it describes.
- **Today line:** the future is shaded to its right; an overdue task has a red ring.
- **Reading area:** left pane is the selected record's thread with a note where the thread went quiet; right pane is the full record, an "Open in Clio" chip (dead link), and the Ask field (placeholder answer).
- **Controls:** search dims non-matching marks; 3M / 1Y / ALL, Today, drag to pan, arrow keys or Previous / Next.
- **URL option:** `timeline.html#open` starts with both groups unfolded.

### Case state view (first draft, same file)

- **Hero:** client portrait, a one-sentence headline, and six tiles: last client contact, limitations (shows "Needs review" when a contradiction touches it), overdue, next date, case age, firm costs.
- **Stage strip:** every stage of the matter grouped under Pre-litigation and Litigation, with the date each was entered and the current one marked. The same history is drawn as a stage band under the lanes on the timeline (outlined = pre-litigation, filled = litigation).
- **Statute of limitations tile:** a countdown until suit is filed (amber inside 90 days, red inside 30), then the margin it was filed by. Shows "Needs review" when a contradiction touches it.
- **Need to know:** rule-based alerts that only appear when they apply: statute inside 90 days with no suit filed, limitations pleaded as a defense, dates inside the next 90 days, overdue tasks, letters of representation with no acknowledgment, no client contact in 30 days, other contradictions.
- **Letters of representation:** who was sent one, when, and whether they acknowledged it.
- **The story so far:** six sentences, each followed by source chips that jump to that record on the timeline.
- **What is holding the case:** a chain of blockers, the root one highlighted.
- **Now, next, waiting:** overdue tasks, upcoming dates, and parties with unanswered requests. Computed from the records, not written by a model.
- **Where the file disagrees with itself:** one card per contradiction with both quotes; clicking opens it on the timeline.
- **What happened:** the incident in one place: what, when, where, who, first care, and what is in dispute, with source chips.
- **Value estimator:** an interactive calculator. Amounts come from the file (medical bills, lost wages, liens, costs); sliders set the pain-and-suffering multiple, the client's share of fault and the fee; a dropdown picks between the two conflicting coverage readings and shows how much falls above the limit. Labelled as arithmetic, not a prediction, because the PRD lists predicting settlement value as a non-goal.
- **Injuries and treatment**, and **who we have heard from** (activity by quarter per party, with silence flagged).
- The story, headline, blocker chain, value and injuries are hand-written in a `CASE` object; in the real build a model composes them from extracted facts, each citing record ids.

## `provider.html` (one patient)

- **Header:** patient portrait and name, "Shared with {provider} by {firm}", an "← All patients" link to `provider-home.html`, the date the firm published the page, and a notifications bell.
- **Notifications tray:** opens from the bell. Items are overdue (red), needs action (amber) or information (green), unread until clicked. Clicking one scrolls to and highlights the related card. `provider.html#notifications` opens with the tray showing.
- **Five tiles:** open requests, longest wait, records outstanding, next visit, case status.
- **Left column:** "What we need from your office". Each request shows flags, how many times it was asked, a strip of asks and replies over time, and a response form. Only the first request starts expanded; others have a "Respond" button.
- **Right column:** where the case stands (with a five-stage bar), patient attendance (confirm or correct visits), what is holding the case, records and bills received and outstanding, and changes since the last visit.
- **Preview switcher:** a "Design mock only" bar switches between the two providers. The real portal has one private link per provider and no switcher.
- **Responses stay on the page.** In the real build they are stored as pending review and never written to Clio.

## `provider-home.html` (all patients)

- **Five tiles** that also filter the list: patients, open requests, cases that moved since the last look, settled with payment pending, gone quiet.
- **Do these first:** up to four cards for requests that are overdue or due within two weeks.
- **Patient list:** one row per patient, most urgent first, with face, name and firm, case status and stage bar, open requests, a 12-month strip of asks and replies with the latest case movement, next visit, and the office's own balance.
- **Search and filter chips** with counts.
- **Every row links to the same `provider.html`** (the Dana Whitlock mock), whichever patient is clicked.
- **No notifications bell here yet.**

## Open questions

- Stage history: Clio returns only the matter's current stage, not when each stage was entered. The stage strip and band need those dates from somewhere (inferred from records such as the filing date, or stored by Ninety each time it sees the stage change).
- Letters of representation are hand-listed in the mock. The real build has to recognise them among the communications and match acknowledgments to them.

- Should `provider.html` drop its "Since you last opened this page" card now that the notifications tray covers the same ground?
- Should the patient photo be shown to providers by default, or only when the attorney switches it on?
- "Your balance" on `provider-home.html` assumes the portal holds the provider's own billing total. Keep or drop?
- Should the firm fold into the "Defense and court" group on the timeline? It is currently its own lane.
- The PRD lists a chat interface as a non-goal. The per-record Ask field is narrower than that, but it cuts against the document.

## What exists outside this folder

- `src/lib/clio/`: read-only Clio client, working against the live API on `main`. Shapes worth knowing: the limitations date comes back as a task, custom fields are flat (`field_name`, `value`), tasks have no `complete` flag.
- Branch `origin/claude/festive-allen-9icbpa` (not merged when last checked): a searchable case-file index in SQLite with OCR for scanned pages and a `searchCaseFileTool` for a Claude agent. The Ask field should use that tool, and contradiction detection can build on its records. See `docs/rag.md` on that branch.
- `docs/lawyer-views-plan.md`: the earlier implementation plan for the lawyer views. Its design direction still holds, but its "defaults" section is out of date: use the SQLite index instead of a file cache, the existing seed-data reader instead of a new adapter, and `npm test` instead of vitest.
- `AGENTS.md` requires reading the bundled Next.js 16 docs in `node_modules/next/dist/docs/` before writing any Next.js code.

## How the mocks were checked

Rendered in headless Firefox at 1440px and 400px wide and inspected as screenshots:

```bash
firefox --headless --no-remote --profile "$(mktemp -d)" --window-size 1440,1000 \
  --screenshot /tmp/out.png "file://$PWD/design/timeline.html"
```

Scripts were syntax-checked with `node --check`. Click and hover behaviour was not exercised in a browser by the agent, so treat interactions as untested until someone tries them.

## Repo state

`design/` and `docs/` are untracked on `main`. Nothing from this work has been committed.
