/**
 * Deep link from a retrieved passage back into Clio.
 *
 * NOTE: `src/app/api/rag/search/route.ts` has a near-identical helper. That
 * file is under active edit, so this is a deliberate copy rather than a shared
 * extraction — consolidate the two into one module once that route settles.
 */

import { clioHost } from "@/lib/clio/config";
import { clioLinks } from "@/lib/clio/resources";

export function sourceLink(
  kind: string,
  clioId: string,
  matterId: number,
  metadata: Record<string, unknown> = {},
): string | null {
  const host = clioHost();
  const id = Number(clioId);
  const addressable = Number.isFinite(id) && id > 0;

  switch (kind) {
    case "matter":
      return addressable ? clioLinks.matter(host, id) : null;
    case "contact":
      return addressable ? clioLinks.contact(host, id) : null;
    case "task":
      return addressable ? clioLinks.task(host, id) : null;
    case "calendar_entry":
      return addressable ? clioLinks.calendarEntry(host, id) : null;
    case "activity":
      return addressable ? clioLinks.activity(host, id) : null;
    case "document":
      return addressable ? clioLinks.document(host, id) : null;
    case "document_page": {
      const documentId = Number(metadata.documentId ?? id);
      return Number.isFinite(documentId) && documentId > 0
        ? clioLinks.document(host, documentId)
        : null;
    }
    default:
      // Notes, communications, and custom fields have no page of their own;
      // the matter that holds them beats no link at all.
      return clioLinks.matter(host, matterId);
  }
}
