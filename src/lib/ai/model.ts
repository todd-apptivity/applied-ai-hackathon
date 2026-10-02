/**
 * The chat model, behind one function.
 *
 * This is the only place a provider is named. Switching the case agent to a
 * locally hosted model (Qwen on vLLM, llama.cpp, or Ollama) is an env change,
 * not a code change, because everything downstream speaks the AI SDK's
 * provider-agnostic `LanguageModel` and declares its tool from JSON Schema
 * rather than a provider-specific tool type.
 */

import { anthropic } from "@ai-sdk/anthropic";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";

export type ChatProvider = "anthropic" | "local";

export function chatProvider(): ChatProvider {
  return process.env.CHAT_PROVIDER === "local" ? "local" : "anthropic";
}

/** Model id for display, so the UI can say what answered. */
export function chatModelId(): string {
  return chatProvider() === "local"
    ? (process.env.LOCAL_LLM_MODEL ?? "qwen3")
    : (process.env.CHAT_MODEL ?? "claude-sonnet-5");
}

export function chatModel(): LanguageModel {
  if (chatProvider() === "local") {
    const baseURL = process.env.LOCAL_LLM_BASE_URL;
    if (!baseURL) {
      throw new Error(
        "CHAT_PROVIDER=local needs LOCAL_LLM_BASE_URL (the OpenAI-compatible endpoint, " +
          "e.g. http://localhost:8000/v1).",
      );
    }
    const local = createOpenAICompatible({
      name: "local",
      baseURL,
      // vLLM and llama.cpp ignore the key; Ollama wants any non-empty string.
      apiKey: process.env.LOCAL_LLM_API_KEY ?? "local",
    });
    return local(chatModelId());
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not set. Add it to .env.local.");
  }
  return anthropic(chatModelId());
}

/**
 * Whether the provider is reliable enough at multi-step tool use to let the
 * agent run several searches. Smaller local models lose the thread after a
 * couple of rounds, so they get a shorter leash.
 */
export function maxToolSteps(): number {
  const raw = Number(process.env.CHAT_MAX_STEPS);
  if (Number.isFinite(raw) && raw >= 1) return Math.floor(raw);
  return chatProvider() === "local" ? 4 : 6;
}
