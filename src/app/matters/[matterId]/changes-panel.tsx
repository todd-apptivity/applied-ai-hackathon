/**
 * "What happened since I last reviewed this?"
 *
 * A server component, which is what the work wants to be: resolving the window
 * advances this viewer's review session, the refresh talks to Clio, and the
 * compose talks to a model — none of that belongs in the browser. The page
 * streams it in behind a Suspense boundary so the shell paints immediately.
 *
 * Rendering this panel IS the visit. That is deliberate: the checkpoint should
 * move when someone opens the matter, and a session gap is what decides
 * whether the baseline advances, so a refresh inside one sitting is free.
 */

import { ChangeCard, CitationChip, type CitationInfo } from "@/components/changes/change-citation";
import type { DigestSection } from "@/lib/changes/compose";
import { changeDigest, type ChangeDigest } from "@/lib/changes/digest";
import type { WindowRequest } from "@/lib/changes/checkpoint";
import { currentViewer } from "@/lib/identity/current-viewer";
import { viewerToPrincipal } from "@/lib/identity/viewers";

import { MarkReviewedButton } from "./mark-reviewed-button";
import { WindowSelector } from "./window-selector";
import { WINDOW_LABELS, parseWindowChoice, type WindowChoice } from "./window";

const PREVIEW_EVENTS = 8;

export function ChangesPanelFallback({ choice }: { choice: WindowChoice }) {
  return (
    <Frame choice={choice} subtitle="Checking Clio for changes…" controls={null}>
      <p className="text-sm text-muted-foreground">
        Reading the change log and writing the summary…
      </p>
    </Frame>
  );
}

export async function ChangesPanel({
  matterId,
  windowParam,
}: {
  matterId: number;
  windowParam: string | undefined;
}) {
  const choice = parseWindowChoice(windowParam);
  const viewer = await currentViewer();

  let data: ChangeDigest;
  try {
    data = await changeDigest({
      principal: viewerToPrincipal(viewer, matterId),
      viewerId: viewer.id,
      matterId,
      window: windowRequest(choice),
    });
  } catch (error) {
    return (
      <Frame choice={choice} subtitle={null} controls={null}>
        <p className="rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
          {error instanceof Error ? error.message : "Could not load changes."}
        </p>
      </Frame>
    );
  }

  const events = data.events.slice(0, PREVIEW_EVENTS);
  const hidden = data.events.length - events.length;

  return (
    <Frame
      choice={choice}
      subtitle={subtitle(data)}
      controls={<MarkReviewedButton matterId={matterId} />}
    >
      {data.notice ? (
        <p className="mb-3 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
          {data.notice}
        </p>
      ) : null}

      {data.state === "no_changes" ? (
        <p className="text-sm text-muted-foreground">
          Nothing changed {data.window.label}.{" "}
          {data.freshness.synced
            ? "Clio was checked just now."
            : "Clio was checked recently."}
        </p>
      ) : null}

      {data.digest ? (
        <>
          <p className="text-sm font-medium">
            {data.digest.headline}{" "}
            <Citations refs={data.digest.headlineRefs} citations={data.citations} />
          </p>

          <div className="mt-3 space-y-3">
            {data.digest.sections.map((section) => (
              <Section
                key={section.heading}
                section={section}
                citations={data.citations}
              />
            ))}
          </div>
        </>
      ) : null}

      {data.events.length > 0 ? (
        <details className="mt-4" open={data.digest === null}>
          <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
            {data.counts.total} change{data.counts.total === 1 ? "" : "s"} in this window
            {hidden > 0 ? ` — showing the top ${events.length}` : ""}
          </summary>
          <ul className="mt-2 space-y-2">
            {events.map((event) => (
              <ChangeCard key={`${event.ref}:${event.type}`} event={event} />
            ))}
          </ul>
        </details>
      ) : null}

      <Footnotes data={data} />
    </Frame>
  );
}

function windowRequest(choice: WindowChoice): WindowRequest {
  return choice === "checkpoint"
    ? { kind: "checkpoint" }
    : { kind: "relative", days: Number(choice) };
}

function subtitle(data: ChangeDigest): string {
  const parts = [data.window.label];
  if (data.freshness.syncedAt) {
    parts.push(`as of ${data.freshness.syncedAt.slice(0, 16).replace("T", " ")}`);
  }
  return parts.join(" · ");
}

function Frame({
  choice,
  subtitle,
  controls,
  children,
}: {
  choice: WindowChoice;
  subtitle: string | null;
  controls: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border border-border bg-card">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold tracking-tight">What changed</h2>
          <p className="text-xs text-muted-foreground">
            {subtitle ?? WINDOW_LABELS[choice]}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <WindowSelector choice={choice} />
          {controls}
        </div>
      </header>
      <div className="px-4 py-4">{children}</div>
    </section>
  );
}

function Section({
  section,
  citations,
}: {
  section: DigestSection;
  citations: Record<string, CitationInfo>;
}) {
  return (
    <div>
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {section.heading}
      </h3>
      <ul className="mt-1 space-y-1">
        {section.sentences.map((sentence, index) => (
          <li key={`${section.heading}:${index}`} className="text-sm">
            {sentence.text} <Citations refs={sentence.refs} citations={citations} />
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Every sentence carries at least one of these; the server guarantees it. */
function Citations({
  refs,
  citations,
}: {
  refs: string[];
  citations: Record<string, CitationInfo>;
}) {
  return (
    <span className="inline-flex flex-wrap gap-1">
      {refs.map((ref) => (
        <CitationChip
          key={ref}
          citation={citations[ref] ?? { ref, label: ref, clioUrl: null }}
        />
      ))}
    </span>
  );
}

function Footnotes({ data }: { data: ChangeDigest }) {
  const notes: string[] = [];

  if (data.withheld.count > 0) {
    const topics = data.withheld.topics.length
      ? ` (${data.withheld.topics.join(", ")})`
      : "";
    notes.push(
      `${data.withheld.count} change${data.withheld.count === 1 ? "" : "s"} withheld from this view${topics}.`,
    );
  }
  if (data.cached) notes.push("Reused a cached summary; no model call.");
  else if (data.model) notes.push(`Written by ${data.model}.`);
  if (data.validation && data.validation.strippedSentences > 0) {
    notes.push(
      `${data.validation.strippedSentences} uncited sentence(s) were removed before display.`,
    );
  }

  if (notes.length === 0) return null;

  return <p className="mt-4 text-[11px] text-muted-foreground">{notes.join(" ")}</p>;
}
