# Ninety: PRD for the Sapini Case Dashboard

Oct 2, 2026 · @Todd Bashor

## Summary

Ninety turns a Clio personal injury matter into a dashboard a new team member can read in 90 seconds, plus a separate, scoped view for each treating provider. Every fact on screen links to the Clio record or document page it came from.

The bet: most teams will summarize the Clio fields. Ninety also reads the documents, flags where the file contradicts itself, and makes the provider view two-way so providers can close the firm's open requests. It reads from Clio only and writes to its own database.

"Ninety" is a working name.

## Problem and context

Case management systems store everything about a matter but don't explain it. The dashboards shown at kickoff (Clio Manage, CasePeer, Lawmatics) list fields, contacts, and tasks, yet someone new to the case still can't tell what happened or what comes next.

Personal injury cases add a second audience. Providers often treat on a lien and get paid from the settlement, which can take years. They have no view into the case and depend on phone calls and emails to learn where it stands. Liens are usually negotiated down at the end, so what the firm shares with providers matters.

The hackathon matter, Sapini v. Ferrara and Metro-North, shows both problems clearly:

- 42 notes, 69 communications, 14 tasks, 17 calendar entries, 5 expenses, and 15 documents.
- Two medical bundles totaling 512 pages are scans with no text layer.
- The Clio record contradicts the documents in several places, including the statute of limitations status, a witness's contact history, coverage, and treatment status.
- The case is blocked by a treating surgeon who hasn't scheduled a surgery despite five requests.

## Goals, non-goals, and constraints

The goal is a working build that reads Sapini live from Clio, makes it digestible in 90 seconds, and survives a code review for hardcoding.

**Goals**

- A firm member opening the matter for the first time, or after two weeks away, can say who the client is, what happened, the injuries, the last event, and what's next within 90 seconds.
- A provider sees where the case stands, what the firm needs from them, and what's blocking it, without seeing strategy.
- Every fact on screen opens the note, email, or document page it came from.
- The build finds the Sapini answer key (see the acceptance test set) without any Sapini-specific code or prompts.

**Non-goals**

- A chat interface. The brief asks for visual digestion so users don't have to know what to ask.
- Predicting settlement value or timing. Ninety shows the file's own estimates, scenarios, and blockers, labeled as such.
- Resolving legal questions. Conflicts are flagged with both sources; attorneys decide.
- Multi-matter search, billing, or document drafting.

**Hard constraints from the organizers**

- Clio is input only. The OAuth app requests read scopes only, and no code path calls a Clio write endpoint.
- Any data Ninety creates (digests, shares, provider responses, view history) lives in its own database.
- The public GitHub repo, the 90-second Google Drive clip, and the submission form are due at 4:00 PM, with no grace window. Submission order sets presentation order, so submit early.
- The form asks for stack, where data lives outside Clio, which models run the digestion, and approximate cost per case.

## Users and the questions they ask

Ninety serves four people across two sides, and each feature exists to answer a question heard from them (slide 09).

**Firm side**

- **New team member** (paralegal or case manager picking up the file): needs the whole story fast.
- **Returning attorney** (opening the matter after weeks away): needs what changed, what's at risk, and the two KPIs.

**Provider side**

- **Lien or billing manager** at a treating practice: needs to know whether the case is alive, whether there's coverage, and what they're owed.
- **Treating physician or front office**: needs to know what the firm wants from them and whether the patient is keeping up with care.

