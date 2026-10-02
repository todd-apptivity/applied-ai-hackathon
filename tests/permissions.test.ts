/**
 * The permission rules, tested without a database, a request, or a model.
 *
 * This is the PRD's "provider portal fields outside the attorney's approved
 * set: 0" acceptance target, expressed as assertions. The policy functions are
 * pure, so these run in milliseconds and fail loudly if someone widens a
 * provider's access by accident.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ALL_KINDS,
  PROVIDER_BASELINE_KINDS,
  allowedKinds,
  canAccessMatter,
  filterHits,
  resolveKindFilter,
  screenText,
  withheldCount,
} from "@/lib/permissions/policy";
import { getPrincipal, parseViewAs } from "@/lib/permissions/principal";
import type {
  DenyTopic,
  FirmPrincipal,
  ProviderPrincipal,
} from "@/lib/permissions/types";
import type { SearchHit } from "@/lib/rag/search";
import type { SourceKind } from "@/lib/rag/sources";

const MATTER = 4242;
const OTHER_MATTER = 9999;

const firm: FirmPrincipal = {
  kind: "firm",
  userId: "u1",
  name: "Firm staff",
};

function provider(overrides: Partial<ProviderPrincipal> = {}): ProviderPrincipal {
  return {
    kind: "provider",
    providerId: "p1",
    name: "Treating provider",
    matterId: MATTER,
    shareId: "s1",
    approvedKinds: ["matter", "task", "calendar_entry", "document", "document_page"],
    releasedTopics: [],
    ...overrides,
  };
}

function hit(overrides: Partial<SearchHit> = {}): SearchHit {
  return {
    chunkId: 1,
    sourceId: 1,
    matterId: MATTER,
    kind: "task",
    clioId: "100",
    page: 0,
    title: "Request records",
    text: "Follow up on the outstanding records request.",
    occurredAt: "2026-05-05",
    metadata: {},
    score: 1,
    rerankScore: null,
    matchedBy: { keyword: 1, vector: null },
    ...overrides,
  };
}

describe("matter scope", () => {
  it("lets firm staff read any matter", () => {
    assert.equal(canAccessMatter(firm, MATTER), true);
    assert.equal(canAccessMatter(firm, OTHER_MATTER), true);
  });

  it("binds a provider to the matter its share was issued for", () => {
    assert.equal(canAccessMatter(provider(), MATTER), true);
    assert.equal(canAccessMatter(provider(), OTHER_MATTER), false);
  });

  it("rejects a non-numeric matter", () => {
    assert.equal(canAccessMatter(firm, Number.NaN), false);
  });
});

describe("allowed kinds", () => {
  it("gives firm staff the whole index", () => {
    assert.deepEqual(allowedKinds(firm).sort(), [...ALL_KINDS].sort());
  });

  it("never gives a provider a privileged kind", () => {
    const got = new Set(allowedKinds(provider()));
    for (const denied of ["note", "communication", "activity", "custom_field", "contact"]) {
      assert.equal(got.has(denied as SourceKind), false, `${denied} must not be readable`);
    }
  });

  it("intersects with the baseline rather than trusting the share", () => {
    // An approval for `note` is not honoured: approvals narrow, never widen.
    const rogue = provider({
      approvedKinds: [...PROVIDER_BASELINE_KINDS, "note", "communication"],
    });
    const got = new Set(allowedKinds(rogue));
    assert.equal(got.has("note"), false);
    assert.equal(got.has("communication"), false);
    assert.equal(got.has("task"), true);
  });

  it("honours an attorney narrowing the share", () => {
    const narrow = provider({ approvedKinds: ["task"] });
    assert.deepEqual(allowedKinds(narrow), ["task"]);
  });
});

describe("kind filter resolution", () => {
  it("defaults to everything allowed when the model asks for nothing", () => {
    assert.deepEqual(resolveKindFilter(provider(), undefined), allowedKinds(provider()));
    assert.deepEqual(resolveKindFilter(provider(), []), allowedKinds(provider()));
  });

  it("returns empty when a provider asks only for a denied kind", () => {
    // The guard turns this into zero passages rather than widening the search.
    assert.deepEqual(resolveKindFilter(provider(), ["note"]), []);
  });

  it("keeps only the intersection", () => {
    assert.deepEqual(resolveKindFilter(provider(), ["note", "task"]), ["task"]);
  });
});

describe("default-deny screening", () => {
  const cases: Array<[DenyTopic, string]> = [
    ["coverage_amounts", "The bodily injury limit is listed on the declaration page."],
    ["case_value", "We think the case value supports a demand amount above that."],
    ["liability_analysis", "There is comparative fault to argue here."],
    ["credibility_or_prior_injury", "Note a prior injury to the same shoulder."],
    ["other_providers", "Another provider is asserting a competing lien."],
    ["attorney_notes", "Attorney work product: our theory of the case."],
    ["client_identifiers", "Client date of birth confirmed against the file."],
  ];

  for (const [topic, text] of cases) {
    it(`flags ${topic}`, () => {
      const screen = screenText(text);
      assert.equal(screen.blocked, true);
      assert.ok(screen.topics.includes(topic), `expected ${topic}, got ${screen.topics}`);
    });
  }

  it("passes ordinary treatment text", () => {
    const screen = screenText("Patient attended physical therapy on June 3 and reported improvement.");
    assert.equal(screen.blocked, false);
    assert.deepEqual(screen.topics, []);
  });

  it("lets a released topic through", () => {
    const screen = screenText("Client date of birth confirmed.", ["client_identifiers"]);
    assert.equal(screen.blocked, false);
  });
});

describe("filtering hits for a provider", () => {
  it("withholds nothing from firm staff", () => {
    const hits = [hit({ kind: "note" }), hit({ kind: "communication" }), hit({ kind: "activity" })];
    const { allowed, withheld } = filterHits(firm, hits);
    assert.equal(allowed.length, 3);
    assert.equal(withheldCount(withheld), 0);
  });

  it("drops every privileged kind and counts them", () => {
    const hits = [
      hit({ kind: "task" }),
      hit({ kind: "note", text: "Internal thoughts." }),
      hit({ kind: "communication", text: "Email thread." }),
      hit({ kind: "activity", text: "3.2 hours drafting." }),
      hit({ kind: "document_page", page: 47, text: "Operative report, right shoulder." }),
    ];
    const { allowed, withheld } = filterHits(provider(), hits);

    assert.deepEqual(allowed.map((h) => h.kind), ["task", "document_page"]);
    assert.equal(withheld.byKind, 3);
    assert.equal(withheld.byTopic, 0);
  });

  it("drops an allowed kind whose text reads as a denied topic", () => {
    const hits = [
      hit({ kind: "task", text: "Confirm the policy limit with the carrier." }),
      hit({ kind: "task", text: "Request the operative report." }),
    ];
    const { allowed, withheld } = filterHits(provider(), hits);

    assert.equal(allowed.length, 1);
    assert.equal(allowed[0].text, "Request the operative report.");
    assert.equal(withheld.byTopic, 1);
    assert.deepEqual(withheld.topics, ["coverage_amounts"]);
  });

  it("screens the title as well as the body", () => {
    const hits = [hit({ kind: "task", title: "Attorney work product", text: "See file." })];
    const { allowed, withheld } = filterHits(provider(), hits);
    assert.equal(allowed.length, 0);
    assert.equal(withheld.byTopic, 1);
  });

  it("drops a hit belonging to another matter", () => {
    const hits = [hit({ matterId: OTHER_MATTER })];
    const { allowed, withheld } = filterHits(provider(), hits);
    assert.equal(allowed.length, 0);
    assert.equal(withheld.byKind, 1);
  });

  it("reports no privileged kind in the allowed set, whatever comes in", () => {
    const hits = ALL_KINDS.map((kind) => hit({ kind, text: `A ${kind} record.` }));
    const { allowed } = filterHits(provider(), hits);
    const baseline = new Set(PROVIDER_BASELINE_KINDS);
    for (const h of allowed) {
      assert.ok(baseline.has(h.kind as SourceKind), `${h.kind} leaked into the provider view`);
    }
  });
});

describe("principal stub", () => {
  it("defaults to firm staff", () => {
    assert.equal(parseViewAs(undefined), "firm");
    assert.equal(parseViewAs("nonsense"), "firm");
    assert.equal(getPrincipal(parseViewAs(undefined), MATTER).kind, "firm");
  });

  it("binds a provider principal to the requested matter", () => {
    const principal = getPrincipal("provider", MATTER);
    assert.equal(principal.kind, "provider");
    assert.equal(principal.kind === "provider" && principal.matterId, MATTER);
  });

  it("releases no deny topic by default", () => {
    const principal = getPrincipal("provider", MATTER);
    assert.deepEqual(principal.kind === "provider" && principal.releasedTopics, []);
  });
});
