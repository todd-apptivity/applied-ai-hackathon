"use client";

/**
 * Switches which viewer the dashboard is rendered for.
 *
 * Not a login. It exists so the permission boundary can be demonstrated side
 * by side, and because "since the last time *I* reviewed it" needs an "I" you
 * can change to see the difference. In the real app a provider arrives on a
 * share link and has no switch at all.
 *
 * Unlike the chat page's `?as=` version this writes a cookie, so the viewer —
 * and so the review checkpoint — survives a reload.
 */

import { useTransition } from "react";

import { setViewerCookie } from "@/app/matters/[matterId]/actions";

export interface ViewerOption {
  id: string;
  name: string;
  role: "firm" | "provider";
}

export function ViewerSwitcher({
  viewers,
  currentId,
  matterId,
}: {
  viewers: ViewerOption[];
  currentId: string;
  /** Omitted on the matter list, which has no one matter to revalidate. */
  matterId?: number;
}) {
  const [pending, startTransition] = useTransition();

  return (
    <label className="flex items-center gap-2 text-sm">
      <span className="text-muted-foreground">Viewing as</span>
      <select
        value={currentId}
        disabled={pending || viewers.length < 2}
        onChange={(event) => {
          const next = event.target.value;
          startTransition(() => setViewerCookie(next, matterId));
        }}
        className="rounded border border-input bg-background px-2 py-1 text-sm disabled:opacity-60"
      >
        {viewers.map((viewer) => (
          <option key={viewer.id} value={viewer.id}>
            {viewer.name}
            {viewer.role === "provider" ? " — outside the firm" : ""}
          </option>
        ))}
      </select>
    </label>
  );
}
