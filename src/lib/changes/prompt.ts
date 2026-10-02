/**
 * The change digest's instructions.
 *
 * The model's job here is narrower than the chat agent's: it is not searching
 * and not deciding what is true. It receives the complete, exact list of
 * changes — already filtered to what this viewer may read — and turns it into
 * prose. Everything it may say is in that list; everything in that list is
 * already classified and summarized by code.
 *
 * The scope blocks are shared with the chat prompt so a provider cannot be
 * told one thing by one surface and another by the other.
 */

import { FIRM_SCOPE, PROVIDER_SCOPE } from "@/lib/chat/grounding";
import { kindLabel } from "@/lib/chat/types";
import type { Principal } from "@/lib/permissions/types";

import { eventLabel, type Changeset } from "./types";

export const DIGEST_PROMPT_VERSION = 1;

const DIGEST_RULES = `
You are writing a short "what changed" briefing about one legal matter, for someone who last reviewed the file earlier and wants to know what has happened since.

You are NOT searching. You have been handed the complete and exact list of changes for this window, and it is the only thing you may describe.

- Describe only the changes in the list. Add no background, no summary of the case, no inferred cause, consequence, or next step. If something seems missing from the list, it is not yours to supply.
- Every sentence must cite at least one change id in its \`refs\` array. A sentence you cannot cite must not be written. Writing fewer sentences is always correct; writing an uncited one never is.
- Put ids in \`refs\` only. Write no bracketed ids inside \`text\`.
- Distinguish when something HAPPENED from when the file LEARNED it. An entry marked BACKDATED describes an earlier date but was added to the file recently: write "a note dated <happened> was added on <learned>", never "on <happened> the firm ...". Getting this wrong is the worst mistake you can make here.
- Use the exact dates, names, amounts, and statuses given. Do not round, reformat, convert between time zones, or infer a value that is not written.
- Lead with what a lawyer must act on: matter status changes, deadline and limitations dates moving, tasks completed or newly overdue, hearings rescheduled. Routine logging comes last, or not at all.
- At most one sentence per change. Prefer omitting a minor change to padding the briefing with it.
- Group related changes under the given headings. Use only headings that earn a sentence; omit the rest.
- If the list is marked as truncated history, say so in exactly one sentence and do not imply the rest of the file is unchanged.
- Plain language. No preamble, no sign-off, no "I reviewed".

The headline is one line naming the most consequential change, or stating plainly that only routine activity occurred.
`.trim();

export function changeDigestPrompt(principal: Principal, matterLabel: string): string {
  const scope = principal.kind === "firm" ? FIRM_SCOPE : PROVIDER_SCOPE;
  return [
    DIGEST_RULES,
    scope,
    `Matter under discussion: ${matterLabel}.`,
  ].join("\n\n");
}

/**
 * Render the changeset as the user message.
 *
 * Labelled lines in the same idiom the source mappers use, because a bare value
 * is ambiguous and "Learned: 2026-10-02" is not. Order is weight then recency,
 * fixed by the changeset builder, so the same data always renders byte for byte
 * the same — which is what lets prompt caching bite and what makes a cached
 * digest reproducible.
 */
export function renderChangeset(changeset: Changeset): string {
  const header = [
    `Window: ${changeset.window.label}`,
    changeset.window.from
      ? `Changes observed after ${changeset.window.from} and up to ${changeset.window.to}.`
      : `Everything we have observed up to ${changeset.window.to}.`,
    `Changes in this list: ${changeset.events.length}.`,
    changeset.history.truncated
      ? changeset.history.startsAt
        ? `TRUNCATED HISTORY: change tracking for this matter only starts at ${changeset.history.startsAt}. Records already on file before then are not listed as changes.`
        : "TRUNCATED HISTORY: this matter has no change tracking before now, so the list may describe records that were already on file."
      : null,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");

  const blocks = changeset.events.map((event) => {
    const lines = [
      `[${event.ref}] ${event.type} — ${eventLabel(event.type)}`,
      `Record: ${kindLabel(event.kind)}`,
      `Title: ${event.title}`,
      event.occurredAt ? `Happened: ${event.occurredAt}` : null,
      `Learned: ${event.observedAt}`,
      event.backdated
        ? "BACKDATED: this describes an earlier date but reached the file recently."
        : null,
      event.deltas.length > 0
        ? `Changed: ${event.deltas
            .map((d) => `${d.field}: ${d.from ?? "(none)"} -> ${d.to ?? "(none)"}`)
            .join("; ")}`
        : null,
      `Code summary: ${event.summary}`,
      event.excerpt ? `Excerpt: ${collapse(event.excerpt)}` : null,
    ].filter((line): line is string => line !== null);

    return lines.join("\n");
  });

  return [header, "", ...interleave(blocks)].join("\n");
}

/** Blank line between blocks, so one change does not read into the next. */
function interleave(blocks: string[]): string[] {
  const out: string[] = [];
  for (const block of blocks) {
    out.push(block, "");
  }
  return out;
}

/** Excerpts are for identification, not reading: one line, bounded. */
function collapse(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 400 ? `${flat.slice(0, 400)}…` : flat;
}
