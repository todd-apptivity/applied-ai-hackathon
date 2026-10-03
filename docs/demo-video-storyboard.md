# 90-second demo storyboard

Target: 90 seconds, screen recording plus voiceover, no live typing. Cut from a
longer clean take; never record the demo as one unbroken performance.

## Time budget

The original plan gave the dashboard 20 seconds and the close 5. The dashboard
has ten regions in it — 20 seconds either rushes all ten or shows three and
looks sparse. Conflicts are the thing no competing team will have, so the
budget moves time toward them.

| Beat | Was | Now | Why |
| --- | --- | --- | --- |
| 1. Problem | 0:00–0:10 | 0:00–0:08 | One line needs no more. |
| 2. Open the case | 0:10–0:30 | 0:08–0:26 | Two regions, not ten. |
| 3. Date to source page | 0:30–0:45 | 0:26–0:38 | A click and a landing. |
| 4. Conflicts | 0:45–1:05 | 0:38–1:00 | The differentiator; gets the most room. |
| 5. Provider view | 1:05–1:25 | 1:00–1:20 | Unchanged length. |
| 6. Close | 1:25–1:30 | 1:20–1:30 | Read-only claim plus cost needs 10s, not 5. |

## Beat 1 — the problem (0:00–0:08)

**Screen.** Cold open on the Clio matter as it actually is: the records list,
scrolled fast, then a scanned medical page with no text layer. No app chrome
yet.

**Voiceover.** "This personal injury case has a hundred and sixty-two records
and five hundred and twelve scanned pages. Nobody on the team can tell you
what's happening in it."

**Note.** The two numbers must be read off the live sync, not typed into the
script. The live workspace does not match the reference JSON — there are no
calendar entries in it, which drops the entry count below 162. Recount against
whatever the demo machine will actually sync from, and say that number. A
figure the judges can disprove by opening the repo is worse than a smaller one.

## Beat 2 — open the case (0:08–0:26)

**Screen.** Cut to `/matters/{id}` already loaded. Two moves only:

1. The header, held for about four seconds: cropped client face, case status
   with the progress bar, then the four figures on one line — last contact,
   coverage, case value, money spent.
2. "Changes Since Your Last Review", scrolled so Overdue / Conflicts /
   Upcoming are all in frame, with one citation chip visible.

Do not pan the injury visualization or the timeline here. They are beat 3 and
beat 4 material.

**Voiceover.** Use the narrated brief as the voiceover for this beat. Click
"Listen to Brief" on camera and let the generated audio carry the next eight
seconds — the feature demonstrates itself and costs no extra time. Follow with
one line in your own voice: "Every number on this screen is a link to the
record it came from."

**Risk.** If the brief audio is not ready, read the brief text aloud instead
and do not click the button; an unresponsive button on camera reads as broken.

## Beat 3 — a date to its source page (0:26–0:38)

**Screen.** Click a date in the brief or a citation chip on a change card.
Land on the page inside the scanned bundle, with the supporting line
highlighted and the page number visible. Hold the highlight for two seconds.

**Voiceover.** "Click any date and you land on the page it came from — page
three hundred and something of a scan that had no text in it this morning."

**Gap.** Citations currently open Clio in a new tab
([change-citation.tsx:35](../src/components/changes/change-citation.tsx#L35)).
Leaving the app mid-demo throws away the beat. This beat needs an in-app page
view; see the build list.

## Beat 4 — conflicts (0:38–1:00)

The hero beat. Two cards, in this order, each card held long enough to read
both sides.

**Card one — the negative claim.** Note dated 2026-09-15 saying nobody has
contacted the witness, beside the subpoena filed 2025-11-02 setting his
deposition. Both sides on screen at once, both with source links.

**Card two — status versus pleadings.** Limitations marked satisfied in Clio
and the task closed, beside the answer that pleads a limitations defense. Then
cut up to the header and show that the limitations chip reads "Needs attorney
review" rather than green, because of that card.

**Voiceover.** "Then it does the thing a summary can't. It finds where the file
disagrees with itself. A note says nobody contacted this witness. His subpoena
was filed ten months earlier. Limitations are marked satisfied here — and
pleaded as a defense here. It doesn't decide who's right. It shows both sides
and who to ask."

**Note.** The header-chip cut is what sells it: the conflict is not a sidebar,
it changes what the top of the screen says.

## Beat 5 — provider view (1:00–1:20)

**Screen.** Flip the viewer switcher to the provider, on camera, and hold the
same matter in both states so the diff is visible: coverage, case value, money
spent and the attorney notes are gone; the open request for a surgical date is
at the top. Then the Requested / Shared / Unread row and the per-provider rows.

**Voiceover.** "The same case, to a treating provider. Coverage, case value and
attorney notes are gone by default — liens get negotiated down at settlement,
so what a provider sees is the attorney's call. What's left is what the firm
needs from them."

**Honesty line.** Say "the permission checks are stubbed for the demo" or leave
the amber banner readable in frame. It is already on the page
([page.tsx:88](../src/app/matters/%5BmatterId%5D/page.tsx#L88)) and judges who
read code will find it either way.

**If the response loop lands.** Post a date as the provider, cut back to the
firm side, and show it arriving as pending review. That is a stronger ending to
this beat than the field diff — but it is the first thing to cut if time runs
short, because the diff already carries the argument.

## Beat 6 — close (1:20–1:30)

**Screen.** One card, no app. Three lines:

- Reads Clio. Writes nothing. Read scopes only.
- Everything we generate lives in our own database.
- Cost per case: one figure, measured from the real ingest.

**Voiceover.** "It reads Clio and writes nothing back. One full pass over this
case costs about [figure]. Reopening it unchanged costs nothing, because
nothing is re-read."

**Note.** Measure the figure from the actual ingest before recording. The PRD's
350k–450k input token range is an estimate, not a result.

## What the video needs that is not built

Ordered by how much video breaks without it.

| Need | Beat | State |
| --- | --- | --- |
| Conflicts panel, two cards, both sides cited | 4 | Not built. The whole hero beat. |
| In-app document page view, opening at the cited page | 3 | Not built. OCR and page numbers exist in the index; the viewer does not. |
| Header: photo crop, status bar, last contact / coverage / value / spent | 2 | Not built. The page shows a label and a viewing-as line. |
| Limitations chip that reads "Needs attorney review" on conflict | 4 | Not built. Depends on conflicts. |
| Narrated brief with a play control | 2 | Not built. Fallback: read it aloud. |
| Provider field diff visible on the same matter | 5 | Partly built — switcher and redaction work; the removed-field regions do not exist yet to be visibly removed. |
| Injury visualization, ranked timeline | — | Not built, and not needed. Both are off the shot list. |
| Provider response loop | 5 | Not built. Optional. |

## Recording rules

- Record at 1280×800 or smaller. A 4K screen recording scaled into a 90-second
  clip makes every label unreadable.
- Seed and warm the cache before recording. A model call on camera is dead air,
  and a cache miss during beat 2 costs the beat.
- No cursor hunting. Know every click target before the take.
- Record the voiceover separately and cut the screen to it, not the reverse.
- Export and watch it once at full size before uploading. The first failure
  mode is text too small to read.
