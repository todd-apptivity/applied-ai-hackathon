"use client";

/**
 * The window control. State lives in the URL, so the panel it drives can stay
 * a server component — see `./window` for the shared helpers.
 */

import { useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";

import { WINDOW_CHOICES, WINDOW_LABELS, type WindowChoice } from "./window";

export function WindowSelector({ choice }: { choice: WindowChoice }) {
  const router = useRouter();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();

  return (
    <select
      value={choice}
      disabled={pending}
      onChange={(event) => {
        const query = new URLSearchParams(params);
        query.set("window", event.target.value);
        startTransition(() => router.push(`?${query.toString()}`));
      }}
      className="rounded border border-input bg-background px-2 py-1 text-xs disabled:opacity-60"
    >
      {WINDOW_CHOICES.map((key) => (
        <option key={key} value={key}>
          {WINDOW_LABELS[key]}
        </option>
      ))}
    </select>
  );
}
