import Link from "next/link";

export default function Home() {
  return (
    <main className="flex flex-1 flex-col overflow-y-auto font-sans">
      <section className="bg-ink px-6 py-16 text-ink-foreground">
        <div className="mx-auto w-full max-w-3xl">
          <p className="text-xs font-semibold uppercase tracking-widest text-ink-muted">
            Case dashboard
          </p>
          <h1 className="mt-3 text-4xl font-semibold leading-tight">
            A Clio matter you can read in ninety seconds.
          </h1>
          <p className="mt-4 max-w-xl text-base text-ink-muted">
            Where the case stands, what needs attention, and every record on a
            timeline by party. Read live from Clio; nothing is ever written back.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link
              href="/matters"
              className="rounded-lg bg-ink-foreground px-5 py-2.5 text-sm font-semibold text-ink"
            >
              Open a matter
            </Link>
            <Link
              href="/clio"
              className="rounded-lg border border-ink-border px-5 py-2.5 text-sm font-semibold text-ink-foreground hover:border-ink-muted"
            >
              Clio connection
            </Link>
          </div>
        </div>
      </section>

      <section className="mx-auto grid w-full max-w-3xl gap-4 px-6 py-10 sm:grid-cols-3">
        {[
          ["Case state", "Last client contact, limitations, overdue work, upcoming dates and who the firm is waiting on."],
          ["Timeline", "Every note, message, task and document on a lane for the party it belongs to."],
          ["Ask", "Questions answered from the case file, with the records each answer came from."],
        ].map(([title, text]) => (
          <div key={title} className="rounded-xl border border-border bg-card p-5">
            <h2 className="text-lg font-semibold">{title}</h2>
            <p className="mt-2 text-sm text-muted-foreground">{text}</p>
          </div>
        ))}
      </section>
    </main>
  );
}
