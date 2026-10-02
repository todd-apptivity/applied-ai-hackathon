/**
 * Chunking.
 *
 * Most Clio records — notes, emails, tasks — are a paragraph or two and fall
 * out as a single chunk. Long records (a pasted email thread, an OCR'd page)
 * are split on the largest boundary that fits: blank line, then sentence end,
 * then whitespace. Consecutive chunks overlap so a fact that straddles a split
 * is still retrievable whole.
 */

import { ragConfig } from "./config";

export function normalizeText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Strip tags from Clio fields that may carry HTML (note detail, email body). */
export function stripHtml(text: string): string {
  return normalizeText(
    text
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'"),
  );
}

/** Index of the best split point at or before `limit`, or -1 if none. */
function splitPoint(text: string, limit: number): number {
  const window = text.slice(0, limit);
  const minimum = Math.floor(limit * 0.5);

  const paragraph = window.lastIndexOf("\n\n");
  if (paragraph >= minimum) return paragraph + 2;

  const sentence = Math.max(
    window.lastIndexOf(". "),
    window.lastIndexOf(".\n"),
    window.lastIndexOf("? "),
    window.lastIndexOf("! "),
  );
  if (sentence >= minimum) return sentence + 2;

  const space = window.lastIndexOf(" ");
  if (space >= minimum) return space + 1;

  return -1;
}

export function chunkText(
  input: string,
  options: { size?: number; overlap?: number } = {},
): string[] {
  const size = options.size ?? ragConfig.chunkChars;
  const overlap = Math.min(options.overlap ?? ragConfig.chunkOverlapChars, size - 1);
  const text = normalizeText(input);

  if (text.length === 0) return [];
  if (text.length <= size) return [text];

  const chunks: string[] = [];
  let cursor = 0;

  while (cursor < text.length) {
    const remaining = text.slice(cursor);

    if (remaining.length <= size) {
      chunks.push(remaining.trim());
      break;
    }

    const cut = splitPoint(remaining, size);
    const end = cut === -1 ? size : cut;
    const chunk = remaining.slice(0, end).trim();
    if (chunk.length > 0) chunks.push(chunk);

    // Always advance, even if the overlap would otherwise eat the whole step.
    cursor += Math.max(end - overlap, 1);
  }

  return chunks.filter((chunk) => chunk.length > 0);
}

/**
 * Prefix each chunk with its source's heading so an isolated chunk still says
 * what kind of record it came from and when. Retrieval quality on short,
 * context-free records (a two-word task name, a bare expense) depends on it.
 */
export function contextualize(heading: string, chunk: string): string {
  const trimmed = heading.trim();
  return trimmed.length > 0 ? `${trimmed}\n\n${chunk}` : chunk;
}
