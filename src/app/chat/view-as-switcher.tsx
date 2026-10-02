"use client";

/**
 * Switches the viewer between firm staff and an outside provider.
 *
 * This is a demo control over a stubbed principal, not a login. It exists so
 * the permission boundary can be shown working side by side; in the real app
 * a provider arrives on a share link and has no switch at all.
 */

import { useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";

export function ViewAsSwitcher({ matterId }: { matterId: number }) {
  const router = useRouter();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();
  const current = params.get("as") === "provider" ? "provider" : "firm";

  function change(next: string) {
    const query = new URLSearchParams(params);
    query.set("matterId", String(matterId));
    query.set("as", next);
    startTransition(() => router.push(`/chat?${query.toString()}`));
  }

  return (
    <label className="flex items-center gap-2 text-sm">
      <span className="text-muted-foreground">Viewing as</span>
      <select
        value={current}
        disabled={pending}
        onChange={(event) => change(event.target.value)}
        className="rounded border border-input bg-background px-2 py-1 text-sm disabled:opacity-60"
      >
        <option value="firm">Firm staff</option>
        <option value="provider">Outside provider</option>
      </select>
    </label>
  );
}
