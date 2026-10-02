/**
 * PDF reading, page by page.
 *
 * Two jobs: pull the embedded text layer where a PDF has one, and carve out a
 * subset of pages as a standalone PDF so the pages that have no text layer can
 * be sent to a vision model on their own.
 *
 * Node-only (pdfjs legacy build, no DOM, no canvas). Keep this out of anything
 * a route handler imports.
 */

import { PDFDocument } from "pdf-lib";

export interface PdfPage {
  /** 1-based, as a reader would cite it. */
  page: number;
  /** Text layer content, empty when the page is a scan. */
  text: string;
}

export interface PdfRead {
  pageCount: number;
  pages: PdfPage[];
}

/**
 * Below this many characters a page is treated as having no usable text layer.
 * Scanned pages routinely carry a few stray characters — a header stamp, a
 * page number drawn as text over the image — so "empty" has to mean "nearly
 * empty" rather than zero.
 */
export const MIN_TEXT_LAYER_CHARS = 100;

/* eslint-disable @typescript-eslint/no-explicit-any */
// pdfjs ships no types for the legacy Node build.
async function pdfjs(): Promise<any> {
  return import("pdfjs-dist/legacy/build/pdf.mjs");
}

/** Read every page's text layer. */
export async function readPdfText(bytes: Uint8Array): Promise<PdfRead> {
  const lib = await pdfjs();

  // pdfjs transfers and detaches the buffer it is given; hand it a copy so the
  // caller can still use the original (to carve out pages for OCR).
  const task = lib.getDocument({
    data: new Uint8Array(bytes),
    isEvalSupported: false,
    useSystemFonts: false,
  });
  const document = await task.promise;

  // Read before teardown: the proxy's fields are gone once the task is destroyed.
  const pageCount: number = document.numPages;
  const pages: PdfPage[] = [];

  try {
    for (let page = 1; page <= pageCount; page += 1) {
      const handle = await document.getPage(page);
      const content = await handle.getTextContent();
      // Items carry their own spacing flags; joining on a space and collapsing
      // runs keeps words apart without inventing line structure.
      const text = (content.items as any[])
        .map((item) => (typeof item?.str === "string" ? item.str : ""))
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      pages.push({ page, text });
      handle.cleanup();
    }
  } finally {
    // `destroy` lives on the loading task in pdfjs 6, not on the document proxy.
    await task.destroy();
  }

  return { pageCount, pages };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export function pagesWithoutTextLayer(read: PdfRead): number[] {
  return read.pages
    .filter((page) => page.text.length < MIN_TEXT_LAYER_CHARS)
    .map((page) => page.page);
}

/**
 * Build a new PDF holding only `pageNumbers` (1-based), in the order given.
 * Used to send a handful of scanned pages to the model without uploading a
 * whole bundle.
 */
export async function extractPages(
  bytes: Uint8Array,
  pageNumbers: number[],
): Promise<Uint8Array> {
  const source = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const target = await PDFDocument.create();

  const copied = await target.copyPages(
    source,
    pageNumbers.map((page) => page - 1),
  );
  for (const page of copied) target.addPage(page);

  return target.save();
}
