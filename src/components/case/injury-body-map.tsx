"use client";

/**
 * Where the client is hurt, as a picture.
 *
 * A personal injury file names the same four or five body parts across three
 * hundred records, and a reader meeting the matter for the first time has to
 * assemble that list by reading. This draws it: two silhouettes, front and
 * back, with heat over the regions the file keeps returning to.
 *
 * Heat rather than pins, because the underlying signal is a weight and not a
 * coordinate — the extractor knows "the file is loud about the left shoulder",
 * not "the tear is 4cm inferior to the acromion". A soft blob is honest about
 * that; a precise pin would claim more than the data supports. The small dot at
 * each centre is a hit target and a reading anchor, not a diagnosis.
 *
 * Front and back are shown together rather than behind a toggle: the spine is
 * only drawable from behind, and a reader who never finds the toggle would
 * never learn the lumbar spine is in the claim at all.
 *
 * Standalone and presentational — it takes sites and renders them. Everything
 * about reading the file lives in `@/lib/matters/injuries`.
 */

import { useId, useState } from "react";

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  BODY_PATHS,
  BODY_VIEWBOX,
  bodyRegion,
  regionPoint,
  type BodyView,
} from "@/lib/matters/body-regions";
import type { InjurySite, InjuryTier } from "@/lib/matters/injuries";
import { cn } from "@/lib/utils";

const VIEW_LABELS: Record<BodyView, string> = {
  anterior: "Front",
  posterior: "Back",
};

const TIER_LABELS: Record<InjuryTier, string> = {
  severe: "Heavily documented",
  moderate: "Documented",
  mild: "Mentioned",
};

export interface InjuryBodyMapProps {
  sites: readonly InjurySite[];
  /** Shown under the heading — usually the client's name. */
  subject?: string | null;
  /** Records read to build this, for the footnote. */
  scanned?: number;
  /** Records this viewer may not read, for the footnote. */
  withheld?: number;
  className?: string;
}

export function InjuryBodyMap({
  sites,
  subject,
  scanned,
  withheld = 0,
  className,
}: InjuryBodyMapProps) {
  // One id at a time, shared by both silhouettes and the list, so pointing at
  // a region anywhere lights it everywhere.
  const [active, setActive] = useState<string | null>(null);

  const documented = sites.filter((site) => site.tier !== "mild");
  const passing = sites.filter((site) => site.tier === "mild");

  return (
    <section className={cn("rounded-lg border border-border bg-card", className)}>
      <header className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold tracking-tight">Injury map</h2>
          <p className="text-xs text-muted-foreground">
            {subject ? `${subject} — read` : "Read"} from the records on file. Heat is how
            heavily a region is documented, not how severe it is.
          </p>
        </div>
      </header>

      {sites.length === 0 ? (
        <p className="px-4 py-6 text-sm text-muted-foreground">
          No body part is named in the records this view can read.
        </p>
      ) : (
        <TooltipProvider delayDuration={80}>
          <div className="grid gap-6 px-4 py-4 sm:grid-cols-[minmax(0,19rem)_minmax(0,1fr)]">
            <div className="flex items-start justify-center gap-3">
              {(["anterior", "posterior"] as const).map((view) => (
                <Silhouette
                  key={view}
                  view={view}
                  sites={sites}
                  active={active}
                  onActive={setActive}
                />
              ))}
            </div>

            <div className="min-w-0 space-y-2">
              <SiteList sites={documented} active={active} onActive={setActive} />

              {/*
                The tail is long and mostly incidental — a body part named once
                in a defence exhibit is not an injury, but it is not nothing
                either. Folded away rather than dropped, because the reader who
                wants it is the one checking whether something was missed.
              */}
              {passing.length > 0 ? (
                <details className="rounded-md border border-dashed border-border px-2.5 py-2">
                  <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
                    {passing.length} more region{passing.length === 1 ? "" : "s"} mentioned in
                    passing
                  </summary>
                  <div className="mt-2">
                    <SiteList sites={passing} active={active} onActive={setActive} />
                  </div>
                </details>
              ) : null}
            </div>
          </div>

          <Legend sites={sites} scanned={scanned} withheld={withheld} />
        </TooltipProvider>
      )}
    </section>
  );
}

/* --- the drawing --------------------------------------------------------- */

