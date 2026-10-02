import Link from "next/link";

import { ClioNotConnectedError } from "@/lib/clio/client";
import { loadProviderDirectory, type ProviderDirectoryEntry } from "@/lib/matter/provider-view";

export const metadata = { title: "Providers" };

/**
 * The firm's way in to the provider pages: every treating provider on an open
 * case, with a link to the page that provider would see.
 *
 * A provider never sees this list. Their own page is /provider/{id}, which
 * carries none of the firm's navigation.
 */
export default async function ProvidersPage() {
  let providers: ProviderDirectoryEntry[] = [];
  let problem: string | null = null;

  try {
    providers = await loadProviderDirectory();
  } catch (error) {
    problem =
      error instanceof ClioNotConnectedError
        ? "Clio is not connected."
        : error instanceof Error
          ? error.message
          : "The providers could not be read from Clio.";
  }

  return (
    <main className="mx-auto w-full max-w-4xl flex-1 overflow-y-auto px-6 py-8 font-sans">
      <h1 className="text-xl font-semibold tracking-tight">Providers</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Treating providers on open cases. Each link opens the page that provider would see:
        only their own requests, messages and visits, and the stage of the case.
      </p>

      {problem ? (
        <p className="mt-6 rounded border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          {problem}{" "}
          <Link href="/clio" className="underline">
            Clio connection
          </Link>
        </p>
      ) : providers.length === 0 ? (
        <p className="mt-6 text-sm text-muted-foreground">No open case has a treating provider.</p>
      ) : (
        <ul className="mt-6 divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
          {providers.map((provider) => (
            <li key={provider.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
              <div className="min-w-0">
                {/* Plain anchors: the provider pages are their own documents. */}
                <a href={`/provider/${provider.id}`} className="font-serif text-lg font-semibold hover:underline">
                  {provider.name}
                </a>
                <p className="text-sm text-muted-foreground">{provider.role ?? "Treating provider"}</p>
              </div>
              <div className="flex flex-wrap gap-2 text-sm">
                {provider.matters.map((matter) => (
                  <a
                    key={matter.matterId}
                    href={`/provider/${provider.id}/cases/${matter.matterId}`}
                    className="rounded-full border border-border px-3 py-1 text-muted-foreground hover:border-primary hover:text-primary"
                  >
                    {matter.label}
                  </a>
                ))}
              </div>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
