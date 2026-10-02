/**
 * Turning a changeset into prose.
 *
 * Two routes to the same shape. `deterministicDigest` writes one sentence per
 * change from the code-generated summaries — no model, no API key, no network —
 * and is both the fallback and the way to debug a bad digest. `composeDigest`
 * asks the model to do it better, over exactly the same cited set.
 *
 * The schema is declared from plain JSON Schema rather than Zod, matching
 * `@/lib/chat/tool`: that is what keeps a locally hosted model working, since
 * nothing provider-specific appears in the declaration. It also carries the
 * citation rule structurally — every `refs` array is an enum of this
 * changeset's ids with `minItems: 1`, so a conforming response cannot cite
 * something that does not exist or claim something with no source at all.
 */

import { generateObject, jsonSchema } from "ai";

import { chatModel, chatModelId } from "@/lib/ai/model";
import type { Principal } from "@/lib/permissions/types";

import { changeDigestPrompt, renderChangeset } from "./prompt";
import type { Changeset, ChangeEvent } from "./types";
import { validateDigest, type ValidationReport } from "./validate";

export { DIGEST_PROMPT_VERSION } from "./prompt";

/**
 * The headings a digest may use. A closed set, because "what a lawyer must act
 * on first" is a product decision and not one to re-litigate per request.
 */
export const DIGEST_HEADINGS = [
  "What moved",
  "Deadlines and dates",
  "Waiting on others",
  "Documents and records",
  "Removed from the file",
] as const;

export type DigestHeading = (typeof DIGEST_HEADINGS)[number];

export interface DigestSentence {
  text: string;
  /** Change ids supporting this sentence. Never empty by the time it ships. */
  refs: string[];
}

export interface DigestSection {
  heading: DigestHeading;
  sentences: DigestSentence[];
}

export interface ComposedDigest {
  headline: string;
  headlineRefs: string[];
  sections: DigestSection[];
}

export interface ComposeResult {
  digest: ComposedDigest;
  report: ValidationReport;
  usage: { inputTokens: number | null; outputTokens: number | null };
  /** Null when no model was involved. */
  model: string | null;
}

const MAX_SENTENCES_PER_SECTION = 6;

function digestSchema(refs: string[]) {
  const refArray = {
    type: "array",
    // The enum IS the enforcement: a conforming response cannot invent an id.
    items: { type: "string", enum: refs },
    minItems: 1,
    maxItems: 4,
  } as const;

  return jsonSchema<ComposedDigest>({
    type: "object",
    properties: {
      headline: {
        type: "string",
        maxLength: 160,
        description: "One line naming the most consequential change.",
      },
      headlineRefs: refArray,
      sections: {
        type: "array",
        maxItems: DIGEST_HEADINGS.length,
        items: {
          type: "object",
          properties: {
            heading: { type: "string", enum: [...DIGEST_HEADINGS] },
            sentences: {
              type: "array",
              minItems: 1,
              maxItems: MAX_SENTENCES_PER_SECTION,
              items: {
                type: "object",
                properties: {
                  text: {
                    type: "string",
                    maxLength: 320,
                    description:
                      "One sentence about one change. No bracketed ids in here.",
                  },
                  refs: refArray,
                },
                required: ["text", "refs"],
                additionalProperties: false,
              },
            },
          },
          required: ["heading", "sentences"],
          additionalProperties: false,
        },
      },
    },
    required: ["headline", "headlineRefs", "sections"],
    additionalProperties: false,
  });
}

/* --- the no-model route --------------------------------------------------- */

/** Which heading a change belongs under, by type. */
function headingFor(event: ChangeEvent): DigestHeading {
  switch (event.type) {
    case "task_due_moved":
    case "calendar_rescheduled":
    case "calendar_added":
    case "calendar_cancelled":
      return "Deadlines and dates";
    case "field_changed":
      return event.weight >= 90 ? "Deadlines and dates" : "What moved";
    case "document_added":
    case "document_revised":
    case "document_text_indexed":
      return "Documents and records";
    case "communication_logged":
    case "communication_revised":
      return "Waiting on others";
    case "record_removed":
      return "Removed from the file";
    default:
      return "What moved";
  }
}

/**
 * One sentence per change, straight from the classifier.
 *
 * Plainer than the model's prose and just as cited, which is why it is a
 * legitimate answer rather than an error state.
 */
export function deterministicDigest(changeset: Changeset): ComposedDigest {
  const grouped = new Map<DigestHeading, DigestSentence[]>();

  for (const event of changeset.events) {
    const heading = headingFor(event);
    const list = grouped.get(heading) ?? [];
    if (list.length >= MAX_SENTENCES_PER_SECTION) continue;
    list.push({ text: event.summary, refs: [event.ref] });
    grouped.set(heading, list);
  }

  const sections: DigestSection[] = DIGEST_HEADINGS.filter((heading) =>
    grouped.has(heading),
  ).map((heading) => ({ heading, sentences: grouped.get(heading)! }));

  const lead = changeset.events[0];
  const count = changeset.events.length;

  return {
    headline: lead
      ? `${count} change${count === 1 ? "" : "s"} ${changeset.window.label}, led by: ${lead.summary}`
      : `No changes ${changeset.window.label}.`,
    headlineRefs: lead ? [lead.ref] : [],
    sections,
  };
}

/* --- the model route ------------------------------------------------------ */

export async function composeDigest(params: {
  principal: Principal;
  matterLabel: string;
  changeset: Changeset;
  signal?: AbortSignal;
}): Promise<ComposeResult> {
  const { changeset } = params;
  const fallback = () => deterministicDigest(changeset);

  if (changeset.events.length === 0) {
    return {
      digest: fallback(),
      report: {
        keptSentences: 0,
        strippedSentences: 0,
        unknownRefs: [],
        reasons: ["No changes to compose."],
        fellBack: true,
      },
      usage: { inputTokens: null, outputTokens: null },
      model: null,
    };
  }

  const refs = changeset.events.map((event) => event.ref);
  const model = chatModelId();

  const result = await generateObject({
    model: chatModel(),
    schema: digestSchema(refs),
    schemaName: "change_digest",
    schemaDescription:
      "A cited briefing on what changed in one legal matter during one window.",
    system: changeDigestPrompt(params.principal, params.matterLabel),
    prompt: renderChangeset(changeset),
    abortSignal: params.signal,
  });

  const { digest, report } = validateDigest(result.object, changeset, fallback);

  return {
    digest,
    report,
    usage: {
      inputTokens: result.usage?.inputTokens ?? null,
      outputTokens: result.usage?.outputTokens ?? null,
    },
    model,
  };
}
