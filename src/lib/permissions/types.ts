/**
 * Who is asking, and what they are allowed to see.
 *
 * The retrieval index is unsegmented: attorney notes, the client's date of
 * birth, expenses, and medical records all live in the same `sources` table.
 * That is fine for firm staff and unacceptable for anyone outside the firm, so
 * every read is attributed to a `Principal` and filtered against it.
 *
 * Two kinds exist. A firm principal is staff: full access to its own matters.
 * A provider principal is a treating provider or doctor outside the firm,
 * reached through a single share link, and scoped to exactly one matter.
 */

import type { SourceKind } from "@/lib/rag/sources";

export interface FirmPrincipal {
  kind: "firm";
  userId: string;
  name: string;
}

export interface ProviderPrincipal {
  kind: "provider";
  providerId: string;
  name: string;
  /**
   * The one matter this share covers. A provider principal carries its own
   * matter so it cannot be replayed against another one.
   */
  matterId: number;
  /** The `provider_shares` row this principal was built from. */
  shareId: string;
  /**
   * Source kinds the attorney turned on for this share. Intersected with the
   * baseline in `policy.ts`, never added to it — an approval cannot widen
   * access beyond what a provider is ever allowed to see.
   */
  approvedKinds: SourceKind[];
  /**
   * Default-deny topics the attorney explicitly released for this share.
   * Empty in the stub: nothing is released until an attorney says so.
   */
  releasedTopics: DenyTopic[];
}

export type Principal = FirmPrincipal | ProviderPrincipal;

/**
 * The PRD's default-deny list, as topics rather than Clio fields, because the
 * same secret shows up in several shapes: a case value lives in a custom field
 * and in an attorney's note about it.
 *
 * "These never appear unless an attorney turns them on: coverage amounts, case
 * value, liability analysis, credibility or prior-injury notes, other
 * providers' information, attorney notes, and the client's ID or date of
 * birth."
 */
export type DenyTopic =
  | "coverage_amounts"
  | "case_value"
  | "liability_analysis"
  | "credibility_or_prior_injury"
  | "other_providers"
  | "attorney_notes"
  | "client_identifiers";

export const DENY_TOPICS: readonly DenyTopic[] = [
  "coverage_amounts",
  "case_value",
  "liability_analysis",
  "credibility_or_prior_injury",
  "other_providers",
  "attorney_notes",
  "client_identifiers",
];

/** Why a passage was held back. Surfaced as a count, never as content. */
export interface Withheld {
  /** Passages dropped because the principal may not read that source kind. */
  byKind: number;
  /** Passages dropped because they read as a default-deny topic. */
  byTopic: number;
  /** Topics that triggered a drop, for the UI's "what is hidden" note. */
  topics: DenyTopic[];
}

export class PermissionError extends Error {
  readonly code: string;

  constructor(message: string, code = "not_permitted") {
    super(message);
    this.name = "PermissionError";
    this.code = code;
  }
}
