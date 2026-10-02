import Link from "next/link";
import { Suspense } from "react";

import { ChangesPanel, ChangesPanelFallback } from "./changes-panel";
import { CaseChatPanel } from "./case-chat-panel";
import { parseWindowChoice } from "./window";
import { ViewerSwitcher } from "@/components/changes/viewer-switcher";
import { isMatterIndexed, matterLabel } from "@/lib/changes/digest";
import { currentViewer } from "@/lib/identity/current-viewer";
import { listViewers } from "@/lib/identity/viewers";
import { isVoyageConfigured } from "@/lib/rag/config";

export const metadata = { title: "Case dashboard" };

/**
 * The case dashboard, which the PRD describes as a matter a new team member can
 * read in 90 seconds.
 *
 * This is the first panel of it: what changed since you last reviewed the file,
 * with the chat as a rail beside it for anything the panel does not answer. The
 * remaining panels — the 90-second story, now/next/waiting, the ranked timeline
 * — join this layout rather than replacing it.
 */
export default async function MatterPage({
  params,
  searchParams,
}: PageProps<"/matters/[matterId]">) {
  const { matterId } = await params;
  const id = Number(matterId);

  if (!Number.isInteger(id) || id <= 0) {
    return <Setup title="Case dashboard">That is not a matter id.</Setup>;
  }

  if (!isMatterIndexed(id)) {
    return (
      <Setup title="Case dashboard">
        <p className="text-sm text-muted-foreground">
          Matter {id} is not in the local index. Connect Clio on the{" "}
          <Link href="/clio" className="underline">
            connection page
          </Link>
          , then build the index:
        </p>
        <pre className="mt-4 overflow-x-auto rounded border border-border bg-muted px-4 py-3 font-mono text-xs">
          {`npm run rag:seed -- --matter ${id}\nnpm run rag:embed`}
        </pre>
      </Setup>
    );
  }

  const label = matterLabel(id);
  const viewer = await currentViewer();
  const viewers = listViewers();
  const choice = parseWindowChoice(
    typeof (await searchParams).window === "string"
      ? ((await searchParams).window as string)
      : undefined,
  );

  return (
    <div className="mx-auto flex min-h-0 w-full max-w-6xl flex-1 flex-col gap-6 overflow-hidden px-6 py-8 font-sans">
      <header className="flex shrink-0 flex-wrap items-start justify-between gap-3">
        <div>
          <Link
            href="/matters"
            className="text-xs text-muted-foreground underline hover:text-foreground"
          >
            All cases
          </Link>
          {/* A plain anchor: the case view is its own document, not a page in this layout. */}
          <a
            href={`/matters/${id}/case`}
            className="ml-3 text-xs text-muted-foreground underline hover:text-foreground"
          >
            Open the case
          </a>
          <h1 className="mt-1 text-xl font-semibold tracking-tight">{label}</h1>
          <p className="text-sm text-muted-foreground">
            Matter {id} · viewing as {viewer.name}
          </p>
        </div>
        <ViewerSwitcher
          viewers={viewers.map((item) => ({
            id: item.id,
            name: item.name,
            role: item.role,
          }))}
          currentId={viewer.id}
          matterId={id}
        />
      </header>

      {viewer.role === "provider" ? (
        <p className="shrink-0 rounded border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
          <strong className="font-semibold">Outside provider view.</strong>{" "}
          Attorney notes, internal communications, time and expenses, coverage,
          and case value are removed before anything is summarised. Permission
          checks here are stubbed for the demo — not a tested privacy boundary.
        </p>
      ) : null}

      {/*
        Two columns side by side, each scrolling on its own, so a long digest
        cannot push the chat composer off the bottom of the screen. Stacked on
        a narrow viewport there is no room for that, so the whole grid scrolls
        as one and the chat becomes a fixed-height box instead.
      */}
      <div className="grid min-h-0 flex-1 gap-6 overflow-y-auto lg:grid-cols-[minmax(0,1fr)_minmax(0,24rem)] lg:overflow-hidden">
        <div className="min-w-0 space-y-6 lg:overflow-y-auto">
          {/* Streamed in: the panel syncs Clio and may call a model, and the
              shell should not wait on either. `key` forces a fresh boundary per
              window so switching shows the fallback rather than stale prose. */}
          <Suspense key={choice} fallback={<ChangesPanelFallback choice={choice} />}>
            <ChangesPanel matterId={id} windowParam={choice} />
          </Suspense>

          <section className="rounded-lg border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">
            The 90-second story, now/next/waiting, and the ranked timeline go
            here. Each will render from the same cited records this panel uses.
          </section>
        </div>

        {/* `overflow-hidden` plus a definite height is what lets the thread's
            own `h-full` scroller resolve instead of running past the card. */}
        <aside className="flex h-[32rem] max-h-[70dvh] min-h-0 flex-col overflow-hidden rounded-lg border border-border bg-card lg:h-auto lg:max-h-none">
          <header className="shrink-0 border-b border-border px-4 py-3">
            <h2 className="text-sm font-semibold tracking-tight">Ask the file</h2>
            <p className="text-xs text-muted-foreground">
              Grounded in the same records, with citations.
            </p>
          </header>
          <div className="flex min-h-0 flex-1 flex-col p-2">
            {isVoyageConfigured() ? (
              <CaseChatPanel
                matterId={id}
                matterLabel={label}
                viewAs={viewer.role}
              />
            ) : (
              <p className="px-2 py-4 text-xs text-muted-foreground">
                <code className="font-mono">VOYAGE_API_KEY</code> is not set, so
                retrieval cannot embed a question. The change panel still works:
                it reads the change log, not the index.
              </p>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}

function Setup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-12 font-sans">
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      <div className="mt-6">{children}</div>
    </main>
  );
}
