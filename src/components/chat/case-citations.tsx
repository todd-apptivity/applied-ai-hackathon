"use client";

/**
 * Renders a `search_case_file` call as its citations.
 *
 * This is the visible half of grounding: the reader can see exactly which
 * passages the answer was built from, open each one in Clio, and see when the
 * permission layer held something back. It is wired into the thread's
 * `ToolFallback` slot rather than registered by name, because the case agent
 * has exactly one tool.
 */

import { useState } from "react";
import type { ToolCallMessagePartComponent } from "@assistant-ui/react";
import { ChevronDown, ExternalLink, EyeOff, Search } from "lucide-react";

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  passageLabel,
  type Passage,
  type SearchCaseFileInput,
  type SearchCaseFileResult,
} from "@/lib/chat/types";
import { cn } from "@/lib/utils";

/** Deny topics, phrased for a reader rather than for code. */
const TOPIC_LABELS: Record<string, string> = {
  coverage_amounts: "insurance coverage",
  case_value: "case value",
  liability_analysis: "liability analysis",
  credibility_or_prior_injury: "credibility or prior injuries",
  other_providers: "other providers",
  attorney_notes: "attorney notes",
  client_identifiers: "client identifiers",
};

function PassageCard({ passage }: { passage: Passage }) {
  return (
    <li className="rounded-md border border-border bg-background px-3 py-2">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-xs font-medium text-muted-foreground">
          {passageLabel(passage)}
        </span>
        {passage.clioUrl ? (
          <a
            href={passage.clioUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground underline hover:text-foreground"
          >
            Open in Clio
            <ExternalLink className="size-3" aria-hidden />
          </a>
        ) : null}
      </div>

      <p className="mt-0.5 text-sm font-medium">{passage.title}</p>
      <p className="mt-1 line-clamp-4 text-sm whitespace-pre-wrap text-muted-foreground">
        {passage.text}
      </p>
      <code className="mt-2 inline-block rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
        {passage.ref}
      </code>
    </li>
  );
}

export const CaseCitations: ToolCallMessagePartComponent<
  SearchCaseFileInput,
  SearchCaseFileResult
> = ({ args, result, isError, status }) => {
  const [open, setOpen] = useState(false);
  const query = args?.query;
  const running = status.type === "running" || (!result && !isError);

  if (isError) {
    return (
      <div className="my-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
        Case-file search failed{query ? ` for “${query}”` : ""}. The answer below
        is not grounded — retry before relying on it.
      </div>
    );
  }

  if (running) {
    return (
      <div className="my-2 flex items-center gap-2 px-1 text-sm text-muted-foreground">
        <Search className="size-3.5 animate-pulse" aria-hidden />
        <span>Searching the case file{query ? <> for “{query}”</> : null}…</span>
      </div>
    );
  }

  const passages = result?.passages ?? [];
  const withheld = result?.withheld;
  const count = passages.length;

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="my-2">
      <CollapsibleTrigger
        className={cn(
          "flex w-full items-center gap-2 rounded-md px-1 py-1 text-left text-sm",
          "text-muted-foreground hover:text-foreground",
        )}
      >
        <Search className="size-3.5 shrink-0" aria-hidden />
        <span className="min-w-0 flex-1 truncate">
          {count > 0 ? (
            <>
              {count} passage{count === 1 ? "" : "s"}
            </>
          ) : (
            <>No passages</>
          )}
          {query ? <> for “{query}”</> : null}
        </span>
        <ChevronDown
          className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-180")}
          aria-hidden
        />
      </CollapsibleTrigger>

      <CollapsibleContent className="overflow-hidden">
        <div className="space-y-2 pt-2">
          {count === 0 ? (
            <p className="px-1 text-sm text-muted-foreground">
              Nothing in the indexed file matched this search.
            </p>
          ) : (
            <ul className="space-y-2">
              {passages.map((passage) => (
                <PassageCard key={passage.ref} passage={passage} />
              ))}
            </ul>
          )}

          {withheld && withheld.count > 0 ? (
            <p className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
              <EyeOff className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              <span>
                {withheld.count} passage{withheld.count === 1 ? "" : "s"} withheld
                from this view before the assistant saw them
                {withheld.topics.length > 0 ? (
                  <>
                    {" "}
                    (
                    {withheld.topics
                      .map((topic) => TOPIC_LABELS[topic] ?? topic)
                      .join(", ")}
                    )
                  </>
                ) : null}
                .
              </span>
            </p>
          ) : null}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
};
