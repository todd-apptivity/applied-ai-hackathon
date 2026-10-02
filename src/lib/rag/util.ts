import { createHash } from "node:crypto";

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Time zone used to turn Clio's UTC timestamps (calendar entries, document
 * received_at) into local calendar dates. Set per firm, not per matter.
 */
export function ragTimeZone(): string {
  return process.env.RAG_TIME_ZONE || "America/New_York";
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Normalizes a Clio date or timestamp to a local YYYY-MM-DD date.
 * Date-only values pass through unchanged; timestamps are converted from
 * their own offset (usually UTC) into the configured time zone.
 */
export function toLocalDate(
  value: string | null | undefined,
  timeZone: string = ragTimeZone(),
): string | null {
  if (!value) return null;
  if (DATE_ONLY.test(value)) return value;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(parsed);
}

/** Formats a timestamp as local "YYYY-MM-DD HH:MM" for display in chunk text. */
export function toLocalDateTime(
  value: string | null | undefined,
  timeZone: string = ragTimeZone(),
): string | null {
  if (!value) return null;
  if (DATE_ONLY.test(value)) return value;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(parsed);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
}

/** Joins "Label: value" lines, skipping empty values. */
export function labeledLines(
  fields: Array<[string, unknown]>,
): string {
  return fields
    .filter(([, value]) => value !== null && value !== undefined && value !== "")
    .map(([label, value]) => `${label}: ${String(value).trim()}`)
    .join("\n");
}
