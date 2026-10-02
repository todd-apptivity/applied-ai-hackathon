import Anthropic from "@anthropic-ai/sdk";
import { PDFDocument } from "pdf-lib";

/**
 * Transcribes the given 1-based pages of a PDF. Returns page -> text for the
 * pages it could read. Pages it could not read are left out.
 */
export type OcrFn = (pdf: Uint8Array, pages: number[]) => Promise<Map<number, string>>;

export interface ClaudeOcrOptions {
  client?: Anthropic;
  model?: string;
  /** Pages sent per request. Small batches keep transcription faithful. */
  pagesPerRequest?: number;
  /** Requests in flight at once. */
  concurrency?: number;
  onProgress?: (done: number, total: number) => void;
}

const OCR_INSTRUCTIONS = `Transcribe every page of the attached PDF.

Rules:
- Reproduce the text exactly as written, in reading order. Do not summarize, correct, or add commentary.
- Keep dates, numbers, names, codes, and units exactly as they appear.
- Render tables as rows of text with " | " between cells.
- For handwriting or marks you cannot read, write [illegible].
- For a page with no text, write [blank page].
- Replace government-issued identification numbers (driver's license, passport, Social Security) with [REDACTED ID NUMBER].
- Start each page with a line of the form === PAGE n === where n is the page's position in this file, starting at 1.`;

/**
 * OCR using Claude's PDF support. Scanned pages are split into small PDFs
 * with pdf-lib and sent as base64 document blocks.
 */
export function createClaudeOcr(options: ClaudeOcrOptions = {}): OcrFn {
  const client = options.client ?? new Anthropic();
  const model = options.model ?? process.env.RAG_OCR_MODEL ?? "claude-opus-5-5";
  const pagesPerRequest = options.pagesPerRequest ?? 4;
  const concurrency = options.concurrency ?? 4;

  return async (pdfBytes, pages) => {
    const source = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
    const batches: number[][] = [];
    for (let i = 0; i < pages.length; i += pagesPerRequest) {
      batches.push(pages.slice(i, i + pagesPerRequest));
    }

    const results = new Map<number, string>();
    let done = 0;
    await runPool(batches, concurrency, async (batch) => {
      try {
        await transcribeBatch(batch);
      } catch (error) {
        // One failed request should not lose the rest of the document.
        console.warn(`OCR failed for pages ${batch.join(", ")}:`, error);
      }
      done += 1;
      options.onProgress?.(done, batches.length);
    });
    return results;

    async function transcribeBatch(batch: number[]): Promise<void> {
      const slice = await PDFDocument.create();
      const copied = await slice.copyPages(source, batch.map((p) => p - 1));
      copied.forEach((page) => slice.addPage(page));
      const data = Buffer.from(await slice.save()).toString("base64");

      const message = await client.beta.messages
        .stream({
          model,
          max_tokens: 32000,
          output_config: { effort: "low" },
          // Medical records can trip safety classifiers; fall back instead of
          // dropping the pages.
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "document",
                  source: { type: "base64", media_type: "application/pdf", data },
                },
                { type: "text", text: OCR_INSTRUCTIONS },
              ],
            },
          ],
        })
        .finalMessage();

      if (message.stop_reason === "refusal") {
        console.warn(`OCR declined for pages ${batch.join(", ")}; leaving them unindexed.`);
      } else {
        const text = message.content
          .map((block) => (block.type === "text" ? block.text : ""))
          .join("");
        for (const [position, pageText] of parsePages(text)) {
          const original = batch[position - 1];
          if (original !== undefined && pageText.trim()) results.set(original, pageText.trim());
        }
        if (message.stop_reason === "max_tokens") {
          console.warn(`OCR output truncated for pages ${batch.join(", ")}.`);
        }
      }
    }
  };
}

/** Parses "=== PAGE n ===" delimited output into position -> text. */
export function parsePages(output: string): Map<number, string> {
  const pages = new Map<number, string>();
  const marker = /^=== PAGE (\d+) ===\s*$/gm;
  const matches = [...output.matchAll(marker)];
  matches.forEach((match, i) => {
    const start = match.index! + match[0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index! : output.length;
    pages.set(Number(match[1]), output.slice(start, end).trim());
  });
  return pages;
}

async function runPool<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      await worker(item);
    }
  });
  await Promise.all(runners);
}
