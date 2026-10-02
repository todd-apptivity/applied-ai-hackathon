import { headers } from "next/headers";

import { isMatterIndexed, matterLabel } from "@/lib/changes/digest";
import { currentViewer } from "@/lib/identity/current-viewer";
import { isVoyageConfigured } from "@/lib/rag/config";

import { CaseFrame } from "./case-frame";
import { FloatingChat } from "./floating-chat";

export const metadata = { title: "Case" };

/**
 * The case page: the case view, sized to the device, with the chat as a
 * floating widget over it.
 *
 * The view itself is a document served by ./view, read live from Clio. The
 * chat needs the search index, so the widget only appears once the matter has
 * been indexed.
 */
export default async function CasePage({ params }: PageProps<"/matters/[matterId]/case">) {
  const { matterId } = await params;
  const id = Number(matterId);

  if (!Number.isInteger(id) || id <= 0) {
    return <p className="p-6 text-sm text-muted-foreground">That is not a case id.</p>;
  }

  const indexed = isMatterIndexed(id);
  const label = indexed ? matterLabel(id) : `Case ${id}`;
  const viewer = await currentViewer();
  // A first guess, so a phone does not load the desk view before the width is known.
  const initialPhone = /Mobi|Android|iPhone/i.test((await headers()).get("user-agent") ?? "");

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <CaseFrame matterId={id} title={label} initialPhone={initialPhone} />
      {indexed && isVoyageConfigured() ? (
        <FloatingChat matterId={id} matterLabel={label} viewAs={viewer.role} />
      ) : null}
    </div>
  );
}
