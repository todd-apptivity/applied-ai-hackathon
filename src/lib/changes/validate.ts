/**
 * Citation enforcement.
 *
 * The schema in `compose.ts` already makes an uncited sentence structurally
 * impossible — every `refs` array has `minItems: 1` and an `enum` of this
 * changeset's ids, so a schema-conforming response cannot contain a claim with
 * no source or a ref that does not exist.
 *
 * This runs anyway. Schema adherence is a property of the provider, not of the
 * request, and a local model with no native structured output will approximate
 * it. The rule the product actually makes is "no sentence without a source",
 * and a rule that depends on a provider behaving is not a rule. So the set is
 * re-checked here against the only authority that matters: the ids in the
 * changeset we built.
 */

import type { Changeset } from "./types";
import type { ComposedDigest, DigestSection, DigestSentence } from "./compose";

export interface ValidationReport {
  keptSentences: number;
  strippedSentences: number;
  /** Refs the model produced that this changeset does not contain. */
  unknownRefs: string[];
  /** Why sentences were dropped, for the response and the CLI. */
  reasons: string[];
  /** True when nothing survived and the deterministic digest was used. */
  fellBack: boolean;
}

/**
 * Bracketed ids written into prose. The UI renders citations from `refs`, so an
 * id left inline is a duplicate at best and a stale label at worst.
 */
const INLINE_REF = /\[[a-z_]+:[^\]\s]+\]/g;

function hasLetters(text: string): boolean {
  return /[a-z]/i.test(text);
}

function cleanText(text: string): string {
  return text.replace(INLINE_REF, "").replace(/\s{2,}/g, " ").trim();
}

export function validateDigest(
  draft: ComposedDigest,
  changeset: Changeset,
  deterministic: () => ComposedDigest,
): { digest: ComposedDigest; report: ValidationReport } {
  const allowed = new Set(changeset.events.map((event) => event.ref));
  const unknown = new Set<string>();
  const reasons: string[] = [];
  let kept = 0;
  let stripped = 0;

  const keepSentence = (sentence: DigestSentence): DigestSentence | null => {
    const refs = (sentence.refs ?? []).filter((ref) => {
      if (allowed.has(ref)) return true;
      unknown.add(ref);
      return false;
    });

    if (refs.length === 0) {
      stripped += 1;
      reasons.push("Dropped a sentence with no citation in this changeset.");
      return null;
    }

    const text = cleanText(sentence.text ?? "");
    if (!hasLetters(text)) {
      stripped += 1;
      reasons.push("Dropped a sentence with no readable text.");
      return null;
    }

    kept += 1;
    // Dedupe refs: the same id cited twice is one citation chip.
    return { text, refs: [...new Set(refs)] };
  };

  const sections: DigestSection[] = [];
  for (const section of draft.sections ?? []) {
    const sentences = (section.sentences ?? [])
      .map(keepSentence)
      .filter((item): item is DigestSentence => item !== null);
    if (sentences.length > 0) {
      sections.push({ heading: section.heading, sentences });
    }
  }

  const headlineRefs = (draft.headlineRefs ?? []).filter((ref) => {
    if (allowed.has(ref)) return true;
    unknown.add(ref);
    return false;
  });

  if (unknown.size > 0) {
    reasons.push(
      `The model produced ${unknown.size} ref(s) that are not in this changeset.`,
    );
  }

  // Nothing survived. A blank panel is the one outcome worse than plain prose,
  // and the deterministic digest is built from the same cited changeset.
  if (sections.length === 0) {
    reasons.push("No sentence survived validation; used the code-written digest.");
    return {
      digest: deterministic(),
      report: {
        keptSentences: 0,
        strippedSentences: stripped,
        unknownRefs: [...unknown],
        reasons,
        fellBack: true,
      },
    };
  }

  const headline = cleanText(draft.headline ?? "");

  return {
    digest: {
      // An uncitable headline falls back to the first section's lead sentence,
      // which is cited by construction.
      headline:
        headline && headlineRefs.length > 0
          ? headline
          : sections[0].sentences[0].text,
      headlineRefs:
        headlineRefs.length > 0 ? [...new Set(headlineRefs)] : sections[0].sentences[0].refs,
      sections,
    },
    report: {
      keptSentences: kept,
      strippedSentences: stripped,
      unknownRefs: [...unknown],
      reasons,
      fellBack: false,
    },
  };
}
