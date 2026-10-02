/**
 * The one tool the case agent gets.
 *
 * Declared from a plain JSON Schema rather than a provider-specific tool type,
 * so the same definition works against Claude or a locally hosted model. The
 * matter and the principal are bound by the server when the tool is built, not
 * chosen by the model — a conversation can only read the matter it was opened
 * on, as the viewer it was opened as.
 */

import { jsonSchema, tool } from "ai";

import { searchForPrincipal } from "@/lib/permissions/guard";
import { PermissionError, type Principal } from "@/lib/permissions/types";
import { allowedKinds } from "@/lib/permissions/policy";

import type { SearchCaseFileResult } from "./types";

export const SEARCH_CASE_FILE = "search_case_file";

const DESCRIPTION =
  "Search this case file: matter fields, contacts, notes, emails and calls, tasks, " +
  "calendar entries, time and expense entries, and the text of every document page. " +
  "Returns the most relevant passages, each with a citation ref, date, and page. " +
  "Search before answering any question about the case, and run several targeted " +
  "searches (names, dates, body parts, providers, amounts) rather than one broad one. " +
  "Results are already scoped to what the current viewer is allowed to see.";

/**
 * Build the tool for one conversation. `kinds` is enumerated from the
 * principal's own allowance so the model is told what it can ask for instead
 * of guessing and being silently filtered.
 */
export function searchCaseFileTool(params: {
  principal: Principal;
  matterId: number;
  signal?: AbortSignal;
}) {
  const kinds = allowedKinds(params.principal);

  return tool({
    description: DESCRIPTION,
    inputSchema: jsonSchema<{ query: string; kinds?: string[]; limit?: number }>({
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "What to look for, in natural language or as key terms.",
        },
        kinds: {
          type: "array",
          items: { type: "string", enum: kinds },
          description: "Optional. Only search these kinds of records.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 20,
          description: "Optional. Number of passages to return, 1 to 20. Default 8.",
        },
      },
      required: ["query"],
      additionalProperties: false,
    }),
    execute: async ({ query, kinds: requested, limit }): Promise<SearchCaseFileResult> => {
      try {
        return await searchForPrincipal({
          principal: params.principal,
          matterId: params.matterId,
          query,
          kinds: requested,
          limit,
          signal: params.signal,
        });
      } catch (error) {
        // A permission failure is a fact the model should state, not a crash.
        // Anything else is a real failure and should surface as a tool error.
        if (error instanceof PermissionError) {
          return {
            query,
            passages: [],
            withheld: { count: 0, topics: [] },
            scope: params.principal.kind === "firm" ? "firm" : "provider",
          };
        }
        throw error;
      }
    },
  });
}
