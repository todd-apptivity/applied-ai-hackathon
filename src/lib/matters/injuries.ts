/**
 * The body map for one matter, read from the local index.
 *
 * This is the half of the injury scan that touches the machine: it selects the
 * records a principal may read, screens them, and hands them to the pure scan
 * in ./injury-scan. The case view does the same thing against live Clio
 * records, which is why the lexicon is not in this file.
 *
 * Access control is applied by *not passing the record*. A region a viewer may
 * not read does not appear faintly or as a withheld placeholder — the scan
 * never sees the text that would have produced it, so there is nothing to leak
 * through an intensity or a count.
 */

import { sourceLink } from "@/lib/chat/source-link";
import { getDb } from "@/lib/db/sqlite";
import { allowedKinds, canAccessMatter, screenText } from "@/lib/permissions/policy";
import type { Principal } from "@/lib/permissions/types";
import type { SourceKind, SourceRecord } from "@/lib/rag/sources";

import { scanInjuries, type InjuryMap } from "./injury-scan";

export type {
  InjuryEvidence,
  InjuryMap,
  InjurySite,
  InjuryTier,
  ScanOptions,
} from "./injury-scan";
export { scanInjuries, resolveSides } from "./injury-scan";

interface SourceRow {
  kind: string;
  clio_id: string;
  page: number;
  title: string | null;
  text: string;
  occurred_at: string | null;
  clio_updated_at: string | null;
  metadata: string;
}

export function injuryMap(principal: Principal, matterId: number): InjuryMap {
  if (!canAccessMatter(principal, matterId)) {
    return { matterId, sites: [], scanned: 0, withheld: 0 };
  }

  const kinds = allowedKinds(principal);
  if (kinds.length === 0) {
    return { matterId, sites: [], scanned: 0, withheld: 0 };
  }

  const rows = readSources(matterId, kinds);
  const records: SourceRecord[] = [];
  let withheld = 0;

  for (const row of rows) {
    const record = toRecord(row, matterId);

    // The kind filter already ran in SQL; this is the topic half of the same
    // rule, and it is the stub described in lib/permissions/policy.
    if (
      principal.kind === "provider" &&
      screenText(`${record.title}\n${record.text}`, principal.releasedTopics).blocked
    ) {
      withheld += 1;
      continue;
    }

    records.push(record);
  }

  const sites = scanInjuries(records, {
    link: (record) => sourceLink(record.kind, record.clioId, matterId, record.metadata),
  });

  return { matterId, sites, scanned: records.length, withheld };
}

function readSources(matterId: number, kinds: readonly SourceKind[]): SourceRow[] {
  const placeholders = kinds.map(() => "?").join(",");
  return getDb()
    .prepare(
      `SELECT kind, clio_id, page, title, text, occurred_at, clio_updated_at, metadata
         FROM sources
        WHERE matter_id = ? AND kind IN (${placeholders})
        ORDER BY occurred_at IS NULL, occurred_at, id`,
    )
    .all(matterId, ...kinds) as unknown as SourceRow[];
}

/** A stored row back into the shape the rest of the codebase passes around. */
function toRecord(row: SourceRow, matterId: number): SourceRecord {
  let metadata: Record<string, unknown> = {};
  try {
    metadata = JSON.parse(row.metadata) as Record<string, unknown>;
  } catch {
    metadata = {};
  }

  return {
    matterId,
    kind: row.kind as SourceKind,
    clioId: row.clio_id,
    page: row.page,
    title: row.title ?? "",
    text: row.text,
    occurredAt: row.occurred_at,
    clioUpdatedAt: row.clio_updated_at,
    metadata,
    needsText: false,
  };
}
