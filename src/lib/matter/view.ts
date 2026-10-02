/**
 * The lawyer view of one matter: records from the configured source, shaped by
 * `deriveView`. This is the only place the two meet.
 */

import { cache } from "react";

import { sourceLink } from "@/lib/chat/source-link";

import { deriveView, type MatterView } from "./derive";
import { matterSource } from "./source";

/** Memoised per request, so one render reads the source once. */
export const loadMatterView = cache(async (matterId: number): Promise<MatterView> => {
  const records = await matterSource().load(matterId);
  return deriveView(records, {
    now: new Date(),
    link: (record) => sourceLink(record.kind, record.clioId, record.matterId, record.metadata),
  });
});