| Question (from slide 09) | Asked by | Answered by | Priority |
| --- | --- | --- | --- |
| Get me up to speed without asking anyone | New team member | 90-second story | P0 |
| Show me the client's picture | Attorney | Header photo crop | P0 |
| If a date is on screen, where did it come from? Let me click to the source | Attorney | Provenance on every fact | P0 |
| What's overdue, coming, and waiting on someone else? | Attorney | Now, next, waiting | P0 |
| When did anyone last talk to the client? | Attorney | Header: last client contact | P0 |
| Somewhere in a 200-page scan are the primary injuries | New team member | OCR plus injuries panel | P0 |
| What is the case worth, and what coverage sits behind it? | Attorney | Value and coverage scenarios | P0 |
| Don't digest the whole case again every time | Attorney | Cached, incremental digestion | P0 |
| What does the firm need from my office right now? | Provider | Provider requests list | P0 |
| Is this case still alive? Is there coverage? | Provider | Provider status card | P0 |
| Let me adjust what the provider sees before I send it | Attorney | Share controls and preview | P0 |
| Out of 300 entries, show me the 10 that matter | New team member | Ranked timeline | P1 |
| What changed since I last opened this matter? | Returning attorney | Changes since last visit | P1 |
| How much has the firm spent? | Attorney | Costs line in header | P1 |
| Is my patient still showing up to treatment? | Provider | Attendance, confirmable by provider | P1 |
| Tell me when the case moves | Provider | Change digest per share | P2 |
| What did we share, and has anyone opened it? | Attorney | Share log with view events | P2 |

Ninety adds one question no one asked but every attorney will care about: **where does the file disagree with itself?** That's the conflicts panel, P0.

## Firm dashboard

One screen, read top to bottom in 90 seconds, with depth one click away. Every value carries a source chip that opens the Clio record or the document at the right page.

**P0**

1. **Header.** Client photo (face cropped from the photo ID, never the license itself), name, date of incident, case age, Clio stage, last client contact with days elapsed, and limitations status.
   - Limitations status reads pleaded defenses as well as the Clio field. If they disagree, the status shows "Needs attorney review," not green.
   - Acceptance: shows Sapini's last client contact as a 09/27/2026 phone call, with a link to that communication.
2. **90-second story.** Five or six plain sentences: who, what happened, injuries, treatment, where the case stands, what's next. Generated from extracted facts, each sentence linked to its sources.
   - Acceptance: no sentence without at least one source; regenerated only when underlying facts change.
3. **Now, next, waiting.** Three columns. Overdue tasks with days late; upcoming tasks and calendar entries for the next 30 days; and items waiting on outside parties, with days since that party last responded.
   - "Waiting" is computed from the communications log by counterparty, not from tasks alone.
   - Acceptance: SportsCare shows no reply since November 2023 despite four requests.
4. **Blockers.** A short chain showing what holds the case and what each blocker holds up in turn. Drawn from tasks, notes, and calendar entries that reference dependencies.
5. **Value and coverage.** The file's own valuation, labeled as an estimate, beside coverage shown as scenarios when sources conflict. A simple waterfall: gross, less unrecoverable no-fault, less known liens, less firm costs, with fee as an input.
   - Acceptance: Sapini shows two coverage scenarios, Metro-North self-insured versus Ferrara's $100,000 personal policy, each with sources.
6. **Injuries and treatment.** Injuries by body part, surgeries with dates, providers with visit counts and records status. Pulled from the OCR'd scans with page-level citations.
7. **Conflicts panel.** See the conflict detection section.

**P1**

8. **Ranked timeline.** All 162 entries, with the top ten shown by default. Rank favors recency, open items, blockers, and conflicts. Expand to see everything.
9. **Changes since last visit.** Per-user last-viewed time stored in Ninety's database; new or changed records since then are highlighted at the top.
10. **Costs.** Firm expenses to date in the header, with the list one click away. Sapini: $1,410 across five entries.

**P2**

11. Document reader with search across OCR'd pages, opening at the cited page.
12. Depth toggle: a two-minute view and a full view, per the quote "sometimes I need to dig into everything."

## Provider portal

Each treating provider gets its own scoped view, built from an attorney-approved snapshot. It's two-way: providers can answer the firm's requests, which turns visibility into a way to close the firm's own gaps.

**P0: what a provider sees**

1. **Status card.** The case stage in plain language ("In litigation, discovery ongoing"), the date of the last activity on the case, and whether coverage exists. The coverage amount is hidden by default.
2. **What we need from your office.** Open requests addressed to this provider, with dates asked and how many times. Sourced from tasks and outbound communications naming the provider.
3. **What's holding the case.** The blockers that involve this provider, written without strategy. No predicted settlement date.
4. **Your records and bills.** What the firm has received from this provider and when, and what's still outstanding.

**P0: sharing controls (firm side)**

