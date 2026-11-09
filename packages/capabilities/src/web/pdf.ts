import type { PdfReply, PdfRequest } from './pdf-worker.ts'

/** The wall-clock limit of one parse; a PDF that takes longer is a hostile or broken file, not a slow one. */
export const PDF_PARSE_MS = 20_000

/** The parse ran past its time limit and the worker was terminated. */
export class PdfTimeout extends Error {
  constructor(readonly ms: number) {
    super(`PDF parse timed out after ${ms} ms`)
  }
}

/** The parse failed inside the worker (damaged, encrypted, not a PDF) or the worker itself broke. */
export class PdfFailure extends Error {}

/**
 * The text of each page of a PDF, parsed in a worker thread: pdf.js cannot be interrupted, so the only way to bound it is
 * to terminate the thread. The caller's abort signal rejects with its own reason; the time limit with `PdfTimeout`.
 * `pages` holds at most `maxPages` entries and `totalPages` says how many the file has.
 */
export function extractPdfPages(
  bytes: Uint8Array,
  opts: { signal?: AbortSignal; timeoutMs?: number; maxPages?: number; worker?: URL | string } = {},
): Promise<{ pages: string[]; totalPages: number }> {
  const {
    signal,
    timeoutMs = PDF_PARSE_MS,
    maxPages,
    worker: entry = new URL('./pdf-worker.ts', import.meta.url),
  } = opts
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason)
    const worker = new Worker(entry)
    const settle = (finish: () => void) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      worker.terminate()
      finish()
    }
    const timer = setTimeout(() => settle(() => reject(new PdfTimeout(timeoutMs))), timeoutMs)
    const onAbort = () => settle(() => reject(signal?.reason))
    signal?.addEventListener('abort', onAbort, { once: true })
    worker.onmessage = (event: MessageEvent<PdfReply>) =>
      settle(() => ('error' in event.data ? reject(new PdfFailure(event.data.error)) : resolve(event.data)))
    worker.onerror = (event) => settle(() => reject(new PdfFailure(event.message || 'the PDF worker failed')))
    worker.addEventListener('messageerror', () =>
      settle(() => reject(new PdfFailure('the PDF worker sent an unreadable reply'))),
    )
    const request: PdfRequest = { bytes, ...(maxPages === undefined ? {} : { maxPages }) }
    // The buffer moves to the worker instead of being copied; the caller has no use for it afterwards.
    worker.postMessage(request, [bytes.buffer as ArrayBuffer])
  })
}
