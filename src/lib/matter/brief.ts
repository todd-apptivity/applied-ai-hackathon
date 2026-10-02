/**
 * The short brief a lawyer hears or reads when picking up a case: who, what
 * happened, what to watch, who the firm is waiting on, and what is next.
 *
 * Every line is filled in from the records and the matter's own fields. None
 * is written by a model, so there is nothing here to verify against a source
 * beyond the computed facts the views already show.
 *
 * Pure: the clock comes in through `view.today`.
 */

import type { MatterView, ViewEvent } from "./derive";

export interface BriefLine {
  label: string;
  text: string;
}

const DAY = 864e5;

const longDate = (t: number, withYear = false) =>
  new Date(t).toLocaleDateString("en-US", { month: "long", day: "numeric", ...(withYear ? { year: "numeric" } : {}) });

const count = (n: number, one: string, many: string) => `${n === 0 ? "No" : n} ${n === 1 ? one : many}`;

/** "3 years 5 months", for speech rather than for a tile. */
function duration(from: number, to: number): string {
  const months = Math.max(0, Math.round((to - from) / (30.44 * DAY)));
  if (months < 1) return `${Math.max(1, Math.round((to - from) / DAY))} days`;
  const years = Math.floor(months / 12);
  const rest = months % 12;
  const parts = [years ? `${years} year${years === 1 ? "" : "s"}` : null, rest ? `${rest} month${rest === 1 ? "" : "s"}` : null];
  return parts.filter(Boolean).join(" ");
}

const isMessage = (event: ViewEvent) => event.kind === "email" || event.kind === "call";

export function briefLines(view: Omit<MatterView, "brief">): BriefLine[] {
  const { today, events, lanes } = view;
  const c = view.case;
  const lines: BriefLine[] = [];

  const overdue = events.filter((e) => e.overdue);
  const upcoming = events.filter((e) => e.t > today);
  const withClient = events.filter((e) => isMessage(e) && e.t <= today && (e.lane === "client" || e.party === "client"));
  const lastClient = withClient[withClient.length - 1];

  // The outside party that has been sitting on unanswered firm messages longest.
  const waiting = lanes
    .filter((lane) => !["client", "firm", "file"].includes(lane.cls))
    .map((lane) => ({ lane, asks: events.filter((e) => e.open && e.party === lane.id) }))
    .filter((entry) => entry.asks.length > 0)
    .sort((a, b) => a.asks[0].t - b.asks[0].t)[0];

  const who = [c.stage ? `${c.stage} stage` : null, c.opened ? `open for ${duration(c.opened, today)}` : null].filter(Boolean).join(", ");
  lines.push({ label: "Who", text: `${c.clientName ?? view.title}.${who ? ` ${who[0].toUpperCase()}${who.slice(1)}.` : ""}` });

  const summary = c.fields.find((field) => /summary/i.test(field.name))?.value.trim();
  if (summary) lines.push({ label: "What happened", text: summary });

  const st = c.statute;
  const left = st?.date != null ? Math.round((st.date - today) / DAY) : null;
  const limitations =
    !st || st.date == null
      ? "No limitations date is recorded."
      : /complete/i.test(st.status ?? "")
        ? "The limitations task is marked complete."
        : left !== null && left < 0
          ? "The limitations date has passed and is not marked complete."
          : `${left} days remain to the limitations date.`;
  lines.push({
    label: "Watch out",
    text: `${count(overdue.length, "task is", "tasks are")} overdue${overdue.length ? `: ${overdue[0].title}` : ""}. ${limitations}`,
  });

  if (waiting) {
    lines.push({
      label: "Waiting on",
      text: `${waiting.lane.name} has not replied to ${count(waiting.asks.length, "message", "messages").toLowerCase()} since ${new Date(waiting.asks[0].t).toLocaleDateString("en-US", { month: "long", year: "numeric" })}.`,
    });
  }

  const contact = lastClient
    ? `The client was last contacted ${Math.round((today - lastClient.t) / DAY)} days ago.`
    : "There is no client contact on file.";
  const next = upcoming[0] ? `Next up: ${upcoming[0].title}, on ${longDate(upcoming[0].t)}.` : "Nothing is scheduled.";
  lines.push({ label: "Next", text: `${contact} ${next}` });

  return lines;
}
