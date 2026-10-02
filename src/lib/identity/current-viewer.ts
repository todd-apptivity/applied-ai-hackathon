/**
 * Which viewer is this request?
 *
 * Two entry points because Next has two worlds. Server Components read cookies
 * through `next/headers`, which is async and unavailable in a route handler's
 * plain `Request`; route handlers parse the header themselves. Both land on the
 * same `viewers` row, so a page and the API it calls never disagree about who
 * is asking.
 *
 * Resolution order is cookie, then the legacy `x-ninety-view-as` header and
 * `?as=` parameter that `/chat` still sends, then the default firm viewer.
 * Keeping the legacy path means this module can be adopted route by route
 * without regressing the chat page.
 */

import { cookies } from "next/headers";

import { parseViewAs, type ViewAs } from "@/lib/permissions/principal";
import type { Principal } from "@/lib/permissions/types";

import {
  DEMO_PROVIDER_VIEWER_ID,
  defaultViewer,
  getViewer,
  listViewers,
  upsertViewer,
  viewerToPrincipal,
  type ViewerRecord,
} from "./viewers";

export const VIEWER_COOKIE = "ninety_viewer";

/** Some viewer with this role, seeding the demo provider if none exists yet. */
function viewerForRole(role: ViewAs): ViewerRecord {
  if (role === "firm") return defaultViewer();

  const provider = listViewers().find((viewer) => viewer.role === "provider");
  if (provider) return provider;

  return upsertViewer({
    id: DEMO_PROVIDER_VIEWER_ID,
    name: "Outside provider (demo)",
    role: "provider",
    clioUserId: null,
    matterId: null,
  });
}

/**
 * Resolve a viewer id that may be stale — a cookie outlives the row it names
 * when the database is rebuilt, and a dangling id must not 500 a page.
 */
function resolveViewerId(id: string | undefined | null): ViewerRecord | null {
  if (!id) return null;
  return getViewer(id);
}

/** For Server Components and Server Functions. */
export async function currentViewer(): Promise<ViewerRecord> {
  const store = await cookies();
  return resolveViewerId(store.get(VIEWER_COOKIE)?.value) ?? defaultViewer();
}

/** For route handlers: no `next/headers`, no await. */
export function viewerFromRequest(request: Request): ViewerRecord {
  const fromCookie = resolveViewerId(readCookie(request, VIEWER_COOKIE));
  if (fromCookie) return fromCookie;

  // Legacy stub path, still used by /chat.
  const url = new URL(request.url);
  const header = request.headers.get("x-ninety-view-as");
  const asked = header ?? url.searchParams.get("as");
  if (asked) return viewerForRole(parseViewAs(asked));

  return defaultViewer();
}

/** The route-handler entry point: a viewer and the principal it implies. */
export function resolvePrincipal(
  request: Request,
  matterId: number,
): { viewer: ViewerRecord; principal: Principal } {
  const viewer = viewerFromRequest(request);
  return { viewer, principal: viewerToPrincipal(viewer, matterId) };
}

/**
 * Read one cookie from a raw request.
 *
 * `NextRequest` has `.cookies`, but this module is handed plain `Request`
 * objects by the test suite and by `scripts/`, so it parses the header rather
 * than requiring the Next wrapper.
 */
function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;

  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    if (part.slice(0, index).trim() !== name) continue;
    return decodeURIComponent(part.slice(index + 1).trim());
  }
  return null;
}
