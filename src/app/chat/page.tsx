import Link from "next/link";

import { ChatClient } from "./chat-client";
import { ViewAsSwitcher } from "./view-as-switcher";
import { parseViewAs } from "@/lib/permissions/principal";
import { isVoyageConfigured } from "@/lib/rag/config";
import { indexStats } from "@/lib/rag/search";

export const metadata = { title: "Case chat" };

interface IndexedMatter {
  matterId: number;
  label: string;
  chunks: number;
  embedded: number;
}

/**
 * Which matters can actually be answered about. A matter with sources but no
 * embeddings is listed as unavailable rather than hidden, because "run the
 * embed step" is a more useful message than an empty picker.
 */
function loadMatters():
  | { ok: true; matters: IndexedMatter[] }
  | { ok: false; error: string } {
  try {
    const stats = indexStats();
    return {
      ok: true,
      matters: stats.matters.map((matter) => ({
        matterId: matter.matterId,
        label: matter.displayNumber
          ? `${matter.displayNumber} (matter ${matter.matterId})`
          : `Matter ${matter.matterId}`,
        chunks: matter.chunks,
        embedded: matter.embedded,
      })),
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Could not read the index.",
    };
  }
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-12 font-sans">{children}</main>
  );
}

function Setup({ children }: { children: React.ReactNode }) {
  return (
    <Shell>
      <h1 className="text-2xl font-semibold tracking-tight">Case chat</h1>
      {children}
    </Shell>
  );
}

export default async function ChatPage({ searchParams }: PageProps<"/chat">) {
  const params = await searchParams;
  const viewAs = parseViewAs(
    typeof params.as === "string" ? params.as : undefined,
  );

  if (!isVoyageConfigured()) {
    return (
      <Setup>
        <p className="mt-6 rounded border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
          <code className="font-mono">VOYAGE_API_KEY</code> is not set. The chat
          grounds every answer in retrieved passages, and retrieval needs it to
          embed the question. Add it to{" "}
          <code className="font-mono">.env.local</code> and reload.
        </p>
      </Setup>
    );
  }

  const index = loadMatters();
  if (!index.ok) {
    return (
      <Setup>
        <p className="mt-6 rounded border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
          {index.error}
        </p>
      </Setup>
    );
  }

  const answerable = index.matters.filter((matter) => matter.embedded > 0);

  if (answerable.length === 0) {
    return (
      <Setup>
        <p className="mt-6 text-sm text-muted-foreground">
          Nothing is indexed yet. Connect Clio on the{" "}
          <Link href="/clio" className="underline">
            connection page
          </Link>
          , then build the index:
        </p>
        <pre className="mt-4 overflow-x-auto rounded border border-border bg-muted px-4 py-3 font-mono text-xs">
          {"npm run rag:seed -- --matter <matter id>\nnpm run rag:embed\nnpm run rag:status"}
        </pre>
        {index.matters.length > 0 ? (
          <p className="mt-4 text-sm text-muted-foreground">
            {index.matters.length} matter
            {index.matters.length === 1 ? " is" : "s are"} synced but not
            embedded yet — run <code className="font-mono">npm run rag:embed</code>.
          </p>
        ) : null}
      </Setup>
    );
  }

  const requested = Number(
    typeof params.matterId === "string" ? params.matterId : Number.NaN,
  );
  const selected =
    answerable.find((matter) => matter.matterId === requested) ?? answerable[0];

  return (
    <div className="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col px-6 py-8 font-sans">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Case chat</h1>
          <p className="text-sm text-muted-foreground">{selected.label}</p>
        </div>
        <div className="flex items-center gap-4">
          {answerable.length > 1 ? (
            <nav className="flex flex-wrap gap-2 text-sm">
              {answerable.map((matter) => (
                <Link
                  key={matter.matterId}
                  href={`/chat?matterId=${matter.matterId}&as=${viewAs}`}
                  prefetch={false}
                  className={
                    matter.matterId === selected.matterId
                      ? "rounded bg-primary px-2 py-1 text-primary-foreground"
                      : "rounded border border-input px-2 py-1 hover:bg-accent"
                  }
                >
                  {matter.matterId}
                </Link>
              ))}
            </nav>
          ) : null}
          <ViewAsSwitcher matterId={selected.matterId} />
        </div>
      </header>

      {viewAs === "provider" ? (
        <p className="mt-4 rounded border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
          <strong className="font-semibold">Outside provider view.</strong>{" "}
          Attorney notes, internal communications, time and expenses, coverage,
          and case value are withheld before the assistant reads them. Permission
          checks here are stubbed for the demo — not a tested privacy boundary.
        </p>
      ) : (
        <p className="mt-4 text-xs text-muted-foreground">
          Every answer is grounded in retrieved passages. Expand a search to see
          its citations and open each one in Clio.
        </p>
      )}

      <div className="mt-4 flex min-h-0 flex-1 flex-col">
        <ChatClient
          key={`${selected.matterId}:${viewAs}`}
          matterId={selected.matterId}
          matterLabel={selected.label}
          viewAs={viewAs}
        />
      </div>
    </div>
  );
}
