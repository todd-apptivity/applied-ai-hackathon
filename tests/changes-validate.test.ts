/**
 * Citation enforcement.
 *
 * The product rule is "no sentence without a source". The schema makes an
 * uncited sentence structurally impossible, but schema adherence is a property
 * of the provider, so the rule is re-checked here against the only authority
 * that matters: the refs in the changeset we built.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ComposedDigest } from "@/lib/changes/compose";
import { validateDigest } from "@/lib/changes/validate";
import type { ChangeEvent, Changeset } from "@/lib/changes/types";
import { countEvents } from "@/lib/changes/types";

function event(ref: string): ChangeEvent {
  const [kind, clioId] = ref.split(":");
  return {
    ref,
    type: "note_added",
    kind,
    clioId,
    page: null,
    title: `Record ${clioId}`,
    summary: `Note added: Record ${clioId}`,
    occurredAt: "2026-10-01",
    observedAt: "2026-10-02T18:00:00.000Z",
    clioUpdatedAt: null,
    backdated: false,
    deltas: [],
    excerpt: null,
    clioUrl: null,
    weight: 60,
  };
}

function changeset(refs: string[]): Changeset {
  const events = refs.map(event);
  return {
    matterId: 4242,
    window: {
      from: "2026-10-01T00:00:00.000Z",
      to: "2026-10-02T18:00:00.000Z",
      kind: "checkpoint",
      label: "since you last reviewed this on 2026-10-01",
      readOnly: false,
    },
    events,
    counts: countEvents(events),
    history: { startsAt: "2026-09-01T00:00:00.000Z", truncated: false },
    degraded: false,
    totalSources: 10,
    fingerprint: "test",
  };
}

const DETERMINISTIC: ComposedDigest = {
  headline: "Code-written fallback",
  headlineRefs: ["note:1"],
  sections: [
    { heading: "What moved", sentences: [{ text: "Fallback sentence.", refs: ["note:1"] }] },
  ],
};

function validate(draft: ComposedDigest, refs = ["note:1", "note:2"]) {
  return validateDigest(draft, changeset(refs), () => DETERMINISTIC);
}

describe("uncited sentences", () => {
  it("drops a sentence with an empty refs array", () => {
    const { digest, report } = validate({
      headline: "Something happened",
      headlineRefs: ["note:1"],
      sections: [
        {
          heading: "What moved",
          sentences: [
            { text: "A note was added.", refs: ["note:1"] },
            { text: "The case is going well.", refs: [] },
          ],
        },
      ],
    });

    assert.equal(report.keptSentences, 1);
    assert.equal(report.strippedSentences, 1);
    assert.equal(digest.sections[0].sentences.length, 1);
    assert.equal(digest.sections[0].sentences[0].text, "A note was added.");
  });

  it("drops a sentence whose only ref is not in this changeset, and says so", () => {
    const { digest, report } = validate({
      headline: "Something happened",
      headlineRefs: ["note:1"],
      sections: [
        {
          heading: "What moved",
          sentences: [
            { text: "A note was added.", refs: ["note:1"] },
            // Plausible, well-formed, and not in the set we built.
            { text: "A deposition was scheduled.", refs: ["calendar_entry:999"] },
          ],
        },
      ],
    });

    assert.equal(digest.sections[0].sentences.length, 1);
    assert.deepEqual(report.unknownRefs, ["calendar_entry:999"]);
    // Visible in the response rather than silently absorbed.
    assert.ok(report.reasons.some((reason) => reason.includes("not in this changeset")));
  });

  it("keeps a sentence whose other refs are valid", () => {
    const { digest, report } = validate({
      headline: "Something happened",
      headlineRefs: ["note:1"],
      sections: [
        {
          heading: "What moved",
          sentences: [{ text: "Two notes arrived.", refs: ["note:2", "note:404"] }],
        },
      ],
    });

    assert.equal(report.keptSentences, 1);
    assert.deepEqual(digest.sections[0].sentences[0].refs, ["note:2"]);
  });
});

describe("inline refs", () => {
  it("strips bracketed ids out of the prose", () => {
    // The UI renders citations from `refs`; an id left inline is a duplicate
    // at best and a stale label at worst.
    const { digest } = validate({
      headline: "A note was added [note:1]",
      headlineRefs: ["note:1"],
      sections: [
        {
          heading: "What moved",
          sentences: [{ text: "A note was added [note:1].", refs: ["note:1"] }],
        },
      ],
    });

    assert.doesNotMatch(digest.sections[0].sentences[0].text, /\[note:1\]/);
    assert.doesNotMatch(digest.headline, /\[note:1\]/);
  });
});

describe("empty results", () => {
  it("drops a section left with no sentences", () => {
    const { digest } = validate({
      headline: "A note was added",
      headlineRefs: ["note:1"],
      sections: [
        {
          heading: "What moved",
          sentences: [{ text: "A note was added.", refs: ["note:1"] }],
        },
        { heading: "Waiting on others", sentences: [{ text: "Nothing.", refs: [] }] },
      ],
    });

    assert.equal(digest.sections.length, 1);
    assert.equal(digest.sections[0].heading, "What moved");
  });

  it("falls back to the code-written digest when nothing survives", () => {
    // A blank panel is the one outcome worse than plain prose.
    const { digest, report } = validate({
      headline: "All invented",
      headlineRefs: ["note:999"],
      sections: [
        { heading: "What moved", sentences: [{ text: "Invented.", refs: ["note:999"] }] },
      ],
    });

    assert.equal(report.fellBack, true);
    assert.deepEqual(digest, DETERMINISTIC);
  });

  it("replaces an uncitable headline with a cited sentence", () => {
    const { digest } = validate({
      headline: "Vibes are good",
      headlineRefs: ["note:999"],
      sections: [
        {
          heading: "What moved",
          sentences: [{ text: "A note was added.", refs: ["note:1"] }],
        },
      ],
    });

    assert.equal(digest.headline, "A note was added.");
    assert.deepEqual(digest.headlineRefs, ["note:1"]);
  });
});

describe("every shipped sentence", () => {
  it("carries at least one ref from the changeset", () => {
    const { digest } = validate({
      headline: "Mixed bag",
      headlineRefs: ["note:1", "note:404"],
      sections: [
        {
          heading: "What moved",
          sentences: [
            { text: "Good.", refs: ["note:1"] },
            { text: "Bad.", refs: ["note:404"] },
            { text: "Partly good.", refs: ["note:2", "note:404"] },
          ],
        },
      ],
    });

    const allowed = new Set(["note:1", "note:2"]);
    for (const section of digest.sections) {
      for (const sentence of section.sentences) {
        assert.ok(sentence.refs.length > 0, "a shipped sentence must be cited");
        for (const ref of sentence.refs) {
          assert.ok(allowed.has(ref), `${ref} must be in the changeset`);
        }
      }
    }
    for (const ref of digest.headlineRefs) {
      assert.ok(allowed.has(ref));
    }
  });
});
