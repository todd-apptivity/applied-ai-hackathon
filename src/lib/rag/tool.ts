import type Anthropic from "@anthropic-ai/sdk";
import { sourceLabel } from "./chunking";
import type { RagDatabase } from "./db";
import type { Embedder } from "./embeddings";
import { searchCaseFile } from "./search";
import { isSourceType, SOURCE_TYPES, type SearchResult, type SourceType } from "./types";

export const SEARCH_CASE_FILE_TOOL_NAME = "search_case_file";

/**
 * Tool definition for a Claude chat agent. The matter is bound by the server
 * when the tool runs, never chosen by the model, so a conversation can only
 * read the matter it was opened on.
 */
export const searchCaseFileTool: Anthropic.Tool = {
  name: SEARCH_CASE_FILE_TOOL_NAME,
  description:
    "Search the current case file: Clio matter fields, contacts, notes, emails and calls, tasks, " +
    "calendar entries, expenses, and the text of every document page (including OCR'd scans). " +
    "Returns the most relevant passages, each with its source type, source id, date, and page. " +
    "Use it before answering any question about the case, and run several targeted searches " +
    "(names, dates, body parts, providers, amounts) rather than one broad one. Cite the source " +
    "of every fact you state using the source id and page from the results. If the results do " +
    "not answer the question, say so instead of guessing.",
  input_schema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "What to look for, in natural language or as key terms.",
      },
      source_types: {
        type: "array",
        items: { type: "string", enum: [...SOURCE_TYPES] },
        description: "Optional. Only search these kinds of records.",
      },
      date_from: {
        type: "string",
        description: "Optional. Earliest record date to include, YYYY-MM-DD.",
      },
      date_to: {
        type: "string",
        description: "Optional. Latest record date to include, YYYY-MM-DD.",
      },
      limit: {
        type: "integer",
        description: "Optional. Number of passages to return, 1 to 20. Default 8.",
      },
    },
    required: ["query"],
  },
};

export interface SearchCaseFileInput {
  query: string;
  source_types?: string[];
  date_from?: string;
  date_to?: string;
  limit?: number;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Validates tool input from the model. Throws with a message the model can act on. */
export function parseSearchCaseFileInput(input: unknown): SearchCaseFileInput {
  if (!input || typeof input !== "object") throw new Error("Input must be an object.");
  const value = input as Record<string, unknown>;
  if (typeof value.query !== "string" || !value.query.trim()) {
    throw new Error("query must be a non-empty string.");
  }
  const sourceTypes = value.source_types;
  if (sourceTypes !== undefined) {
    if (!Array.isArray(sourceTypes) || !sourceTypes.every((t) => typeof t === "string" && isSourceType(t))) {
      throw new Error(`source_types must be an array of: ${SOURCE_TYPES.join(", ")}.`);
    }
  }
  for (const key of ["date_from", "date_to"] as const) {
    const date = value[key];
    if (date !== undefined && (typeof date !== "string" || !DATE.test(date))) {
      throw new Error(`${key} must be a date in YYYY-MM-DD format.`);
    }
  }
  if (value.limit !== undefined && (typeof value.limit !== "number" || !Number.isFinite(value.limit))) {
    throw new Error("limit must be a number.");
  }
  return {
    query: value.query,
    source_types: sourceTypes as string[] | undefined,
    date_from: value.date_from as string | undefined,
    date_to: value.date_to as string | undefined,
    limit: value.limit as number | undefined,
  };
}

/**
 * Runs the tool for a matter and returns text for a tool_result block.
 * Throws on invalid input; callers should return the error message with
 * is_error: true so the model can correct itself.
 */
export async function runSearchCaseFile(
  db: RagDatabase,
  embedder: Embedder | undefined,
  matterId: string,
  rawInput: unknown,
): Promise<string> {
  const input = parseSearchCaseFileInput(rawInput);
  const results = await searchCaseFile(db, {
    matterId,
    query: input.query,
    limit: Math.min(input.limit ?? 8, 20),
    embedder,
    filters: {
      sourceTypes: input.source_types as SourceType[] | undefined,
      dateFrom: input.date_from,
      dateTo: input.date_to,
    },
  });
  return formatResultsForModel(results);
}

export function formatResultsForModel(results: SearchResult[]): string {
  if (results.length === 0) return "No matching passages in the case file.";
  return results
    .map((r) => {
      const attrs: Array<[string, string | number | null]> = [
        ["source_type", r.sourceType],
        ["source_id", r.sourceId],
        ["kind", sourceLabel(r.sourceType)],
        ["title", r.title],
        ["date", r.date],
        ["page", r.page],
      ];
      const attrText = attrs
        .filter(([, v]) => v !== null && v !== "")
        .map(([k, v]) => `${k}="${escapeAttr(String(v))}"`)
        .join(" ");
      return `<passage ${attrText}>\n${r.text}\n</passage>`;
    })
    .join("\n\n");
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/\n/g, " ");
}
