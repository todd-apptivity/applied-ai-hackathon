"use client";

/**
 * The case chat as a floating widget: a button in the corner that opens the
 * same grounded chat the standalone page uses, over the case view.
 *
 * Hidden on a phone-width window, where the case view has its own Ask tab and
 * a floating button would sit on top of its tab bar.
 */

import { MessageCircle, X } from "lucide-react";
import { useState } from "react";

import { CaseChatPanel } from "../case-chat-panel";

export function FloatingChat({
  matterId,
  matterLabel,
  viewAs,
}: {
  matterId: number;
  matterLabel: string;
  viewAs: "firm" | "provider";
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="hidden md:block">
      {/* Kept mounted while closed, so the conversation survives closing the panel. */}
      <section
        aria-label="Ask the case file"
        hidden={!open}
        className="fixed bottom-24 right-6 z-40 flex h-[min(70vh,40rem)] w-[26rem] flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-2xl"
      >
        <header className="flex shrink-0 items-center justify-between gap-3 bg-ink px-4 py-3 text-ink-foreground">
          <div className="min-w-0">
            <h2 className="truncate text-base font-semibold">Ask the case file</h2>
            <p className="truncate text-xs text-ink-muted">{matterLabel} · answers cite their records</p>
          </div>
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="Close chat"
            className="rounded-full p-1.5 text-ink-muted hover:text-ink-foreground"
          >
            <X className="size-4" />
          </button>
        </header>
        <div className="flex min-h-0 flex-1 flex-col p-2">
          <CaseChatPanel matterId={matterId} matterLabel={matterLabel} viewAs={viewAs} />
        </div>
      </section>

      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-label={open ? "Close chat" : "Ask the case file"}
        className="fixed bottom-6 right-6 z-40 flex size-14 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-xl hover:brightness-110"
      >
        {open ? <X className="size-6" /> : <MessageCircle className="size-6" />}
      </button>
    </div>
  );
}
