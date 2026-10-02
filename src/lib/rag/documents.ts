import { extractText, getDocumentProxy } from "unpdf";
import type { RagDatabase } from "./db";
import type { OcrFn } from "./ocr";
import type { CaseDocument, CaseRecord } from "./types";

/** Pages with fewer meaningful characters than this are treated as scans. */
const MIN_TEXT_CHARS = 25;
/** OCR is checkpointed to the database after every this-many pages. */
const OCR_CHECKPOINT_PAGES = 16;

export interface ExtractedDocument {
  records: CaseRecord[];
  pageCount: number;
  pagesWithoutText: number;
}

interface CachedPage {
  page: number;
  method: string;
  text: string;
}

/**
 * Turns a PDF into one CaseRecord per page that has text. Uses the PDF's own
 * text layer where it exists; pages without one go through OCR when an OCR
 * function is provided. Page text is cached by document version, so a file is
 * only parsed and OCR'd once.
 */
export async function extractDocumentPages(
  db: RagDatabase,
  doc: CaseDocument,
  options: { ocr?: OcrFn; log?: (msg: string) => void } = {},
): Promise<ExtractedDocument> {
  const log = options.log ?? (() => {});
  const cached = loadCachedPages(db, doc.versionKey);
  let bytes: Uint8Array | null = null;
  const getBytes = async () => (bytes ??= await doc.load());

  let pageTexts: Map<number, CachedPage>;
  if (cached.size > 0) {
    pageTexts = cached;
  } else {
    // unpdf/pdf.js may detach the buffer it is given, so pass a copy.
    const data = (await getBytes()).slice();
    const pdf = await getDocumentProxy(data);
    const { text } = await extractText(pdf, { mergePages: false });
    pageTexts = new Map();
    const save = db.prepare(
      "INSERT OR REPLACE INTO page_text(version_key, page, method, text) VALUES (?, ?, ?, ?)",
    );
    db.transaction(() => {
      text.forEach((pageText, i) => {
        const page = i + 1;
        const usable = meaningfulLength(pageText) >= MIN_TEXT_CHARS;
        const entry = { page, method: usable ? "text_layer" : "none", text: usable ? pageText : "" };
        pageTexts.set(page, entry);
        save.run(doc.versionKey, page, entry.method, entry.text);
      });
    })();
  }

  const missing = [...pageTexts.values()].filter((p) => p.method === "none").map((p) => p.page);
  if (missing.length > 0 && options.ocr) {
    log(`  OCR: ${missing.length} page(s) without a text layer in ${doc.name}`);
    const save = db.prepare(
      "UPDATE page_text SET method = 'ocr', text = ? WHERE version_key = ? AND page = ?",
    );
    for (let i = 0; i < missing.length; i += OCR_CHECKPOINT_PAGES) {
      const group = missing.slice(i, i + OCR_CHECKPOINT_PAGES);
      const result = await options.ocr(await getBytes(), group);
      db.transaction(() => {
        for (const [page, text] of result) {
          save.run(text, doc.versionKey, page);
          pageTexts.set(page, { page, method: "ocr", text });
        }
      })();
      log(`  OCR: ${Math.min(i + group.length, missing.length)}/${missing.length} pages done`);
    }
  }

  const pageCount = pageTexts.size;
  const records: CaseRecord[] = [];
  let pagesWithoutText = 0;
  for (const { page, method, text } of [...pageTexts.values()].sort((a, b) => a.page - b.page)) {
    if (method === "none" || isBlankMarker(text)) {
      if (method === "none") pagesWithoutText += 1;
      continue;
    }
    records.push({
      matterId: doc.matterId,
      sourceType: "document_page",
      sourceId: `${doc.documentId}#p${page}`,
      title: doc.name,
      date: doc.receivedDate,
      page,
      text,
      metadata: {
        documentId: doc.documentId,
        folder: doc.folder,
        page,
        pageCount,
        textSource: method,
      },
    });
  }
  return { records, pageCount, pagesWithoutText };
}

function loadCachedPages(db: RagDatabase, versionKey: string): Map<number, CachedPage> {
  const rows = db
    .prepare("SELECT page, method, text FROM page_text WHERE version_key = ? ORDER BY page")
    .all(versionKey) as CachedPage[];
  return new Map(rows.map((row) => [row.page, row]));
}

function meaningfulLength(text: string): number {
  return text.replace(/[\s\W_]+/g, "").length;
}

function isBlankMarker(text: string): boolean {
  return /^\[blank page\]$/i.test(text.trim());
}
