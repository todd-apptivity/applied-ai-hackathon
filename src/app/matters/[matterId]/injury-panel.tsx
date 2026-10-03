/**
 * The injury map, wired to this matter and this viewer.
 *
 * A server component so the scan stays next to the index: it reads a few
 * hundred rows and never leaves the machine. What crosses to the browser is
 * the finished map — regions, weights, and the passages behind them — which is
 * a few kilobytes rather than the whole file.
 *
 * The principal goes in, so a provider's map is built only from records that
 * view may read. A region the provider cannot see does not get drawn faintly;
 * it is not there at all.
 */

import { InjuryBodyMap } from "@/components/case/injury-body-map";
import { currentViewer } from "@/lib/identity/current-viewer";
import { viewerToPrincipal } from "@/lib/identity/viewers";
import { injuryMap } from "@/lib/matters/injuries";
import { matterClientName } from "@/lib/matters/registry";

export function InjuryPanelFallback() {
  return (
    <section className="rounded-lg border border-border bg-card px-4 py-6 text-sm text-muted-foreground">
      Reading the file for body parts…
    </section>
  );
}

export async function InjuryPanel({ matterId }: { matterId: number }) {
  const viewer = await currentViewer();
  const map = injuryMap(viewerToPrincipal(viewer, matterId), matterId);

  return (
    <InjuryBodyMap
      sites={map.sites}
      subject={matterClientName(matterId)}
      scanned={map.scanned}
      withheld={map.withheld}
    />
  );
}
