import { NextResponse, type NextRequest } from "next/server";

import { MAX_SPEECH_CHARS, SpeechUnavailableError, synthesize } from "@/lib/speech/engine";

/**
 * POST /api/speech
 * Body: { text }
 *
 * Speaks one line of the case brief and returns it as WAV audio. The voice is
 * produced on this server; the text goes nowhere else. The views fall back to
 * the browser's own voice when this answers 503.
 */
export async function POST(request: NextRequest) {
  let body: { text?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "body_must_be_json" }, { status: 400 });
  }

  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text) return NextResponse.json({ error: "text_required" }, { status: 400 });
  if (text.length > MAX_SPEECH_CHARS) {
    return NextResponse.json({ error: "text_too_long", max: MAX_SPEECH_CHARS }, { status: 413 });
  }

  try {
    const audio = await synthesize(text);
    return new Response(new Uint8Array(audio), {
      headers: {
        "content-type": "audio/wav",
        "content-length": String(audio.length),
        // Spoken case text: not for a shared cache.
        "cache-control": "private, no-store",
      },
    });
  } catch (error) {
    if (error instanceof SpeechUnavailableError) {
      return NextResponse.json({ error: "speech_unavailable", message: error.message }, { status: 503 });
    }
    console.error("Speech synthesis failed", error);
    return NextResponse.json({ error: "speech_failed" }, { status: 500 });
  }
}
