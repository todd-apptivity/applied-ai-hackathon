"use client";

/**
 * "I have read this."
 *
 * The checkpoint also advances on its own after a session gap, so this is the
 * explicit version — for someone who is done now rather than done tomorrow.
 * It commits the baseline and starts a fresh session, so the next visit reports
 * only what arrives from here on.
 */

import { useTransition } from "react";

import { markMatterReviewed } from "./actions";

export function MarkReviewedButton({ matterId }: { matterId: number }) {
  const [pending, startTransition] = useTransition();

  return (
    <button
      type="button"
      disabled={pending}
      onClick={() => startTransition(() => markMatterReviewed(matterId))}
      className="rounded border border-input px-2 py-1 text-xs hover:bg-accent disabled:opacity-60"
      title="Commit the checkpoint now, so the next visit starts from here"
    >
      {pending ? "Marking…" : "Mark reviewed"}
    </button>
  );
}
