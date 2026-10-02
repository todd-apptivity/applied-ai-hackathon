import Link from "next/link";
import { ClioNotConnectedError, isConnected } from "@/lib/clio/client";
import {
  REQUIRED_READ_PERMISSIONS,
  getClioConfig,
  isClioConfigured,
} from "@/lib/clio/config";
import { getCurrentUser, listMatters } from "@/lib/clio/resources";
import type { ClioMatter, ClioUser } from "@/lib/clio/types";

export const metadata = { title: "Clio connection" };

interface ConnectionState {
  configured: boolean;
  connected: boolean;
  user?: ClioUser;
  matters?: ClioMatter[];
  error?: string;
}

async function loadConnection(): Promise<ConnectionState> {
  if (!isClioConfigured()) return { configured: false, connected: false };
  if (!(await isConnected())) return { configured: true, connected: false };

  let user: ClioUser;
  try {
    user = await getCurrentUser();
  } catch (error) {
    if (error instanceof ClioNotConnectedError) {
      return { configured: true, connected: false };
    }
    return { configured: true, connected: false, error: (error as Error).message };
  }

  // The connection is live past this point. A failing matter list is a read
  // error to surface, not a reason to claim we are disconnected.
  try {
    const matters = await listMatters({ status: "Open" });
    return { configured: true, connected: true, user, matters };
  } catch (error) {
    return {
      configured: true,
      connected: true,
      user,
      error: (error as Error).message,
    };
  }
}

export default async function ClioPage({ searchParams }: PageProps<"/clio">) {
  const params = await searchParams;
  const callbackError = typeof params.clio_error === "string" ? params.clio_error : null;
  const state = await loadConnection();
  const host = state.configured ? getClioConfig().host : null;

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 overflow-y-auto px-6 py-16 font-sans">
      <h1 className="text-2xl font-semibold tracking-tight">Clio connection</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Clio is input only. This app reads matters, contacts, notes,
        communications, tasks, calendar entries, activities, and documents, and
        never calls a Clio write endpoint.
      </p>

      {callbackError && (
        <p className="mt-6 rounded border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
          Authorization failed: <code>{callbackError}</code>
        </p>
      )}

      {!state.configured && (
        <section className="mt-8 rounded border border-border bg-card px-4 py-4 text-sm">
          <p className="font-medium">Not configured.</p>
          <p className="mt-2 text-muted-foreground">
            Copy <code>.env.example</code> to <code>.env.local</code> and set{" "}
            <code>CLIO_CLIENT_ID</code> and <code>CLIO_CLIENT_SECRET</code> from
            your Clio developer app, then restart <code>next dev</code>.
          </p>
          <p className="mt-3 text-muted-foreground">
            Grant the app these permissions, read only:
          </p>
          <ul className="mt-1 list-disc pl-5 text-muted-foreground">
            {REQUIRED_READ_PERMISSIONS.map((permission) => (
              <li key={permission}>{permission}</li>
            ))}
          </ul>
        </section>
      )}

      {state.configured && !state.connected && (
        <section className="mt-8 text-sm">
          {state.error && (
            <p className="mb-4 rounded border border-amber-300 bg-amber-50 px-4 py-3 text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
              {state.error}
            </p>
          )}
          <Link
            href="/api/clio/connect"
            prefetch={false}
            className="inline-block rounded bg-primary px-4 py-2 font-medium text-primary-foreground"
          >
            Connect to Clio
          </Link>
          <p className="mt-3 text-muted-foreground">
            Region: <code>{getClioConfig().region}</code> · redirect{" "}
            <code>{getClioConfig().redirectUri}</code>
          </p>
        </section>
      )}

      {state.connected && state.user && (
        <section className="mt-8 text-sm">
          <p>
            Connected as <strong>{state.user.name}</strong>{" "}
            <span className="text-muted-foreground">({state.user.email})</span>
            {state.user.account?.name ? ` · ${state.user.account.name}` : ""}
          </p>

          {state.error && (
            <p className="mt-4 rounded border border-amber-300 bg-amber-50 px-4 py-3 text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
              Read failed: {state.error}
            </p>
          )}

          <h2 className="mt-8 text-base font-semibold">
            Open matters ({state.matters?.length ?? 0})
          </h2>
          <ul className="mt-3 divide-y divide-border">
            {state.matters?.map((matter) => (
              <li key={matter.id} className="py-3">
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="font-medium">
                    {matter.display_number ?? matter.id}
                  </span>
                  <span className="text-muted-foreground">
                    {matter.description}
                  </span>
                </div>
                <div className="mt-1 flex flex-wrap gap-3 text-xs text-muted-foreground">
                  {matter.matter_stage?.name && <span>{matter.matter_stage.name}</span>}
                  {matter.client?.name && <span>{matter.client.name}</span>}
                  <a
                    className="underline"
                    href={`/api/clio/matters/${matter.id}`}
                  >
                    raw sync payload
                  </a>
                  {host && (
                    <a
                      className="underline"
                      href={`${host}/matters/${matter.id}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      open in Clio
                    </a>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
