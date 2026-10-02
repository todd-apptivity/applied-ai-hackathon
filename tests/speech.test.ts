/**
 * The speech layer, with a fake engine: no audio program is needed to test
 * what gets spoken or that a line is only synthesized once.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { MAX_SPEECH_CHARS, SpeechUnavailableError, speakable, speechEngine, synthesize, type SpeechEngine } from "../src/lib/speech/engine";

function fake(name: string) {
  const calls: string[] = [];
  const engine: SpeechEngine = { name, synthesize: async (text) => { calls.push(text); return Buffer.from(`wav:${text}`); } };
  return { engine, calls };
}

describe("speech", () => {
  it("speaks one bounded line of plain text", () => {
    assert.equal(speakable("  Two\n lines\tof   text "), "Two lines of text");
    assert.equal(speakable("x".repeat(5000)).length, MAX_SPEECH_CHARS);
  });

  it("synthesizes a line once and reuses it", async () => {
    const { engine, calls } = fake("fake-once");
    const first = await synthesize("The same line.", engine);
    const second = await synthesize("  The same   line. ", engine);
    assert.equal(first, second);
    assert.deepEqual(calls, ["The same line."]);
  });

  it("keeps engines apart in the cache", async () => {
    const a = fake("fake-a"), b = fake("fake-b");
    await synthesize("Shared words.", a.engine);
    await synthesize("Shared words.", b.engine);
    assert.equal(b.calls.length, 1);
  });

  it("refuses empty text and an unknown engine", async () => {
    await assert.rejects(() => synthesize("   ", fake("fake-empty").engine));
    assert.throws(() => speechEngine("not-an-engine"), SpeechUnavailableError);
  });
});
