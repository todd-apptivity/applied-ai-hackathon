/**
 * Where a matter's records come from.
 *
 * The lawyer views read through this seam instead of calling Clio themselves,
 * so the source can change without touching them. Today there is one adapter,
 * which reads Clio live on every request. The contract is `SourceRecord[]` —
 * the same shape the local `sources` table stores — so a cached adapter is a
 * SELECT over that table rather than a second mapping from Clio's shapes.
 */

import { getMatterBundle } from "@/lib/clio/resources";
import { bundleToSources, type SourceRecord } from "@/lib/rag/sources";

export interface MatterSource {
  readonly name: string;
  /** Every record of one matter. Read-only; never writes to Clio. */
  load(matterId: number, options?: { signal?: AbortSignal }): Promise<SourceRecord[]>;
}

/** Reads the matter from the Clio API on every call. No persistence. */
export class ClioLiveSource implements MatterSource {
  readonly name = "clio";

  async load(matterId: number, options: { signal?: AbortSignal } = {}): Promise<SourceRecord[]> {
    const bundle = await getMatterBundle(matterId, { signal: options.signal });
    return bundleToSources(bundle);
  }
}

const ADAPTERS: Record<string, () => MatterSource> = {
  clio: () => new ClioLiveSource(),
  // cache: () => new CachedSource(),  — reads `sources` in SQLite; not built yet.
};

/** The adapter named by MATTER_SOURCE, defaulting to live Clio. */
export function matterSource(name: string = process.env.MATTER_SOURCE ?? "clio"): MatterSource {
  const make = ADAPTERS[name];
  if (!make) {
    throw new Error(
      `Unknown MATTER_SOURCE "${name}". Available: ${Object.keys(ADAPTERS).join(", ")}.`,
    );
  }
  return make();
}
