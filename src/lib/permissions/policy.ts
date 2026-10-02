/**
 * The access rules. Pure functions over a `Principal` and a search hit, so
 * they are testable without a database, a request, or a model.
 *
 * The screening in `screenText` is a STUB and is labelled as one at its call
 * site. It is a keyword pass over the default-deny vocabulary: good enough to
 * demonstrate the seam and to fail closed on the obvious cases, not good
 * enough to be the only thing between a provider and privileged text. The real
 * design is in the PRD: the attorney previews a snapshot, toggles fields, and
 * publishes it frozen, so what a provider sees is an approved artifact rather
 * than the output of a classifier.
 */

import type { ChangeEvent } from "@/lib/changes/types";
import type { SearchHit } from "@/lib/rag/search";
import type { SourceKind } from "@/lib/rag/sources";

import { type DenyTopic, type Principal, type Withheld } from "./types";

/** Every kind the index can hold. Firm staff read all of them. */
export const ALL_KINDS: readonly SourceKind[] = [
  "matter",
  "custom_field",
  "contact",
  "note",
  "communication",
  "task",
  "calendar_entry",
  "activity",
  "document",
  "document_page",
];

/**
 * The most a provider can ever be shown, before the share's own approvals
 * narrow it further.
 *
 * Excluded on purpose:
 *  - `note`          attorney work product and strategy
 *  - `communication` internal email and call threads
 *  - `activity`      time and expenses, which read straight through to case value
 *  - `custom_field`  where coverage limits and case value are stored
 *  - `contact`       other providers, the adjuster, the client's identifiers
 */
export const PROVIDER_BASELINE_KINDS: readonly SourceKind[] = [
  "matter",
  "task",
  "calendar_entry",
  "document",
  "document_page",
];

export function canAccessMatter(principal: Principal, matterId: number): boolean {
  if (!Number.isFinite(matterId)) return false;
  if (principal.kind === "firm") return true;
  return principal.matterId === matterId;
}

/**
 * Kinds this principal may read. For a provider this is an intersection, so a
 * share that approves `note` still does not yield notes.
 */
export function allowedKinds(principal: Principal): SourceKind[] {
  if (principal.kind === "firm") return [...ALL_KINDS];
  const approved = new Set(principal.approvedKinds);
  return PROVIDER_BASELINE_KINDS.filter((kind) => approved.has(kind));
}

/**
 * Narrow a model-requested kind filter to what the principal may read. An
 * empty request means "no filter", which becomes "everything allowed".
 */
export function resolveKindFilter(
  principal: Principal,
  requested: string[] | undefined,
): SourceKind[] {
  const allowed = allowedKinds(principal);
  if (!requested || requested.length === 0) return allowed;
  const wanted = new Set(requested);
  return allowed.filter((kind) => wanted.has(kind));
}

/* --- default-deny screening (STUB) --------------------------------------- */

/**
 * Vocabulary per topic. Deliberately boring and English-only; this is a
 * demonstration of where the check goes, not a privacy guarantee.
 */
