import { extractText, getDocumentProxy } from 'unpdf'

// The Bun Worker entry of `extractPdfPages` (pdf.ts). pdf.js is synchronous CPU work with no time limit of its own, so
// it runs here, where the host can terminate it, and not on the host's event loop.

export type PdfRequest = { bytes: Uint8Array; maxPages?: number }
export type PdfReply = { pages: string[]; totalPages: number } | { error: string }

declare const self: {
  onmessage: ((event: MessageEvent<PdfRequest>) => void) | null
  postMessage(message: PdfReply): void
}

async function parse({ bytes, maxPages }: PdfRequest) {
  try {
    // The bundled pdf.js (6.4.x) is past CVE-2024-4367 (fixed in 4.2.67) and has no eval option left.
    const pdf = await getDocumentProxy(bytes)
    const { text, totalPages } = await extractText(pdf, { mergePages: false })
    self.postMessage({ pages: text.slice(0, maxPages), totalPages })
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) })
  }
}

self.onmessage = (event) => {
  void parse(event.data)
}
