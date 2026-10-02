/**
 * OCR for the pages that have no text layer.
 *
 * Claude reads PDFs as images, so a scanned page needs no rasterising step and
 * no OCR engine — the page is carved into its own small PDF and transcribed.
 *
 * This is the one place in the app that is Claude-specific by design. The chat
 * path deliberately speaks the provider-agnostic AI SDK so it can run against a
 * local model; transcription of scanned legal records is not a job a small
 * local model does acceptably, so it uses the official Anthropic SDK directly.
 *
 * Page identity is never inferred from the model's output. Each request carries
 * a known number of pages and the reply must return exactly that many entries,
 * numbered by their position in the PDF it was given; the caller maps those
 * positions back to real page numbers. A reply with the wrong count is retried
 * one page at a time rather than trusted.
 */

import Anthropic from "@anthropic-ai/sdk";

import { extractPages } from "./pdf";

export interface OcrOptions {
  /** Pages per request. Smaller is more reliable and more expensive. */
  batchSize?: number;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
}

export interface OcrPage {
  page: number;
  text: string;
}

const MODEL = process.env.OCR_MODEL ?? "claude-opus-5";
const DEFAULT_BATCH = Number(process.env.OCR_BATCH_SIZE ?? 4);

const SYSTEM = [
  "You transcribe scanned pages from a legal case file.",
  "",
  "Transcribe verbatim. Preserve the reading order, headings, numbered and lettered",
  "paragraphs, table contents, dates, names, and amounts exactly as they appear.",
  "Keep court stamps, captions, docket numbers, index numbers, and signature blocks —",
  "a filing stamp's date is often the fact someone is looking for.",
  "",
  "Do not summarise, interpret, correct, or comment. Do not add anything that is not",
  "on the page. Where the scan is genuinely illegible, write [illegible] in place of",
  "the unreadable words rather than guessing. A page that is blank or carries only an",
  "image with no text gets an empty string.",
  "",
  "Return one entry per page of the PDF, in order.",
].join("\n");

/** The reply shape. `index` is 1-based within the submitted PDF, not the source. */
const SCHEMA = {
  type: "object" as const,
  properties: {
    pages: {
      type: "array" as const,
      items: {
        type: "object" as const,
        properties: {
          index: {
            type: "integer" as const,
            description: "1-based position of this page within the PDF provided.",
          },
          text: {
            type: "string" as const,
            description: "Verbatim transcription, or an empty string if the page has no text.",
          },
        },
        required: ["index", "text"],
        additionalProperties: false,
      },
    },
  },
  required: ["pages"],
  additionalProperties: false,
};

let client: Anthropic | undefined;

function anthropic(): Anthropic {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not set. OCR needs it to read scanned pages.");
  }
  client ??= new Anthropic();
  return client;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Transcribe one PDF containing `count` pages. Throws if the count is wrong. */
async function transcribe(
  pdf: Uint8Array,
  count: number,
  signal?: AbortSignal,
): Promise<string[]> {
  const response = await anthropic().messages.create(
    {
      model: MODEL,
      // Generous: a dense page runs a few thousand characters, and a short cap
      // truncates mid-page, which reads as a transcription gap rather than an error.
      max_tokens: 16_000,
      system: SYSTEM,
      // Transcription is not a reasoning task; low effort keeps it fast and cheap.
      output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
      messages: [
        {
          role: "user",
          content: [
            {
              type: "document",
              source: {
                type: "base64",
                media_type: "application/pdf",
                // Base64 must carry no newlines.
                data: Buffer.from(pdf).toString("base64"),
              },
            },
            {
              type: "text",
              text:
                `This PDF has ${count} page(s). Transcribe each one and return ` +
                `exactly ${count} entries, with index 1 through ${count}.`,
            },
          ],
        },
      ],
    },
    { signal },
  );

  if (response.stop_reason === "refusal") {
    throw new Error(
      `Transcription declined by safety classifiers (${response.stop_details?.category ?? "unknown"}).`,
    );
  }
  if (response.stop_reason === "max_tokens") {
    throw new Error("Transcription hit max_tokens and would be truncated.");
  }

  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");

  const parsed = JSON.parse(text) as { pages?: { index: number; text: string }[] };
  const pages = parsed.pages ?? [];
  if (pages.length !== count) {
    throw new Error(`Expected ${count} page(s) back, got ${pages.length}.`);
  }

  const byIndex = new Map(pages.map((page) => [page.index, page.text ?? ""]));
  return Array.from({ length: count }, (_, i) => byIndex.get(i + 1) ?? "");
}

/**
 * Transcribe `pageNumbers` out of `bytes`.
 *
 * Pages are batched for cost, then any batch whose reply does not line up is
 * retried one page at a time, where position cannot be ambiguous. A page that
 * still fails is omitted rather than stored with text that may belong to its
 * neighbour.
 */
export async function ocrPages(
  bytes: Uint8Array,
  pageNumbers: number[],
  options: OcrOptions = {},
): Promise<OcrPage[]> {
  const log = options.onProgress ?? (() => {});
  const size = Math.max(1, options.batchSize ?? DEFAULT_BATCH);
  const results: OcrPage[] = [];

  for (const batch of chunk(pageNumbers, size)) {
    const label = batch.length === 1 ? `page ${batch[0]}` : `pages ${batch[0]}-${batch.at(-1)}`;

    try {
      const pdf = await extractPages(bytes, batch);
      const texts = await transcribe(pdf, batch.length, options.signal);
      batch.forEach((page, index) => results.push({ page, text: texts[index] }));
      log(`transcribed ${label}`);
      continue;
    } catch (error) {
      if (options.signal?.aborted) throw error;
      if (batch.length === 1) {
        log(`FAILED ${label}: ${(error as Error).message}`);
        continue;
      }
      log(`${label} did not line up (${(error as Error).message}); retrying page by page`);
    }

    for (const page of batch) {
      try {
        const pdf = await extractPages(bytes, [page]);
        const [text] = await transcribe(pdf, 1, options.signal);
        results.push({ page, text });
        log(`transcribed page ${page}`);
      } catch (error) {
        if (options.signal?.aborted) throw error;
        log(`FAILED page ${page}: ${(error as Error).message}`);
      }
    }
  }

  return results.sort((a, b) => a.page - b.page);
}

export function ocrModel(): string {
  return MODEL;
}