5. **Preview before publish.** The attorney sees exactly what the provider will see, toggles fields on or off, and publishes. The published snapshot is frozen in Ninety's database until republished.
6. **Default-deny fields.** These never appear unless an attorney turns them on: coverage amounts, case value, liability analysis, credibility or prior-injury notes, other providers' information, attorney notes, and the client's ID or date of birth.
7. **Scoped access.** One unguessable link per provider per matter, revocable, with no Clio access behind it.

**P1**

8. **Provider responses.** A provider can answer a request: post a date, attach a document, confirm attendance, or add a note. Responses land in Ninety's database and appear on the firm dashboard as "pending review." Nothing is written to Clio; staff copy accepted items into Clio themselves.
9. **Attendance.** Upcoming treatment from the calendar, with the provider able to confirm or correct whether the patient attended.

**P2**

10. **Share log.** What was shared with whom, when, and every time the link was opened.
11. **Change digest.** When the snapshot is republished, the provider sees what changed since their last visit. Shown in-app for the demo; no real email is sent.

Acceptance: McCulloch's portal shows the outstanding surgical-date request at the top, with the request history, and contains none of the default-deny fields.

Why defaults matter: liens are negotiated down at settlement. Showing a provider a low coverage number could change that negotiation, so the attorney chooses.

## Conflict detection

Ninety flags places where two sources in the file disagree and shows both sides with links. It never decides which side is right.

All checks run on typed facts extracted from every source, so they work on any matter. Nothing in code or prompts names Sapini's people, dates, or amounts.

**Checks**

1. **Same fact, different values.** Group facts by entity and attribute (a surgery date, a policy limit, a visit count, a treatment status, a visit frequency) and flag groups whose values differ beyond a tolerance.
2. **Status versus pleadings.** A Clio field or task marked satisfied or complete while a pleading raises the same issue as a defense. Example pattern: limitations marked satisfied, limitations pleaded.
3. **Negative claim versus evidence.** A note asserting that something never happened ("no one contacted," "not received") while a document or communication shows it did.
4. **Two clocks.** A Clio date that disagrees with the document's own date, such as a received date earlier than the filing stamp, or an event logged months away from the date inside the report.
5. **Summary versus source.** A note that characterizes a document in a way the document doesn't support. The model compares the note's claim to the cited pages and quotes both.
6. **Record hygiene.** Duplicate communications and subjects that don't match their bodies. Shown at lower severity.

**How conflicts surface**

- A panel on the firm dashboard, sorted by severity: "Needs attorney review" first, "Data hygiene" last.
- Each card shows the two values, the source of each with a click-through, and one line on why it was flagged.
- Staff can mark a conflict reviewed or dismissed, with a note. That state lives in Ninety's database.
- Conflicts that touch a header value (limitations status, coverage, treatment status) change how the header displays that value.

Conflicts never appear in the provider portal.

## Architecture and data

Ninety is a read-only Clio sync, an ingestion pipeline that turns every source into cited facts, and a web app that renders only from those facts. Suggested stack: Next.js on Vercel, Postgres on Supabase or Neon, and a local ingestion worker for OCR.

**Pipeline**

1. **Sync.** Pull the matter, contacts, custom fields, notes, communications, tasks, calendar entries, expenses, and documents through the Clio API with read scopes only. Download documents from Clio, not from the local zips, so the build reads the case live as the rules require. Store each record with its Clio ID and updated time.
2. **Text.** Use the text layer where one exists. Pages without one go through OCR, keeping page numbers. Sapini's two medical bundles (512 pages) and the summons, letter to the judge, and photo ID are scans.
3. **Extract.** A model reads each chunk and returns typed facts: entity, attribute, value, date, a short supporting quote, and the source ID and page. Results are cached by document hash and extractor version.
4. **Derive.** Plain code, not a model, computes overdue and upcoming items, waiting-on-others, last client contact, costs, ranking, and the conflict checks.
5. **Compose.** The model writes the story, blocker chain, and provider summaries from facts only, citing fact IDs. Output is cached by a hash of its inputs and regenerated only when they change.
6. **Refresh.** When a user opens the matter, Ninety asks Clio for records changed since the last sync and reprocesses only those.

