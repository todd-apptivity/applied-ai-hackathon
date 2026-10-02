/**
 * "What happened in this case since the last time I reviewed it?"
 *
 * The whole answer, in one call: resolve the window, refresh from Clio, read
 * the permitted changeset, and compose cited prose over it. The route and the
 * CLI both come through here, so the demo path and the product path cannot
 * disagree about what the answer is.
 *
 * Every empty case is resolved before a model is involved. A first visit, an
 * unchanged matter, and a matter whose change log does not reach back far
 * enough are all legitimate answers that cost nothing — and they are the
 * common cases, so improvising them at request time would be the wrong place
 * to find out.
 */

import { chatModelId } from "@/lib/ai/model";
import { changesForPrincipal } from "@/lib/permissions/guard";
import type { Principal } from "@/lib/permissions/types";
import { getDb } from "@/lib/db/sqlite";

import {
  DIGEST_KIND_CHANGES,
  digestInputHash,
  readDigest,
  writeDigest,
} from "./cache";
import {
  getReviewState,
  openMatter,
  recordViewEvent,
  resolveWindow,
  type ResolvedWindow,
  type WindowRequest,
} from "./checkpoint";
import {
  DIGEST_PROMPT_VERSION,
  composeDigest,
  deterministicDigest,
  type ComposedDigest,
} from "./compose";
import { refreshIfStale, type FreshnessResult } from "./freshness";
import { DEGRADED_MAX_EVENTS } from "./changeset";
import type { ChangeCounts, ChangeEvent, Changeset } from "./types";
import type { ValidationReport } from "./validate";

/**
 * Which of the five answers this is.
 *
 *   changes      something changed, and here it is
 *   no_changes   the window resolved and held nothing
 *   first_visit  no baseline yet, so "since" has no meaning
 *   no_history   the window predates the change log, and too much is unknown
 */
export type DigestState = "changes" | "no_changes" | "first_visit" | "no_history";

/** Stands in for a model id in the cache key when code wrote the prose. */
const DETERMINISTIC_WRITER = "deterministic";

export interface Citation {
  ref: string;
  label: string;
  clioUrl: string | null;
}

export interface ChangeDigest {
  matterId: number;
  scope: "firm" | "provider";
  state: DigestState;
  window: ResolvedWindow;
  freshness: FreshnessResult;
  history: Changeset["history"];
  counts: ChangeCounts;
  /** Total records in the matter this viewer may read. */
  totalSources: number;
  events: ChangeEvent[];
  degraded: boolean;
  digest: ComposedDigest | null;
  /** Every ref the prose may cite, resolved to a label and a Clio link. */
  citations: Record<string, Citation>;
  withheld: { count: number; topics: string[] };
  cached: boolean;
  /** Null when no model wrote this — a short-circuit or no API key. */
  model: string | null;
  validation: ValidationReport | null;
  /** Note for the UI when something degraded the answer. */
  notice: string | null;
}

export class MatterNotIndexedError extends Error {
  constructor(matterId: number) {
    super(
      `Matter ${matterId} is not in the local index. Run \`npm run rag:seed -- --matter ${matterId}\` first.`,
    );
    this.name = "MatterNotIndexedError";
  }
}

export function matterLabel(matterId: number): string {
  const row = getDb()
    .prepare("SELECT display_number, description FROM matters WHERE matter_id = ?")
    .get(matterId) as
    | { display_number?: string | null; description?: string | null }
    | undefined;

  if (!row) throw new MatterNotIndexedError(matterId);
  return row.display_number ?? row.description ?? `matter ${matterId}`;
}

export function isMatterIndexed(matterId: number): boolean {
  const row = getDb()
    .prepare("SELECT 1 AS ok FROM matters WHERE matter_id = ?")
    .get(matterId) as { ok?: number } | undefined;
  return row?.ok === 1;
}

