/**
 * Shared types for the case-file RAG index.
 *
 * Every source (a Clio note, email, task, document page, ...) is normalized
 * into a CaseRecord before it is chunked and embedded, so the index never
 * depends on where the data came from (live Clio API or a local export).
 */

export const SOURCE_TYPES = [
  "matter",
  "custom_field",
  "contact",
  "note",
  "communication",
  "task",
  "calendar_entry",
  "expense",
  "document_page",
] as const;

export type SourceType = (typeof SOURCE_TYPES)[number];

export function isSourceType(value: string): value is SourceType {
  return (SOURCE_TYPES as readonly string[]).includes(value);
}

export interface CaseRecord {
  matterId: string;
  sourceType: SourceType;
  /** Clio id of the record. Document pages use `<documentId>#p<page>`. */
  sourceId: string;
  /** Short human label, e.g. a note subject or document name. */
  title: string;
  /** Local calendar date (YYYY-MM-DD) the record is about, when it has one. */
  date: string | null;
  /** Plain text that gets chunked and embedded. */
  text: string;
  /** 1-based page number for document pages. */
  page?: number;
  /** Clio's own updated_at, when known. Used only for display and debugging. */
  updatedAt?: string | null;
  /** Small structured extras kept for citations (participants, status, folder, ...). */
  metadata?: Record<string, unknown>;
}

/** A source document (PDF) to extract page text from. */
export interface CaseDocument {
  matterId: string;
  documentId: string;
  name: string;
  folder: string | null;
  receivedDate: string | null;
  /** Changes whenever the stored file changes (Clio version id or file hash). */
  versionKey: string;
  /** Lazily loads the file bytes; only called when the version is new. */
  load: () => Promise<Uint8Array>;
}

export interface SearchFilters {
  sourceTypes?: SourceType[];
  /** Inclusive YYYY-MM-DD bounds on the record date. */
  dateFrom?: string;
  dateTo?: string;
}

export interface SearchResult {
  chunkId: number;
  matterId: string;
  sourceType: SourceType;
  sourceId: string;
  title: string;
  date: string | null;
  page: number | null;
  text: string;
  metadata: Record<string, unknown>;
  /** Reciprocal-rank-fusion score; higher is better. */
  score: number;
  /** Which retrievers matched this chunk. */
  matchedBy: Array<"vector" | "keyword">;
}
