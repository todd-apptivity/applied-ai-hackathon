"use client";

/**
 * A citation chip, and the change card behind it.
 *
 * Refs come from Clio's own ids, so a chip here and a chip in the chat
 * transcript name the same record and open the same page. The chip carries the
 * ref visibly on purpose: a reader who wants to check a sentence should be able
 * to find the record it came from without trusting the prose about it.
 */

import { ExternalLink } from "lucide-react";

import { kindLabel } from "@/lib/chat/types";
import { eventLabel, type ChangeEvent } from "@/lib/changes/types";

export interface CitationInfo {
  ref: string;
  label: string;
  clioUrl: string | null;
}

export function CitationChip({ citation }: { citation: CitationInfo }) {
  const content = (
    <>
      <code className="font-mono text-[11px]">{citation.ref}</code>
      {citation.clioUrl ? <ExternalLink className="size-3" aria-hidden /> : null}
    </>
  );

  const className =
    "inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 align-middle text-[11px] text-muted-foreground";

  return citation.clioUrl ? (
    <a
      href={citation.clioUrl}
      target="_blank"
      rel="noreferrer"
      title={`${citation.label} — open in Clio`}
      className={`${className} underline hover:text-foreground`}
    >
      {content}
    </a>
  ) : (
    <span title={citation.label} className={className}>
      {content}
    </span>
  );
}

function day(iso: string | null): string | null {
  return iso ? iso.slice(0, 10) : null;
}

export function ChangeCard({ event }: { event: ChangeEvent }) {
  const happened = day(event.occurredAt);
  const learned = day(event.observedAt);

  return (
    <li className="rounded-md border border-border bg-background px-3 py-2">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-xs font-medium text-muted-foreground">
          {eventLabel(event.type)} · {kindLabel(event.kind)}
          {event.page ? ` · p.${event.page}` : ""}
        </span>
        {event.clioUrl ? (
          <a
            href={event.clioUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground underline hover:text-foreground"
          >
            Open in Clio
            <ExternalLink className="size-3" aria-hidden />
          </a>
        ) : null}
      </div>

      <p className="mt-0.5 text-sm font-medium">{event.title}</p>

      {event.deltas.length > 0 ? (
        <ul className="mt-1 space-y-0.5 text-sm text-muted-foreground">
          {event.deltas.map((delta) => (
            <li key={delta.field}>
              <span className="font-medium">{delta.field}</span>:{" "}
              {delta.from ?? "(none)"} → {delta.to ?? "(none)"}
            </li>
          ))}
        </ul>
      ) : null}

      <p className="mt-1 text-xs text-muted-foreground">
        {/* The distinction a digest has to keep straight: an old record added
            today is not news from its own date. */}
        {event.backdated && happened && learned
          ? `Dated ${happened}, added to the file ${learned}`
          : happened
            ? `${happened}`
            : learned
              ? `Seen ${learned}`
              : null}
      </p>

      <code className="mt-2 inline-block rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
        {event.ref}
      </code>
    </li>
  );
}
