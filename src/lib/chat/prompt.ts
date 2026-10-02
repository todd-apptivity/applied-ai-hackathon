/**
 * The case agent's instructions.
 *
 * The grounding and scope blocks live in `./grounding` because the change
 * digest uses the same ones; this file is now just the chat-shaped assembly of
 * them.
 */

import { allowedKinds } from "@/lib/permissions/policy";
import type { Principal } from "@/lib/permissions/types";

import { FIRM_SCOPE, GROUNDING_RULES, PROVIDER_SCOPE } from "./grounding";
import { kindLabel } from "./types";

export function caseAgentPrompt(principal: Principal, matterLabel: string): string {
  const scope = principal.kind === "firm" ? FIRM_SCOPE : PROVIDER_SCOPE;
  const kinds = allowedKinds(principal)
    .map((kind) => `${kind} (${kindLabel(kind)})`)
    .join(", ");

  return [
    GROUNDING_RULES,
    scope,
    `Matter under discussion: ${matterLabel}.`,
    `Record kinds you can search: ${kinds}.`,
  ].join("\n\n");
}