function Silhouette({
  view,
  sites,
  active,
  onActive,
}: {
  view: BodyView;
  sites: readonly InjurySite[];
  active: string | null;
  onActive: (id: string | null) => void;
}) {
  const uid = useId();
  const clipId = `${uid}-clip`;
  const blurId = `${uid}-blur`;

  const drawn = sites.flatMap((site) => {
    const region = bodyRegion(site.regionId);
    if (!region || !region.views.includes(view)) return [];
    return [{ site, region, point: regionPoint(region, view) }];
  });

  return (
    <figure className="min-w-0 flex-1">
      <div className="relative">
        <svg
          viewBox={`0 0 ${BODY_VIEWBOX.width} ${BODY_VIEWBOX.height}`}
          className="h-auto w-full"
          role="img"
          aria-label={`${VIEW_LABELS[view]} view of the body with the documented regions highlighted`}
        >
          <defs>
            <clipPath id={clipId}>
              {BODY_PATHS.map((d, index) => (
                <path key={index} d={d} />
              ))}
            </clipPath>
            {/* Generous filter region: the blur has to spread well past each
                blob's own box before the clip cuts it at the body's edge. */}
            <filter id={blurId} x="-40%" y="-40%" width="180%" height="180%">
              <feGaussianBlur stdDeviation="8" />
            </filter>
          </defs>

          <g className="fill-muted-foreground/35">
            {BODY_PATHS.map((d, index) => (
              <path key={index} d={d} />
            ))}
          </g>

          {/* Filter first, clip second — that is the SVG order, and it is why
              the heat can bleed softly and still stop at the silhouette. */}
          <g clipPath={`url(#${clipId})`} filter={`url(#${blurId})`}>
            {drawn.map(({ site, region, point }) => (
              <circle
                key={site.regionId}
                cx={point.x}
                cy={point.y}
                r={region.radius * (0.55 + 0.45 * site.intensity)}
                fill={heatColor(site.intensity)}
                opacity={
                  (0.3 + 0.6 * site.intensity) *
                  (active && active !== site.regionId ? 0.45 : 1)
                }
              />
            ))}
          </g>

          {/* The dot is the anchor, not the finding. It shrinks with the heat
              so eighteen regions do not read as eighteen injuries. */}
          <g>
            {drawn.map(({ site, point }) => (
              <circle
                key={site.regionId}
                cx={point.x}
                cy={point.y}
                r={active === site.regionId ? 5 : site.tier === "mild" ? 1.8 : 3.2}
                className="fill-destructive"
                opacity={site.tier === "mild" && active !== site.regionId ? 0.55 : 1}
                stroke="var(--card)"
                strokeWidth={site.tier === "mild" ? 0.8 : 1.2}
              />
            ))}
          </g>
        </svg>

        {/* Hit targets live in HTML, not SVG: they need to be real buttons so
            the map answers to a keyboard and not only to a mouse. */}
        {drawn.map(({ site, point }) => (
          <Tooltip key={site.regionId}>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={`${site.label} — ${TIER_LABELS[site.tier]}`}
                onPointerEnter={() => onActive(site.regionId)}
                onPointerLeave={() => onActive(null)}
                onFocus={() => onActive(site.regionId)}
                onBlur={() => onActive(null)}
                className="absolute size-7 -translate-x-1/2 -translate-y-1/2 rounded-full focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                style={{
                  left: `${(point.x / BODY_VIEWBOX.width) * 100}%`,
                  top: `${(point.y / BODY_VIEWBOX.height) * 100}%`,
                }}
              />
            </TooltipTrigger>
            {/* Above the dot, so the bubble never lands on the list it is
                describing. Radix flips it when the top runs out. */}
            <TooltipContent side="top" sideOffset={8} className="max-w-[17rem] px-3 py-2">
              <SiteTooltip site={site} />
            </TooltipContent>
          </Tooltip>
        ))}
      </div>
      <figcaption className="mt-1 text-center text-[11px] text-muted-foreground">
        {VIEW_LABELS[view]}
      </figcaption>
    </figure>
  );
}

/**
 * Amber through to red as the file gets louder.
 *
 * Hue alone carries the scale and the alpha reinforces it, so the map still
 * reads as a ramp when the two reds sit next to each other.
 */
function heatColor(intensity: number): string {
  const hue = Math.round(45 - 45 * Math.min(1, Math.max(0, intensity)));
  return `hsl(${hue} 88% 52%)`;
}

/* --- the words ----------------------------------------------------------- */

