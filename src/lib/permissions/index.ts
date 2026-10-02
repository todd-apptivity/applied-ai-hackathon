/** Access control for case-file retrieval. See `guard.ts` for the seam. */

export {
  ALL_KINDS,
  PROVIDER_BASELINE_KINDS,
  allowedKinds,
  canAccessMatter,
  filterHits,
  resolveKindFilter,
  screenText,
  withheldCount,
  type FilterOutcome,
  type Screen,
} from "./policy";

export {
  describePrincipal,
  getPrincipal,
  getPrincipalFromRequest,
  parseViewAs,
  type ViewAs,
} from "./principal";

export { searchForPrincipal, type GuardedSearch } from "./guard";

export {
  DENY_TOPICS,
  PermissionError,
  type DenyTopic,
  type FirmPrincipal,
  type Principal,
  type ProviderPrincipal,
  type Withheld,
} from "./types";
