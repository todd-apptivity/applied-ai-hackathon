/**
 * Who is asking — STUB.
 *
 * Nothing here is authentication. There is no session, no cookie, no token
 * verification: the viewer is read from a query parameter so the two cases can
 * be demonstrated side by side. Anyone can type `?as=firm`.
 *
 * TODO(auth): replace `getPrincipal` with two real lookups and delete the
 * query-parameter path entirely.
 *
 *   firm      -> the signed-in staff session (userId, name, firm id)
 *   provider  -> `provider_shares` row keyed by the unguessable share token in
 *                the URL, which carries matter_id, provider_id, the attorney's
 *                approved kinds and released topics, and revoked_at. The PRD:
 *                "One unguessable link per provider per matter, revocable,
 *                with no Clio access behind it."
 *
 * Until that exists, treat every provider-mode answer as a UI demonstration,
 * not as a privacy boundary that has been tested.
 */

import type { Principal, ProviderPrincipal } from "./types";

export type ViewAs = "firm" | "provider";

export function parseViewAs(value: unknown): ViewAs {
  return value === "provider" ? "provider" : "firm";
}

/**
 * The stub provider. Approves only the records a treating provider needs to
 * answer "where does my patient's case stand and what do you need from me":
 * the matter shell, open tasks, treatment calendar, and documents.
 *
 * `releasedTopics` is empty: no default-deny topic is released until an
 * attorney releases it.
 */
function demoProvider(matterId: number): ProviderPrincipal {
  return {
    kind: "provider",
    providerId: "demo-provider",
    name: "Outside provider (demo)",
    matterId,
    shareId: "demo-share",
    approvedKinds: ["matter", "task", "calendar_entry", "document", "document_page"],
    releasedTopics: [],
  };
}

const FIRM_USER: Principal = {
  kind: "firm",
  userId: "demo-firm-user",
  name: "Firm staff (demo)",
};

/**
 * Build a principal for a request. `matterId` is needed for the provider case
 * because a real share is scoped to one matter; the stub binds the requested
 * matter so the scope check has something to compare against.
 */
export function getPrincipal(viewAs: ViewAs, matterId: number): Principal {
  return viewAs === "provider" ? demoProvider(matterId) : FIRM_USER;
}

/** Reads the viewer from a URL. Same stub, request-shaped. */
export function getPrincipalFromRequest(request: Request, matterId: number): Principal {
  const url = new URL(request.url);
  const header = request.headers.get("x-ninety-view-as");
  return getPrincipal(parseViewAs(header ?? url.searchParams.get("as")), matterId);
}

export function describePrincipal(principal: Principal): string {
  return principal.kind === "firm"
    ? "firm staff"
    : "a treating provider outside the firm";
}
