import { NextResponse, type NextRequest } from "next/server";
import { convertToModelMessages, stepCountIs, streamText, type UIMessage } from "ai";

import { chatModel, maxToolSteps } from "@/lib/ai/model";
import { caseAgentPrompt } from "@/lib/chat/prompt";
import { SEARCH_CASE_FILE, searchCaseFileTool } from "@/lib/chat/tool";
import { getPrincipal, parseViewAs } from "@/lib/permissions/principal";
import { canAccessMatter } from "@/lib/permissions/policy";
import { isVoyageConfigured } from "@/lib/rag/config";

/** Several tool rounds plus a long answer; the default 15s is not enough. */
export const maxDuration = 60;

/**
 * POST /api/chat
 * Body: { messages, matterId, matterLabel?, viewAs? }
 *
 * The case agent. Answers only from passages the retrieval index returns, and
 * only from the slice of the index the viewer is permitted to read — the
 * filtering happens inside the tool, before the model sees anything.
 */
export async function POST(request: NextRequest) {
  let body: {
    messages?: UIMessage[];
    matterId?: unknown;
    matterLabel?: unknown;
    viewAs?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "body_must_be_json" }, { status: 400 });
  }

  const matterId = Number(body.matterId);
  if (!Number.isInteger(matterId) || matterId <= 0) {
    return NextResponse.json({ error: "invalid_matter_id" }, { status: 400 });
  }
  if (!Array.isArray(body.messages)) {
    return NextResponse.json({ error: "messages_required" }, { status: 400 });
  }
  if (!isVoyageConfigured()) {
    return NextResponse.json(
      { error: "voyage_not_configured" },
      { status: 503 },
    );
  }

  const viewAs = parseViewAs(
    request.headers.get("x-ninety-view-as") ?? body.viewAs,
  );
  const principal = getPrincipal(viewAs, matterId);
  if (!canAccessMatter(principal, matterId)) {
    return NextResponse.json({ error: "matter_not_permitted" }, { status: 403 });
  }

  const matterLabel =
    typeof body.matterLabel === "string" && body.matterLabel.trim()
      ? body.matterLabel.trim()
      : `matter ${matterId}`;

  try {
    const result = streamText({
      model: chatModel(),
      system: caseAgentPrompt(principal, matterLabel),
      messages: await convertToModelMessages(body.messages),
      stopWhen: stepCountIs(maxToolSteps()),
      tools: {
        [SEARCH_CASE_FILE]: searchCaseFileTool({
          principal,
          matterId,
          signal: request.signal,
        }),
      },
      abortSignal: request.signal,
    });

    return result.toUIMessageStreamResponse();
  } catch (error) {
    // Thrown synchronously by chatModel() when the provider is misconfigured.
    const message = error instanceof Error ? error.message : "Chat failed.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
