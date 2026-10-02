/**
 * Serves the lawyer views.
 *
 * Each view is one self-contained HTML document in `src/views/` — the design
 * mocks from `design/`, with their sample data removed. The server fills in the
 * matter's data as JSON; the page's own script draws it. Keeping the views as
 * documents means they render exactly as designed, with no styles shared with
 * the rest of the app.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

import type { MatterView } from "./derive";

export type LawyerViewKind = "desktop" | "phone";

const TEMPLATES: Record<LawyerViewKind, string> = {
  desktop: "lawyer-desktop.html",
  phone: "lawyer-phone.html",
};

/** Where the template expects its data. */
export const DATA_SLOT = "/*__VIEW_DATA__*/null";

/**
 * JSON that is safe inside a <script> element: record text is untrusted, so
 * anything that could close the element or start a comment is escaped.
 */
export function embedJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

export function fillTemplate(template: string, view: unknown): string {
  if (!template.includes(DATA_SLOT)) throw new Error("View template has no data slot.");
  // A function replacement, so `$` sequences in record text are not interpreted.
  return template.replace(DATA_SLOT, () => embedJson(view));
}

/** Fill one of the documents in `src/views/` with its data. */
export async function renderTemplate(file: string, data: unknown): Promise<string> {
  return fillTemplate(await readFile(path.join(process.cwd(), "src", "views", file), "utf8"), data);
}

export function renderLawyerView(kind: LawyerViewKind, view: MatterView): Promise<string> {
  return renderTemplate(TEMPLATES[kind], view);
}
