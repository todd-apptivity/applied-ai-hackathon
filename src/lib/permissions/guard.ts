/**
 * The enforcement seam. Every retrieval on the chat path goes through here,
 * and nothing on the chat path calls `search()` directly.
 *
 * Filtering happens BEFORE the passages reach the model, not on the way to the
 * screen. Filtering only at render would mean the model had already read the
 * withheld text and could paraphrase it into prose that passes every check the
 * UI makes. The model can only cite what it was given, so the set it is given
 * is the boundary.
 */

import {
  buildChangeset,
  fingerprintChangeset,
  type ChangesetScope,
} from "@/lib/changes/changeset";
import type { ResolvedWindow } from "@/lib/changes/checkpoint";
import { countEvents, emptyCounts, type Changeset } from "@/lib/changes/types";
import { passageRef, type Passage, type SearchCaseFileResult } from "@/lib/chat/types";
import { sourceLink } from "@/lib/chat/source-link";
import { search } from "@/lib/rag/search";

import {
  allowedKinds,
  canAccessMatter,
  filterChangeEvents,
  filterHits,
  resolveKindFilter,
  withheldCount,
} from "./policy";
import { PermissionError, type Principal } from "./types";

export interface GuardedSearch {
  principal: Principal;
  matterId: number;
  query: string;
  /** Kind filter the model asked for. Narrowed, never widened. */
  kinds?: string[];
  limit?: number;
  signal?: AbortSignal;
}

/** Passages are capped so one tool call cannot pull the whole file. */
const MAX_LIMIT = 20;
const DEFAULT_LIMIT = 8;

export async function searchForPrincipal(
  options: GuardedSearch,
): Promise<SearchCaseFileResult> {
  const { principal, matterId, query, signal } = options;

  if (!canAccessMatter(principal, matterId)) {
    throw new PermissionError(
      "You do not have access to this matter.",
      "matter_not_permitted",
    );
  }

  const kinds = resolveKindFilter(principal, options.kinds);
  const limit = clamp(options.limit ?? DEFAULT_LIMIT, 1, MAX_LIMIT);
  const scope = principal.kind === "firm" ? "firm" : "provider";

  // Every kind the principal could read was filtered out by the model's own
  // request. Returning early keeps a provider's narrowed request from silently
  // widening to "everything allowed".
  if (kinds.length === 0) {
    return {
      query,
      passages: [],
      withheld: { count: 0, topics: [] },
      scope,
    };
  }

  const result = await search(query, {
    matterId,
    kinds,
    // Over-fetch so topic screening does not starve the result set: a provider
    // whose top hits are all privileged should still get the next ones down.
    limit: scope === "provider" ? Math.min(limit * 3, MAX_LIMIT * 3) : limit,
    signal,
  });

  const { allowed, withheld } = filterHits(principal, result.hits);

  const passages: Passage[] = allowed.slice(0, limit).map((hit) => ({
    ref: passageRef(hit.kind, hit.clioId, hit.page || null),
    kind: hit.kind,
    title: hit.title,
    date: hit.occurredAt ? hit.occurredAt.slice(0, 10) : null,
    page: hit.page || null,
    text: hit.text,
    clioUrl: sourceLink(hit.kind, hit.clioId, hit.matterId, hit.metadata),
  }));

  return {
    query,
    passages,
    withheld: { count: withheldCount(withheld), topics: withheld.topics },
    scope,
  };
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

/* --- the change digest's seam -------------------------------------------- */

export interface GuardedChanges {
  principal: Principal;
  matterId: number;
  window: ResolvedWindow;
  limit?: number;
}

export interface GuardedChangeset {
  changeset: Changeset;
  withheld: { count: number; topics: string[] };
  scope: "firm" | "provider";
}

const MAX_CHANGES = 60;
const DEFAULT_CHANGES = 40;

/**
 * Every changeset read goes through here, and nothing on the digest path calls
 * `buildChangeset` directly — the same arrangement as `searchForPrincipal` on
 * the chat path, for the same reason. The set handed to the model is the
 * boundary, so it has to be built behind one door.
 */
export function changesForPrincipal(options: GuardedChanges): GuardedChangeset {
  const { principal, matterId, window } = options;
  const scopeName = principal.kind === "firm" ? "firm" : "provider";

  if (!canAccessMatter(principal, matterId)) {
    throw new PermissionError(
      "You do not have access to this matter.",
      "matter_not_permitted",
    );
  }

  const kinds = allowedKinds(principal);
  const limit = clamp(options.limit ?? DEFAULT_CHANGES, 1, MAX_CHANGES);

  // Nothing this principal may read. Returning early keeps an empty allowance
  // from being mistaken for "no filter".
  if (kinds.length === 0) {
    return {
      changeset: emptyChangeset(matterId, window),
      withheld: { count: 0, topics: [] },
      scope: scopeName,
    };
  }

  const scope: ChangesetScope = { matterId, kinds };

  const built = buildChangeset(scope, window, {
    // Over-fetch for providers so topic screening does not starve the list: a
    // viewer whose top changes are all privileged should still see the rest.
    limit: scopeName === "provider" ? Math.min(limit * 3, MAX_CHANGES * 3) : limit,
  });

  const { allowed, withheld } = filterChangeEvents(principal, built.events);
  const events = allowed.slice(0, limit);

  return {
    changeset: {
      ...built,
      events,
      // Recomputed from what survived. A provider's cache key must not encode
      // records they were never shown, and the counts on screen must match the
      // list under them.
      counts: countEvents(events),
      fingerprint: fingerprintChangeset(scope, window, events),
    },
    withheld: { count: withheldCount(withheld), topics: withheld.topics },
    scope: scopeName,
  };
}

function emptyChangeset(matterId: number, window: ResolvedWindow): Changeset {
  return {
    matterId,
    window,
    events: [],
    counts: emptyCounts(),
    history: { startsAt: null, truncated: false },
    degraded: false,
    totalSources: 0,
    fingerprint: "",
  };
}