function citationsFor(events: ChangeEvent[]): Record<string, Citation> {
  const out: Record<string, Citation> = {};
  for (const event of events) {
    out[event.ref] = {
      ref: event.ref,
      label: event.page ? `${event.title} — p.${event.page}` : event.title,
      clioUrl: event.clioUrl,
    };
  }
  return out;
}

export interface DigestOptions {
  principal: Principal;
  viewerId: string;
  matterId: number;
  window?: WindowRequest;
  /** Pull from Clio first. Default true. */
  sync?: boolean;
  /** Ask a model to write the prose. Default true. */
  compose?: boolean;
  limit?: number;
  signal?: AbortSignal;
  /** Log a view event. Default true. */
  record?: boolean;
  /**
   * Observe without touching anything.
   *
   * A server render is not a visit: it must not advance the review session, log
   * a view, or store a digest, or the act of painting the shell would consume
   * the window the viewer is about to read. Returns a cached digest if one
   * exists and otherwise leaves `digest` null for the client to fill in.
   */
  peek?: boolean;
}

export async function changeDigest(options: DigestOptions): Promise<ChangeDigest> {
  const {
    principal,
    viewerId,
    matterId,
    window: requested = { kind: "checkpoint" } as WindowRequest,
  } = options;

  if (!isMatterIndexed(matterId)) throw new MatterNotIndexedError(matterId);

  const peeking = options.peek === true;

  // A manual window is a re-read, not a review, and a peek is not a visit at
  // all: neither may advance a checkpoint, so both only look the state up.
  const state =
    requested.kind === "checkpoint" && !peeking
      ? openMatter(viewerId, matterId)
      : getReviewState(viewerId, matterId);

  const window = resolveWindow(state, requested);

  const logging = options.record !== false && !peeking;

  if (logging && requested.kind === "checkpoint") {
    recordViewEvent({ viewerId, matterId, event: "matter_opened", window });
  }

  const freshness =
    options.sync === false
      ? {
          synced: false,
          mode: "skipped" as const,
          syncedAt: null,
          stale: false,
          error: null,
        }
      : await refreshIfStale(matterId, { signal: options.signal });

  const { changeset, withheld, scope } = changesForPrincipal({
    principal,
    matterId,
    window,
    limit: options.limit,
  });

  const base = {
    matterId,
    scope,
    window,
    freshness,
    history: changeset.history,
    counts: changeset.counts,
    totalSources: changeset.totalSources,
    events: changeset.events,
    degraded: changeset.degraded,
    citations: citationsFor(changeset.events),
    withheld,
  };

  /* --- the short circuits, all before any model call --------------------- */

  if (window.kind === "first_visit") {
    return {
      ...base,
      state: "first_visit",
      digest: null,
      cached: false,
      model: null,
      validation: null,
      notice:
        `First time you have opened this matter, so there is no "since" yet. ` +
        `The file holds ${changeset.totalSources} record(s).`,
    };
  }

  // Too much unknown history to describe honestly. Saying "456 records are new"
  // would be true of the index and false of the case.
  if (
    changeset.history.truncated &&
    changeset.degraded &&
    changeset.events.length === 0 &&
    changeset.totalSources > DEGRADED_MAX_EVENTS
  ) {
    return {
      ...base,
      state: "no_history",
      digest: null,
      cached: false,
      model: null,
      validation: null,
      notice: changeset.history.startsAt
        ? `Change tracking for this matter starts ${changeset.history.startsAt}. ` +
          `${changeset.totalSources} record(s) were already on file before then.`
        : `This matter has no change history yet. ${changeset.totalSources} record(s) are on file; ` +
          `changes will be tracked from the next refresh.`,
    };
  }

  if (changeset.events.length === 0) {
    return {
      ...base,
      state: "no_changes",
      digest: null,
      cached: false,
      model: null,
      validation: null,
      notice: null,
    };
  }

  /* --- compose, or reuse ------------------------------------------------- */

  // The cache key has to name whoever writes the prose: a code-written digest
  // must not collide with a model-written one under the same hash.
  const model = options.compose === false ? DETERMINISTIC_WRITER : chatModelId();
  const inputHash = digestInputHash({
    kind: DIGEST_KIND_CHANGES,
    scope,
    promptVersion: DIGEST_PROMPT_VERSION,
    model,
    fingerprint: changeset.fingerprint,
  });

  const cached = readDigest(DIGEST_KIND_CHANGES, inputHash);
  if (cached) {
    if (logging) {
      recordViewEvent({
        viewerId,
        matterId,
        event: "digest_viewed",
        window,
        digestId: cached.id,
      });
    }
    return {
      ...base,
      state: "changes",
      digest: cached.body,
      cached: true,
      model: cached.model === DETERMINISTIC_WRITER ? null : cached.model,
      validation: null,
      notice: noticeFor(changeset, freshness),
    };
  }

  // A peek that missed the cache stops here. Composing would be a model call on
  // a page render, and storing one would cache prose nobody asked for.
  if (peeking) {
    return {
      ...base,
      state: "changes",
      digest: null,
      cached: false,
      model: null,
      validation: null,
      notice: null,
    };
  }

  const composed =
    options.compose === false
      ? {
          digest: deterministicDigest(changeset),
          report: null as ValidationReport | null,
          usage: { inputTokens: null, outputTokens: null },
          model: null as string | null,
        }
      : await composeOrFallback({
          principal,
          matterLabel: matterLabel(matterId),
          changeset,
          signal: options.signal,
        });

  const digestId = writeDigest({
    matterId,
    kind: DIGEST_KIND_CHANGES,
    inputHash,
    scope,
    windowFrom: window.from,
    windowTo: window.to,
    model,
    promptVersion: DIGEST_PROMPT_VERSION,
    body: composed.digest,
    inputTokens: composed.usage.inputTokens,
    outputTokens: composed.usage.outputTokens,
  });

  if (logging) {
    recordViewEvent({
      viewerId,
      matterId,
      event: "digest_viewed",
      window,
      digestId,
    });
  }

  return {
    ...base,
    state: "changes",
    digest: composed.digest,
    cached: false,
    model: composed.model,
    validation: composed.report,
    notice: noticeFor(changeset, freshness, composed.model === null),
  };
}

