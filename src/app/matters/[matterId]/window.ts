/**
 * Which change window the panel is showing.
 *
 * Pure, and deliberately not in the `"use client"` selector module: the server
 * component parses the URL and the client component renders the control, so
 * both need these and a client export cannot be called from the server.
 *
 * The choice lives in the URL rather than in component state, which keeps the
 * panel a server component and makes a particular view shareable.
 */

export type WindowChoice = "checkpoint" | "7" | "30";

/**
 * Explicit order, because `Object.keys` would not give it: JS lists
 * integer-like keys ("7", "30") before string ones, which would push the
 * default choice to the bottom of the control.
 */
export const WINDOW_CHOICES: readonly WindowChoice[] = ["checkpoint", "7", "30"];

export const WINDOW_LABELS: Record<WindowChoice, string> = {
  checkpoint: "Since I last reviewed",
  "7": "Last 7 days",
  "30": "Last 30 days",
};

/** Anything unrecognised falls back to the checkpoint window. */
export function parseWindowChoice(value: string | undefined): WindowChoice {
  return value === "7" || value === "30" ? value : "checkpoint";
}