function SiteTooltip({ site }: { site: InjurySite }) {
  const top = site.evidence[0];

  return (
    <div className="space-y-1.5 text-left">
      <p className="text-xs font-semibold">{site.label}</p>
      <p className="text-[11px] opacity-80">
        {TIER_LABELS[site.tier]} · {site.mentions} record{site.mentions === 1 ? "" : "s"}
        {site.findings.length > 0 ? ` · ${site.findings.join(", ")}` : ""}
      </p>
      {site.disputed ? (
        <p className="text-[11px] opacity-80">
          Some passages read as prior, denied, or degenerative — check before relying on
          this.
        </p>
      ) : null}
      {top ? (
        <p className="text-[11px] opacity-80">
          <span className="font-medium">
            {top.title}
            {top.date ? ` · ${top.date}` : ""}
          </span>
          <br />
          {top.excerpt}
        </p>
      ) : null}
    </div>
  );
}

function SiteList({
  sites,
  active,
  onActive,
}: {
  sites: readonly InjurySite[];
  active: string | null;
  onActive: (id: string | null) => void;
}) {
  return (
    <ol className="min-w-0 space-y-1.5">
      {sites.map((site) => (
        <li key={site.regionId}>
          <details
            className={cn(
              "rounded-md border px-2.5 py-2 transition-colors",
              active === site.regionId
                ? "border-destructive/60 bg-destructive/5"
                : "border-border bg-background",
            )}
            onPointerEnter={() => onActive(site.regionId)}
            onPointerLeave={() => onActive(null)}
          >
            <summary
              className="flex cursor-pointer list-none items-center gap-2 text-sm"
              onFocus={() => onActive(site.regionId)}
              onBlur={() => onActive(null)}
            >
              <span
                aria-hidden
                className="size-2.5 shrink-0 rounded-full"
                style={{ backgroundColor: heatColor(site.intensity) }}
              />
              <span className="min-w-0 flex-1 truncate font-medium">{site.label}</span>
              {site.disputed ? (
                <span className="shrink-0 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-900 dark:bg-amber-950 dark:text-amber-200">
                  disputed
                </span>
              ) : null}
              <span className="shrink-0 text-[11px] text-muted-foreground">
                {site.mentions}
              </span>
            </summary>

            <div className="mt-2 space-y-2 border-t border-border pt-2">
              <p className="text-[11px] text-muted-foreground">
                {TIER_LABELS[site.tier]}
                {site.findings.length > 0 ? ` · ${site.findings.join(", ")}` : ""}
                {site.claimed ? " · named where the file states its claim" : ""}
              </p>
              <ul className="space-y-1.5">
                {site.evidence.map((item) => (
                  <li key={item.ref} className="text-[11px]">
                    {item.clioUrl ? (
                      <a
                        href={item.clioUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="font-medium underline hover:text-foreground"
                      >
                        {item.title}
                      </a>
                    ) : (
                      <span className="font-medium">{item.title}</span>
                    )}
                    {item.date ? (
                      <span className="text-muted-foreground"> · {item.date}</span>
                    ) : null}
                    {item.disputed ? (
                      <span className="text-muted-foreground"> · prior or denied</span>
                    ) : null}
                    <p className="text-muted-foreground">{item.excerpt}</p>
                  </li>
                ))}
              </ul>
            </div>
          </details>
        </li>
      ))}
    </ol>
  );
}

function Legend({
  sites,
  scanned,
  withheld,
}: {
  sites: readonly InjurySite[];
  scanned?: number;
  withheld: number;
}) {
  const notes: string[] = [];
  if (typeof scanned === "number") {
    notes.push(`${sites.length} regions across ${scanned} records.`);
  }
  if (withheld > 0) {
    notes.push(`${withheld} record${withheld === 1 ? "" : "s"} withheld from this view.`);
  }
  notes.push("Keyword match over the file, not a medical opinion — check the records.");

  return (
    <footer className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-border px-4 py-3">
      <span className="flex items-center gap-2 text-[11px] text-muted-foreground">
        Mentioned
        <span
          aria-hidden
          className="h-2 w-24 rounded-full"
          style={{
            backgroundImage: `linear-gradient(to right, ${heatColor(0.1)}, ${heatColor(0.55)}, ${heatColor(1)})`,
          }}
        />
        Heavily documented
      </span>
      <span className="text-[11px] text-muted-foreground">{notes.join(" ")}</span>
    </footer>
  );
}