const TOPIC_PATTERNS: Record<DenyTopic, RegExp> = {
  coverage_amounts:
    /\b(policy limit|policy limits|coverage limit|bodily injury limit|bi limit|um\/uim|underinsured|uninsured motorist|declaration page|dec page)\b/i,
  case_value:
    /\b(case value|settlement value|demand amount|policy exhaust\w*|reserve|valuation|net to client|lien reduction|settle for|authority to settle)\b/i,
  liability_analysis:
    /\b(comparative fault|contributory negligence|liability analysis|our exposure|weak on liability|strong on liability|apportion\w*|proximate cause argument)\b/i,
  credibility_or_prior_injury:
    /\b(credibility|not credible|exaggerat\w*|malinger\w*|secondary gain|prior injury|preexisting|pre-existing|prior accident|prior claim)\b/i,
  other_providers:
    /\b(other provider|another provider|competing lien|other lienholder)\b/i,
  attorney_notes:
    /\b(attorney work product|work product|privileged|attorney-client|strategy memo|do not disclose|internal only|our theory)\b/i,
  client_identifiers:
    /\b(date of birth|dob|social security|ssn|driver'?s licen[cs]e|passport number|medicaid id|medicare id)\b/i,
};

export interface Screen {
  blocked: boolean;
  topics: DenyTopic[];
}

/**
 * STUB. Returns the default-deny topics a passage appears to touch.
 *
 * TODO(permissions): replace with the PRD's model — an attorney-approved,
 * frozen snapshot per share — and keep this only as a backstop assertion that
 * nothing outside the approved set reached a provider.
 */
export function screenText(text: string, released: readonly DenyTopic[] = []): Screen {
  const releasedSet = new Set(released);
  const topics: DenyTopic[] = [];

  for (const [topic, pattern] of Object.entries(TOPIC_PATTERNS) as [DenyTopic, RegExp][]) {
    if (releasedSet.has(topic)) continue;
    if (pattern.test(text)) topics.push(topic);
  }

  return { blocked: topics.length > 0, topics };
}

/* --- result filtering ---------------------------------------------------- */

export interface FilterOutcome {
  allowed: SearchHit[];
  withheld: Withheld;
}

/**
 * Drop everything the principal may not read.
 *
 * Firm principals are checked for matter scope only — staff are trusted with
 * the file, which is the whole point of the firm-side view. Providers are
 * filtered by kind, then by topic, then by whether a contact record is their
 * own.
 */
export function filterHits(principal: Principal, hits: SearchHit[]): FilterOutcome {
  const withheld: Withheld = { byKind: 0, byTopic: 0, topics: [] };

  if (principal.kind === "firm") {
    return { allowed: hits, withheld };
  }

  const kinds = new Set(allowedKinds(principal));
  const topics = new Set<DenyTopic>();
  const allowed: SearchHit[] = [];

  for (const hit of hits) {
    if (hit.matterId !== principal.matterId) {
      withheld.byKind += 1;
      continue;
    }
    if (!kinds.has(hit.kind as SourceKind)) {
      withheld.byKind += 1;
      continue;
    }

    const screen = screenText(`${hit.title}\n${hit.text}`, principal.releasedTopics);
    if (screen.blocked) {
      withheld.byTopic += 1;
      for (const topic of screen.topics) topics.add(topic);
      continue;
    }

    allowed.push(hit);
  }

  withheld.topics = [...topics];
  return { allowed, withheld };
}

export function withheldCount(withheld: Withheld): number {
  return withheld.byKind + withheld.byTopic;
}

/* --- change events ------------------------------------------------------- */

/**
 * The same filter, applied to change events.
 *
 * One difference from `filterHits`, and it is load-bearing. A search passage
 * exposes its title and text; a change event exposes *more* — the excerpt, and
 * every delta's before and after value. A custom field whose old value was a
 * policy limit and whose new value is innocuous would pass a title-and-text
 * screen while handing the model the limit in `delta.from`. So everything that
 * will reach a prompt is screened, not just the body.
 */
export function filterChangeEvents(
  principal: Principal,
  events: ChangeEvent[],
): { allowed: ChangeEvent[]; withheld: Withheld } {
  const withheld: Withheld = { byKind: 0, byTopic: 0, topics: [] };

  if (principal.kind === "firm") {
    return { allowed: events, withheld };
  }

  const kinds = new Set(allowedKinds(principal));
  const topics = new Set<DenyTopic>();
  const allowed: ChangeEvent[] = [];

  for (const event of events) {
    if (!kinds.has(event.kind as SourceKind)) {
      withheld.byKind += 1;
      continue;
    }

    const screen = screenText(screenSurface(event), principal.releasedTopics);
    if (screen.blocked) {
      withheld.byTopic += 1;
      for (const topic of screen.topics) topics.add(topic);
      continue;
    }

    allowed.push(event);
  }

  withheld.topics = [...topics];
  return { allowed, withheld };
}

/** Everything about an event that could reach a prompt. */
function screenSurface(event: ChangeEvent): string {
  const parts = [event.title, event.summary, event.excerpt ?? ""];
  for (const delta of event.deltas) {
    parts.push(delta.field, delta.from ?? "", delta.to ?? "");
  }
  return parts.join("\n");
}
