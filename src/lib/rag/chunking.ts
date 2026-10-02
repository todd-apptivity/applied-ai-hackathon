import type { CaseRecord, SourceType } from "./types";

export interface ChunkOptions {
  /** Target maximum characters per chunk body (~300 tokens at 1,200). */
  maxChars?: number;
  /** Characters of trailing context repeated at the start of the next chunk. */
  overlapChars?: number;
}

export interface RecordChunk {
  ordinal: number;
  /** Chunk body, returned to the chat agent. */
  text: string;
  /** Header + body. This is what gets embedded and keyword-indexed. */
  embedText: string;
}

const SOURCE_LABELS: Record<SourceType, string> = {
  matter: "Matter",
  custom_field: "Matter field",
  contact: "Contact",
  note: "Note",
  communication: "Communication",
  task: "Task",
  calendar_entry: "Calendar entry",
  expense: "Expense",
  document_page: "Document page",
};

export function sourceLabel(type: SourceType): string {
  return SOURCE_LABELS[type];
}

/**
 * A one-line header that travels with every chunk so a chunk read in
 * isolation still says what it is, when it is from, and where it came from.
 */
export function recordHeader(record: CaseRecord): string {
  const parts = [sourceLabel(record.sourceType)];
  if (record.date) parts.push(record.date);
  parts.push(record.title);
  if (record.page) parts.push(`page ${record.page}`);
  return `[${parts.join(" | ")}]`;
}

export function chunkRecord(
  record: CaseRecord,
  options: ChunkOptions = {},
): RecordChunk[] {
  const header = recordHeader(record);
  const bodies = splitText(record.text, options);
  return bodies.map((text, ordinal) => ({
    ordinal,
    text,
    embedText: `${header}\n${text}`,
  }));
}

/**
 * Splits text on paragraph, then sentence, then word boundaries so chunks stay
 * under maxChars. Adjacent chunks share a short overlap so a fact that spans a
 * boundary is still retrievable from either side.
 */
export function splitText(text: string, options: ChunkOptions = {}): string[] {
  const maxChars = options.maxChars ?? 1200;
  const overlapChars = Math.min(options.overlapChars ?? 150, Math.floor(maxChars / 4));
  const clean = text.replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").trim();
  if (!clean) return [];
  if (clean.length <= maxChars) return [clean];

  const pieces = toPieces(clean, maxChars);
  const chunks: string[] = [];
  let current = "";

  for (const piece of pieces) {
    const candidate = current ? `${current}\n${piece}` : piece;
    if (candidate.length <= maxChars) {
      current = candidate;
      continue;
    }
    if (current) chunks.push(current);
    const overlap = tail(current, overlapChars);
    current = overlap && overlap.length + piece.length + 1 <= maxChars
      ? `${overlap}\n${piece}`
      : piece;
  }
  if (current) chunks.push(current);
  return chunks;
}

/** Breaks text into pieces no longer than maxChars, preferring natural boundaries. */
function toPieces(text: string, maxChars: number): string[] {
  const out: string[] = [];
  for (const paragraph of text.split(/\n{2,}/)) {
    const p = paragraph.trim();
    if (!p) continue;
    if (p.length <= maxChars) {
      out.push(p);
      continue;
    }
    // Sentence-ish split: keep the terminator with the sentence.
    const sentences = p.match(/[^.!?\n]+(?:[.!?]+|\n|$)/g) ?? [p];
    let buffer = "";
    for (const raw of sentences) {
      const sentence = raw.trim();
      if (!sentence) continue;
      if (sentence.length > maxChars) {
        if (buffer) {
          out.push(buffer);
          buffer = "";
        }
        out.push(...hardWrap(sentence, maxChars));
        continue;
      }
      const candidate = buffer ? `${buffer} ${sentence}` : sentence;
      if (candidate.length <= maxChars) {
        buffer = candidate;
      } else {
        out.push(buffer);
        buffer = sentence;
      }
    }
    if (buffer) out.push(buffer);
  }
  return out;
}

function hardWrap(text: string, maxChars: number): string[] {
  const out: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    if (word.length > maxChars) {
      if (line) out.push(line);
      for (let i = 0; i < word.length; i += maxChars) out.push(word.slice(i, i + maxChars));
      line = "";
      continue;
    }
    const candidate = line ? `${line} ${word}` : word;
    if (candidate.length <= maxChars) {
      line = candidate;
    } else {
      out.push(line);
      line = word;
    }
  }
  if (line) out.push(line);
  return out;
}

/** Last ~n characters of text, starting at a word boundary. */
function tail(text: string, n: number): string {
  if (!text || n <= 0) return "";
  if (text.length <= n) return text;
  const slice = text.slice(text.length - n);
  const firstSpace = slice.search(/\s/);
  return (firstSpace >= 0 ? slice.slice(firstSpace + 1) : slice).trim();
}
