import { NextResponse, type NextRequest } from "next/server";
import { generateText, stepCountIs } from "ai";

import { chatModel, maxToolSteps } from "@/lib/ai/model";
import { isMatterIndexed, matterLabel } from "@/lib/changes/digest";
import { caseAgentPrompt } from "@/lib/chat/prompt";
import { SEARCH_CASE_FILE, searchCaseFileTool } from "@/lib/chat/tool";
import type { Passage, SearchCaseFileResult } from "@/lib/chat/types";
import { canAccessMatter } from "@/lib/permissions/policy";
import { getPrincipal } from "@/lib/permissions/principal";
import { isVoyageConfigured } from "@/lib/rag/config";

/** Several search rounds plus the answer. */
export const maxDuration = 60;

const MAX_QUESTION = 1000;
const MAX_RECORD_TEXT = 4000;

/**
 * POST /api/matters/{matterId}/ask
 * Body: { question, record?: { ref, title, date?, text? } }
 *
 * One question about the matter, answered from the case-file index with the
 * same agent, tool, and permission checks as the chat — but as a single
 * response, for the Ask field on a record. `record` is the one the lawyer is
 * looking at; it tells the model what "this" refers to.
 */
export async function POST(
  request: NextRequest,
  context: RouteContext<"/api/matters/[matterId]/ask">,
) {
  const { matterId: raw } = await context.params;
  const matterId = Number(raw);
  if (!Number.isInteger(matterId) || matterId <= 0) {
    return NextResponse.json({ error: "invalid_matter_id" }, { status: 400 });
  }

  let body: { question?: unknown; record?: Record<string, unknown> };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "body_must_be_json" }, { status: 400 });
  }

  const question = typeof body.question === "string" ? body.question.trim().slice(0, MAX_QUESTION) : "";
  if (!question) {
    return NextResponse.json({ error: "question_required" }, { status: 400 });
  }
  if (!isVoyageConfigured()) {
    return NextResponse.json(
      { error: "voyage_not_configured", message: "Search is not configured on this server (VOYAGE_API_KEY is not set)." },
      { status: 503 },
    );
  }
  if (!isMatterIndexed(matterId)) {
    return NextResponse.json(
      { error: "matter_not_indexed", message: "This matter is not in the search index yet. Run the index build for it first." },
      { status: 409 },
    );
  }

  const principal = getPrincipal("firm", matterId);
  if (!canAccessMatter(principal, matterId)) {
    return NextResponse.json({ error: "matter_not_permitted" }, { status: 403 });
  }

  const record = body.record;
  const text = (value: unknown, max: number) => (typeof value === "string" ? value.slice(0, max) : "");
  const prompt = record
    ? [
        "The reader is looking at this record from the case file:",
        `ref: ${text(record.ref, 80)}`,
        `title: ${text(record.title, 300)}`,
        record.date ? `date: ${text(record.date, 40)}` : null,
        "",
        text(record.text, MAX_RECORD_TEXT),
        "",
        `Their question: ${question}`,
      ]
        .filter((line) => line !== null)
        .join("\n")
    : question;

  try {
    const result = await generateText({
      model: chatModel(),
      system: caseAgentPrompt(principal, matterLabel(matterId)),
      prompt,
      stopWhen: stepCountIs(maxToolSteps()),
      tools: {
        [SEARCH_CASE_FILE]: searchCaseFileTool({ principal, matterId, signal: request.signal }),
      },
      abortSignal: request.signal,
    });

    // Every passage the model was handed, once each, in the order it saw them.
    const seen = new Map<string, Passage>();
    for (const step of result.steps) {
      for (const toolResult of step.toolResults) {
        const output = toolResult.output as SearchCaseFileResult | undefined;
        for (const passage of output?.passages ?? []) {
          if (!seen.has(passage.ref)) seen.set(passage.ref, passage);
        }
      }
    }

    // Only what the answer actually cites; fall back to nothing rather than to everything.
    const cited = [...seen.values()].filter((passage) => result.text.includes(passage.ref));

    return NextResponse.json({
      answer: result.text,
      citations: cited.map((passage) => ({
        ref: passage.ref,
        title: passage.title,
        date: passage.date,
        url: passage.clioUrl,
      })),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "The question could not be answered.";
    return NextResponse.json({ error: "ask_failed", message }, { status: 500 });
  }
}
