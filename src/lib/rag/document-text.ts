/**
 * Getting a Clio document's bytes to indexed page text.
 *
 * The text layer is used wherever a PDF has one — it is exact, free, and
 * instant. Only the pages that come back empty go to the vision model, and
 * each page keeps its real page number either way, so a citation points at the
 * page a reader would turn to.
 *
 * Node-only (pdfjs, pdf-lib, filesystem-free but stream-based). Imported by
 * the text worker, not by route handlers.
 */

import { downloadDocument } from "@/lib/clio/resources";
import type { ClioDocument } from "@/lib/clio/types";

import { ocrPages } from "./ocr";
import { MIN_TEXT_LAYER_CHARS, pagesWithoutTextLayer, readPdfText } from "./pdf";

export interface ExtractedPage {
  page: number;
  text: string;
  /** True when the text came from the vision model rather than a text layer. */
  viaOcr: boolean;
}

export interface ExtractionResult {
  documentId: number;
  pageCount: number;
  pages: ExtractedPage[];
  fromTextLayer: number;
  fromOcr: number;
  /** Pages with neither a text layer nor a usable transcription. */
  empty: number;
  skipped?: string;
}

export interface ExtractOptions {
  /** Transcribe pages with no text layer. Off means text-layer only. */
  ocr?: boolean;
  batchSize?: number;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
}

async function toBytes(
  body: ReadableStream<Uint8Array> | null,
): Promise<Uint8Array> {
  if (!body) return new Uint8Array();
  return new Uint8Array(await new Response(body).arrayBuffer());
}

/**
 * Download one document and turn it into page text.
 *
 * Only PDFs are handled; anything else is reported as skipped rather than
 * silently producing no pages, so the caller can say what was left out.
 */
export async function extractDocumentText(
  document: Pick<ClioDocument, "id" | "name" | "filename" | "content_type">,
  options: ExtractOptions = {},
): Promise<ExtractionResult> {
  const log = options.onProgress ?? (() => {});
  const label = document.name ?? document.filename ?? `document ${document.id}`;

  const isPdf =
    document.content_type === "application/pdf" ||
    (document.filename ?? "").toLowerCase().endsWith(".pdf");

  if (!isPdf) {
    return {
      documentId: document.id,
      pageCount: 0,
      pages: [],
      fromTextLayer: 0,
      fromOcr: 0,
      empty: 0,
      skipped: `unsupported content type ${document.content_type ?? "unknown"}`,
    };
  }

  const { body } = await downloadDocument(document.id, { signal: options.signal });
  const bytes = await toBytes(body);
  if (bytes.byteLength === 0) {
    return {
      documentId: document.id,
      pageCount: 0,
      pages: [],
      fromTextLayer: 0,
      fromOcr: 0,
      empty: 0,
      skipped: "Clio returned no bytes",
    };
  }

  const read = await readPdfText(bytes);
  const textless = pagesWithoutTextLayer(read);
  log(
    `${label}: ${read.pageCount} page(s), ${read.pageCount - textless.length} with a text layer, ` +
      `${textless.length} without`,
  );

  const transcribed = new Map<number, string>();
  if (options.ocr !== false && textless.length > 0) {
    const pages = await ocrPages(bytes, textless, {
      batchSize: options.batchSize,
      signal: options.signal,
      onProgress: (message) => log(`  ${label}: ${message}`),
    });
    for (const page of pages) {
      if (page.text.trim().length > 0) transcribed.set(page.page, page.text);
    }
  }

  const pages: ExtractedPage[] = [];
  let fromTextLayer = 0;
  let fromOcr = 0;
  let empty = 0;

  for (const page of read.pages) {
    if (page.text.length >= MIN_TEXT_LAYER_CHARS) {
      pages.push({ page: page.page, text: page.text, viaOcr: false });
      fromTextLayer += 1;
      continue;
    }

    const ocrText = transcribed.get(page.page);
    if (ocrText) {
      pages.push({ page: page.page, text: ocrText, viaOcr: true });
      fromOcr += 1;
      continue;
    }

    // A page with a stray character or two and no transcription carries no
    // retrievable content; indexing it would add a chunk that matches nothing.
    empty += 1;
  }

  return {
    documentId: document.id,
    pageCount: read.pageCount,
    pages,
    fromTextLayer,
    fromOcr,
    empty,
  };
}
