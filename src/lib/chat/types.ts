/**
 * The wire shape between the chat tool and the chat UI.
 *
 * Types and pure helpers only. The browser bundle imports this, so it must not
 * reach anything that touches `node:sqlite`, the filesystem, or the Clio
 * client — which is why a passage arrives with its Clio URL already built
 * server-side rather than with the ingredients to build one.
 */

/** Mirrors `SourceKind` in `@/lib/rag/sources`, restated to keep this a leaf. */
export const KIND_LABELS: Record<string, string> = {
  matter: "Matter",
  custom_field: "Matter field",
  contact: "Contact",
  note: "Note",
  communication: "Communication",
  task: "Task",
  calendar_entry: "Calendar entry",
  activity: "Time or expense",
  document: "Document",
  document_page: "Document page",
};

export function kindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? kind;
}

export interface Passage {
  /**
   * Stable citation key the model writes into its prose, e.g. `note:4821` or
   * `document_page:9912#p47`. Built from Clio's own ids so the same passage
   * gets the same ref across searches and across turns.
   */
  ref: string;
  kind: string;
  title: string;
  /** The record's own date (YYYY-MM-DD), not when Clio last touched it. */
  date: string | null;
  /** 1-based page for document pages, null otherwise. */
  page: number | null;
  text: string;
  /** Deep link into Clio, or null when the kind has no addressable page. */
  clioUrl: string | null;
}

/** What `search_case_file` returns — to the model and to the UI alike. */
export interface SearchCaseFileResult {
  query: string;
  passages: Passage[];
  /**
   * How many passages the permission layer removed before the model saw
   * anything. A count and a topic list, never the content.
   */
  withheld: { count: number; topics: string[] };
  /** Present so the UI can say the answer is narrowed, not complete. */
  scope: "firm" | "provider";
}

export interface SearchCaseFileInput {
  query: string;
  kinds?: string[];
  limit?: number;
}

/** `document_page:9912#p47` — page folded into the ref so it stays unique. */
export function passageRef(kind: string, clioId: string, page: number | null): string {
  return page && page > 0 ? `${kind}:${clioId}#p${page}` : `${kind}:${clioId}`;
}

/** Human label for a citation chip: "Document page · p.47 · 2023-07-26". */
export function passageLabel(passage: Passage): string {
  const parts = [kindLabel(passage.kind)];
  if (passage.page) parts.push(`p.${passage.page}`);
  if (passage.date) parts.push(passage.date);
  return parts.join(" · ");
}
