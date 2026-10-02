/**
 * Text to speech for the case brief.
 *
 * Synthesis runs on this machine, with a speech program installed locally, so
 * case text is never sent to a third-party voice service. The engine sits
 * behind an interface: a hosted voice would be one more adapter, chosen with
 * SPEECH_ENGINE, and nothing that calls `speechEngine()` would change.
 */

import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Long enough for a brief line, short enough that this is not a general service. */
export const MAX_SPEECH_CHARS = 800;

export interface SpeechEngine {
  readonly name: string;
  /** WAV audio of the text being spoken. */
  synthesize(text: string): Promise<Buffer>;
}

export class SpeechUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpeechUnavailableError";
  }
}

/** Text is always passed as an argument, never through a shell. */
async function tool(command: string, args: string[], options: { encoding?: "buffer" } = {}) {
  try {
    return await run(command, args, { timeout: 20_000, maxBuffer: 32 * 1024 * 1024, ...options });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new SpeechUnavailableError(`The speech program "${command}" is not installed on this server.`);
    }
    throw error;
  }
}

/** CMU Flite. Writes to a file, so each call uses its own temporary one. */
export class FliteEngine implements SpeechEngine {
  readonly name = "flite";
  constructor(private readonly voice = process.env.SPEECH_VOICE ?? "slt") {}

  async synthesize(text: string): Promise<Buffer> {
    const out = path.join(tmpdir(), `ninety-speech-${randomUUID()}.wav`);
    try {
      await tool("flite", ["-voice", this.voice, "-t", text, "-o", out]);
      return await readFile(out);
    } finally {
      await unlink(out).catch(() => {});
    }
  }
}

/** eSpeak NG. Writes WAV to standard output. */
export class EspeakEngine implements SpeechEngine {
  readonly name = "espeak";
  constructor(private readonly voice = process.env.SPEECH_VOICE ?? "en-us") {}

  async synthesize(text: string): Promise<Buffer> {
    const { stdout } = await tool("espeak-ng", ["--stdout", "-v", this.voice, "-s", "165", text], { encoding: "buffer" });
    return stdout as unknown as Buffer;
  }
}

const ENGINES: Record<string, () => SpeechEngine> = {
  flite: () => new FliteEngine(),
  espeak: () => new EspeakEngine(),
};

export function speechEngine(name: string = process.env.SPEECH_ENGINE ?? "flite"): SpeechEngine {
  const make = ENGINES[name];
  if (!make) throw new SpeechUnavailableError(`Unknown SPEECH_ENGINE "${name}". Available: ${Object.keys(ENGINES).join(", ")}.`);
  return make();
}

/** What gets spoken: plain text, one line, bounded. */
export function speakable(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, MAX_SPEECH_CHARS);
}

// The same line is asked for on every play, so keep the last few clips.
const cache = new Map<string, Buffer>();
const CACHE_SIZE = 64;

export async function synthesize(text: string, engine: SpeechEngine = speechEngine()): Promise<Buffer> {
  const spoken = speakable(text);
  if (!spoken) throw new Error("Nothing to say.");
  const key = createHash("sha256").update(`${engine.name}\n${spoken}`).digest("hex");

  const hit = cache.get(key);
  if (hit) return hit;

  const audio = await engine.synthesize(spoken);
  cache.set(key, audio);
  if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value as string);
  return audio;
}