/**
 * Compose with the model, falling back to the code-written digest when the
 * provider is unavailable.
 *
 * `chatModel()` throws synchronously on a missing key, which is the normal
 * state of a fresh clone. A plain panel beats a 503 and an empty one.
 */
async function composeOrFallback(params: {
  principal: Principal;
  matterLabel: string;
  changeset: Changeset;
  signal?: AbortSignal;
}) {
  try {
    return await composeDigest(params);
  } catch (error) {
    if (params.signal?.aborted) throw error;
    return {
      digest: deterministicDigest(params.changeset),
      report: {
        keptSentences: 0,
        strippedSentences: 0,
        unknownRefs: [],
        reasons: [
          error instanceof Error
            ? `Model unavailable: ${error.message}`
            : "Model unavailable.",
        ],
        fellBack: true,
      } satisfies ValidationReport,
      usage: { inputTokens: null, outputTokens: null },
      model: null as string | null,
    };
  }
}

function noticeFor(
  changeset: Changeset,
  freshness: FreshnessResult,
  withoutModel = false,
): string | null {
  const notes: string[] = [];

  if (freshness.error) {
    notes.push(`Showing cached data: the Clio refresh failed (${freshness.error}).`);
  }
  if (changeset.degraded) {
    notes.push(
      "Some of these are inferred from record timestamps rather than tracked changes, " +
        "so a few may have been on file already.",
    );
  }
  if (changeset.history.truncated && changeset.history.startsAt) {
    notes.push(`Change tracking starts ${changeset.history.startsAt}.`);
  }
  if (withoutModel) {
    notes.push("Written without a model, so the wording is plainer than usual.");
  }

  return notes.length > 0 ? notes.join(" ") : null;
}