**Data model (Ninety's database)**

| Table | Holds |
| --- | --- |
| sources | One row per note, email, task, calendar entry, expense, custom field, or document page, with Clio ID, hash, and text |
| facts | Typed facts with value, date, quote, source ID, page, and extractor version |
| conflicts | Check type, linked fact IDs, severity, explanation, review status |
| digests | Cached story, blockers, and summaries keyed by input hash |
| provider\_shares | Provider, token, enabled fields, frozen snapshot, published and revoked times |
| provider\_responses | Provider replies, attachments, and review status |
| view\_events | Who opened what and when, for both sides |

**Engineering rules**

- No Clio write endpoint anywhere in the codebase; the OAuth app lists read scopes only, and the README says so.
- No matter-specific strings in code or prompts.
- Normalize dates: calendar entries and document received times come from Clio in UTC; display in the matter's local time.
- Sort communications by date; the Clio export isn't in date order.

**Models and cost per case**

A mid-tier Claude model handles extraction, summary-versus-source checks, and composition; a smaller one can handle classification. A first full ingest of Sapini is roughly 350,000 to 450,000 input tokens, most of it the OCR'd scans, plus 30,000 to 60,000 output tokens. Multiply by current model prices for the per-case figure on the form. Later refreshes cost a small fraction because only changed records are reprocessed.

## Acceptance test set

These are the results Ninety must produce on Sapini from generic code. They're a test set, not content: none of these values may appear in code or prompts. A repo grep for the client's, witness's, and providers' names should match only tests and the README.

| Expected result | Check | Side A | Side B |
| --- | --- | --- | --- |
| Limitations status shows "Needs attorney review" | Status versus pleadings | Clio limitations date 2026-04-22; "Limitations Date" task complete | Verified answer pleads a limitations defense and Public Authorities Law §1276 noncompliance |
| Pullano contact flagged | Negative claim versus evidence | Note of 2026-09-15: nobody has contacted him | Subpoena filed Nov 2, 2025, setting his deposition for Dec 8, 2025 |
| Coverage shown as two scenarios | Same fact, different values | Policy Limits field: defendant $100,000 / $300,000, marked confirmed | Insurance Carrier field and May 2023 notes: Metro-North self-insured, no stated ceiling |
| Treatment status flagged | Same fact, different values | Treatment Status field: never discharged, no MMI | Defense IME (Mar 31, 2026): plateaued, medically stationary |
| IME summary flagged | Summary versus source | Note of 2026-09-13: report records normal range of motion | IME report shows reduced ranges, with rotations marked refused |
| Date mismatches flagged | Two clocks | Clio received dates: IME report 2026-09-14, summons 2024-03-08, subpoena 2025-01-02 | Document dates: exam Mar 31, 2026; summons stamped Oct 2024; subpoena filed Nov 2, 2025 |
| Seat belt defense noted | Same fact, different values | Answer pleads failure to wear a seat belt | Defense IME history records a belted driver |
| SportsCare waiting since Nov 2023 | Waiting on others | Last inbound: Nov 19, 2023 | Four requests since, latest May 5, 2026 |
| McCulloch is the top blocker | Waiting and blockers | Five approaches for a right shoulder surgical date since May 5, 2026 | One reply, Sept 24, 2026; provider task overdue since Aug 25, 2026 |
| Last client contact | Derived | Phone call, Sept 27, 2026 | Clio communications log |
| Overdue tasks | Derived | McCulloch records task, due Aug 25, 2026 | Client commission records, due Sept 26, 2026 |
| Costs | Derived | $1,410 across five expenses | Clio expenses |
| Left shoulder surgery dated and cited | Extraction from scans | Bill of particulars: July 26, 2023 | Operative report page in the scanned bundle |
| Client photo shown | Image extraction | Face cropped from the photo ID | License number never displayed |

## Success metrics

For the hackathon, success is passing the 4:00 PM code screen and making the judges see the case in under 90 seconds.

| Metric | Target |
| --- | --- |
| Acceptance test set items found by generic code | At least 10 of 14 |
| Facts on screen with a working source link | 100% |
| Matter-specific strings in code or prompts | 0 |
| Clio write calls in the codebase | 0 |
| Time for someone new to answer who, what happened, injuries, last event, and next step | Under 90 seconds |
| Provider portal fields outside the attorney's approved set | 0 |
| Model calls when reopening an unchanged matter | 0 |

Beyond the hackathon, the measures that would matter to a firm are fewer "where are we on this?" calls from providers and less staff time spent briefing on a case.

## Build plan and demo

Build the pipeline first, because every screen depends on cited facts, and freeze code at 3:15 PM to leave time for the video and an early submission.

**Roles for a team of three**

- **Pipeline:** Clio sync, OCR, extraction, caching, conflict checks.
- **Firm UI:** header, story, now/next/waiting, blockers, value and coverage, conflicts panel, source viewer.
- **Provider and demo:** share controls, provider portal, response loop, README, video, submission form.

**Sequence**

1. **Until lunch:** read-only Clio sync working end to end; OCR running on the scans in the background; fact schema and extraction prompt producing cited facts for notes and communications.
2. **Lunch to 2:00 PM:** header, story, and now/next/waiting rendering from real facts with working source links. Provider portal reading a snapshot.
3. **2:00 to 3:15 PM:** conflicts panel, value and coverage scenarios, share preview and toggles. Provider response loop if on track.
4. **Checkpoint at 2:00 PM:** if the sync or extraction isn't solid, drop all P1 items and finish P0 only.
5. **3:15 PM:** code freeze. Run the acceptance test set and note any misses for the form.
6. **3:15 to 3:45 PM:** record and upload the 90-second clip; write the README (stack, read-only scopes, models, cost per case, what's unfinished).
7. **By 3:45 PM:** repo public, clip shared publicly, form submitted. Earlier submission means an earlier slot on stage.

**90-second clip**

1. **0:00 to 0:10.** The problem in one line: 162 entries and 512 scanned pages, and nobody can say what's happening.
2. **0:10 to 0:30.** Open Sapini: photo, story, blockers, now/next/waiting.
3. **0:30 to 0:45.** Click a date and land on the source page in the scan.
4. **0:45 to 1:05.** Conflicts panel: the "nobody contacted Pullano" note beside his subpoena, and limitations marked satisfied beside the pleaded defense.
5. **1:05 to 1:25.** Share preview for McCulloch, toggle a field, open the portal showing the surgical-date request, post a date, and watch it appear on the firm side as pending review.
6. **1:25 to 1:30.** Close: reads Clio, writes nothing, and the cost per case.

For the four-minute Top 7 pitch, play the clip, then spend the rest on the conflicts panel and why share defaults protect lien negotiations.

## Risks and open questions

The biggest risk is a confident fact with no real source, so every extracted fact must quote text that actually appears in its source, or it's discarded.

| Risk | Mitigation |
| --- | --- |
| Model invents or misreads a fact | Verify each fact's quote exists in the source text before saving; show the quote on hover |
| OCR errors on handwritten or low-quality medical pages | Keep page images one click away; mark OCR-derived facts as such |
| Too many conflicts, some trivial | Severity levels; hygiene items collapsed; reviewed or dismissed state saved |
| Code screen reads it as hardcoded | Generic checks and prompts; test set kept in tests; README explains how each feature is derived |
| Looks like another medical chronology tool | Lead the demo with conflicts and the provider loop, not the summary |
| Provider sees something privileged | Default-deny fields; preview required before publish; snapshot frozen until republished |
| Clio OAuth or sync eats the morning | Get read-only sync working first; build UI against cached data while extraction runs |
| Date errors from UTC conversion | Normalize to the matter's local time in one place |

**Questions for the attorneys in the room**

- [ ] In a New York case where no-fault and Medicaid paid much of the treatment, are these providers actually holding liens? Who is the realistic provider audience?
- [ ] Would you show a provider the coverage amount, or only whether coverage exists?
- [ ] Do you want conflicts on the main screen or in a separate prep view?
- [ ] Is a pleaded limitations defense like this one usually boilerplate, and should a dashboard surface it anyway?
- [ ] What would you never let a provider see, beyond strategy?
- [ ] Would you trust a provider-posted date, or does it always need staff confirmation first?
