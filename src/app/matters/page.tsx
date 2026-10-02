import Link from "next/link";

import { ViewerSwitcher } from "@/components/changes/viewer-switcher";
import { currentViewer } from "@/lib/identity/current-viewer";
import { listViewers, viewerToPrincipal } from "@/lib/identity/viewers";
import { listIndexedMatters, listingLabel, type MatterListing } from "@/lib/matters/registry";
import { allowedKinds, canAccessMatter } from "@/lib/permissions/policy";

export const metadata = { title: "Cases" };

/**
 * The matter picker.
 *
 * Exists so `/matters/<id>` is reachable by clicking rather than by typing an
 * id. It leads with what each case is waiting on for *this* viewer, because a
 * list of identifiers is navigation and a list of pending changes is a reason
 * to open one.
 */
export default async function MattersPage() {
  const viewer = await currentViewer();

  /**
   * The principal to judge one row by.
   *
   * `viewerToPrincipal` falls back to the requested matter when a provider row
   * carries no scope of its own — right for a single-matter request, wrong
   * here, where it would hand every row its own scope and so pass every check.
   * A provider with no share matter is scoped to nothing instead.
   */
  const principalFor = (matterId: number) =>
    viewer.role === "provider"
      ? viewerToPrincipal(viewer, viewer.matterId ?? Number.NaN)
      : viewerToPrincipal(viewer, matterId);

  // One implementation of matter scope, reused: the rule stays in the
  // permission layer rather than being restated as SQL here.
  const matters = listIndexedMatters({
    viewerId: viewer.id,
    kinds: allowedKinds(principalFor(0)),
  }).filter((matter) => canAccessMatter(principalFor(matter.matterId), matter.matterId));

  return (
    <main className="mx-auto w-full max-w-4xl flex-1 overflow-y-auto px-6 py-8 font-sans">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Cases</h1>
          <p className="text-sm text-muted-foreground">
            {matters.length === 0
              ? "Nothing indexed yet"
              : `${matters.length} case${matters.length === 1 ? "" : "s"} in the local index`}
          </p>
        </div>
        <ViewerSwitcher
          viewers={listViewers().map((item) => ({
            id: item.id,
            name: item.name,
            role: item.role,
          }))}
          currentId={viewer.id}
        />
      </header>

      {matters.length === 0 ? <Empty /> : (
        <ul className="mt-6 space-y-3">
          {matters.map((matter) => (
            <MatterRow key={matter.matterId} matter={matter} />
          ))}
        </ul>
      )}
    </main>
  );
}

function MatterRow({ matter }: { matter: MatterListing }) {
  const label = listingLabel(matter);

  return (
    <li>
      <Link
        href={`/matters/${matter.matterId}/case`}
        className="block rounded-lg border border-border bg-card px-4 py-3 hover:border-foreground/30"
      >
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h2 className="text-sm font-semibold tracking-tight">{label}</h2>
          <Waiting matter={matter} />
        </div>

        {matter.description && matter.description !== label ? (
          <p className="mt-0.5 text-sm text-muted-foreground">{matter.description}</p>
        ) : null}

        <p className="mt-1 text-xs text-muted-foreground">
          {[
            matter.clientName,
            matter.status,
            `${matter.sources} record${matter.sources === 1 ? "" : "s"}`,
            matter.lastSyncedAt
              ? `synced ${matter.lastSyncedAt.slice(0, 10)}`
              : "never synced",
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
      </Link>
    </li>
  );
}

/**
 * What this viewer has waiting.
 *
 * A null count means no baseline yet rather than nothing new, and saying
 * "0 changes" there would be a claim we have not earned.
 */
function Waiting({ matter }: { matter: MatterListing }) {
  if (matter.reviewedThrough === null) {
    return (
      <span className="shrink-0 rounded bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
        Not reviewed yet
      </span>
    );
  }

  if (!matter.pendingChanges) {
    return (
      <span className="shrink-0 text-[11px] text-muted-foreground">
        Reviewed {matter.reviewedThrough.slice(0, 10)}
      </span>
    );
  }

  return (
    <span className="shrink-0 rounded bg-foreground px-2 py-0.5 text-[11px] font-medium text-background">
      {matter.pendingChanges} change{matter.pendingChanges === 1 ? "" : "s"} since you
      reviewed
    </span>
  );
}

function Empty() {
  return (
    <div className="mt-6">
      <p className="text-sm text-muted-foreground">
        Connect Clio on the{" "}
        <Link href="/clio" className="underline">
          connection page
        </Link>
        , then pull a matter into the local index:
      </p>
      <pre className="mt-4 overflow-x-auto rounded border border-border bg-muted px-4 py-3 font-mono text-xs">
        {"npm run rag:seed -- --matter <matter id>\nnpm run rag:embed"}
      </pre>
    </div>
  );
}
