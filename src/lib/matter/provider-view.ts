/**
 * Loads what a provider may see, through the same source adapter the lawyer
 * views use, and serves the provider documents in `src/views/`.
 */

import { NextResponse } from "next/server";

import { ClioNotConnectedError } from "@/lib/clio/client";
import { listMatters } from "@/lib/clio/resources";

import { ProviderNotOnMatterError, deriveProviderView, listProviders, type ProviderCaseView } from "./provider";
import { renderTemplate } from "./render";
import { viewErrorPage } from "./respond";
import { retryOnNetworkFailure } from "./retry";
import { matterSource } from "./source";

/** A provider's cases are looked for among this many open matters at most. */
const MAX_MATTERS = 20;

export async function loadProviderCase(matterId: number, providerId: string): Promise<ProviderCaseView> {
  const records = await matterSource().load(matterId);
  return deriveProviderView(records, providerId, { now: new Date() });
}

export interface ProviderHomeView {
  today: number;
  provider: { id: string; name: string; role: string | null };
  cases: ProviderCaseView[];
}

/** Every open matter this contact is a treating provider on. */
export async function loadProviderHome(providerId: string): Promise<ProviderHomeView | null> {
  const now = new Date();
  const matters = (await retryOnNetworkFailure(() => listMatters({ status: "Open" }))).slice(0, MAX_MATTERS);
  const cases: ProviderCaseView[] = [];

  for (const matter of matters) {
    try {
      cases.push(deriveProviderView(await matterSource().load(matter.id), providerId, { now }));
    } catch (error) {
      // Not on this matter: it is simply not one of their cases.
      if (!(error instanceof ProviderNotOnMatterError)) throw error;
    }
  }

  if (cases.length === 0) return null;
  return { today: now.getTime(), provider: cases[0].provider, cases };
}

export interface ProviderDirectoryEntry {
  id: string;
  name: string;
  role: string | null;
  matters: Array<{ matterId: number; label: string }>;
}

/** Firm-side: every treating provider across the open matters, to preview their pages. */
export async function loadProviderDirectory(): Promise<ProviderDirectoryEntry[]> {
  const matters = (await retryOnNetworkFailure(() => listMatters({ status: "Open" }))).slice(0, MAX_MATTERS);
  const byId = new Map<string, ProviderDirectoryEntry>();

  for (const matter of matters) {
    const label = matter.display_number ?? matter.description ?? `Matter ${matter.id}`;
    for (const provider of listProviders(await matterSource().load(matter.id))) {
      const entry = byId.get(provider.id) ?? { ...provider, matters: [] };
      entry.matters.push({ matterId: matter.id, label });
      byId.set(provider.id, entry);
    }
  }

  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
}

const HTML = { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" };

function failure(error: unknown, request: Request) {
  if (error instanceof ProviderNotOnMatterError) {
    return NextResponse.json({ error: "not_a_provider_on_this_matter" }, { status: 404 });
  }
  if (error instanceof ClioNotConnectedError) {
    return NextResponse.redirect(new URL("/clio", request.url));
  }
  return viewErrorPage(error);
}

export async function providerCaseResponse(providerId: string, matterId: string, request: Request) {
  const id = Number(matterId);
  if (!Number.isInteger(id) || id <= 0 || !/^\d+$/.test(providerId)) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }
  try {
    return new Response(await renderTemplate("provider-case.html", await loadProviderCase(id, providerId)), { headers: HTML });
  } catch (error) {
    return failure(error, request);
  }
}

export async function providerHomeResponse(providerId: string, request: Request) {
  if (!/^\d+$/.test(providerId)) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }
  try {
    const home = await loadProviderHome(providerId);
    if (!home) return NextResponse.json({ error: "no_shared_cases" }, { status: 404 });
    return new Response(await renderTemplate("provider-home.html", home), { headers: HTML });
  } catch (error) {
    return failure(error, request);
  }
}
