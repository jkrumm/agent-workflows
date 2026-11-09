import { describe, expect, test } from 'bun:test'
import { extractPdfPages, PdfFailure, PdfTimeout } from './pdf.ts'

const HANG = new URL('./test-fixtures/pdf-hang.worker.ts', import.meta.url)

/** A one-page-per-text PDF without an xref table (pdf.js rebuilds it). */
const pdf = (...pages: string[]) => {
  const objects = [
    '<</Type/Catalog/Pages 2 0 R>>',
    `<</Type/Pages/Kids[${pages.map((_, i) => `${3 + i * 2} 0 R`).join(' ')}]/Count ${pages.length}>>`,
    ...pages.flatMap((text, i) => {
      const stream = `BT /F1 18 Tf 20 100 Td (${text}) Tj ET`
      return [
        `<</Type/Page/Parent 2 0 R/MediaBox[0 0 400 200]/Contents ${4 + i * 2} 0 R/Resources<</Font<</F1 ${3 + pages.length * 2} 0 R>>>>>>`,
        `<</Length ${stream.length}>>\nstream\n${stream}\nendstream`,
      ]
    }),
    '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>',
  ]
  const body = objects.map((o, i) => `${i + 1} 0 obj\n${o}\nendobj\n`).join('')
  return new TextEncoder().encode(`%PDF-1.4\n${body}trailer\n<</Root 1 0 R/Size ${objects.length + 1}>>\n%%EOF\n`)
}

/** Counts timer ticks of the main thread: they only keep coming when the spinning work is off it. */
function tickCounter() {
  const ticks = { count: 0 }
  const timer = setInterval(() => ticks.count++, 10)
  return { ticks, stop: () => clearInterval(timer) }
}

describe('extractPdfPages', () => {
  test('reads the pages in a worker and trims to maxPages, reporting the total', async () => {
    const out = await extractPdfPages(pdf('one', 'two', 'three'), { maxPages: 2 })
    expect(out.totalPages).toBe(3)
    expect(out.pages.map((p) => p.trim())).toEqual(['one', 'two'])
  })

  test('bytes that are no PDF reject with a failure, not a hang', async () => {
    const error = await extractPdfPages(new TextEncoder().encode('not a pdf at all')).then(
      () => undefined,
      (e: unknown) => e,
    )
    expect(error).toBeInstanceOf(PdfFailure)
  })

  test('a parse that spins forever times out and is killed, while the main thread keeps running', async () => {
    const { ticks, stop } = tickCounter()
    const started = performance.now()
    const error = await extractPdfPages(pdf('x'), { worker: HANG, timeoutMs: 200 }).then(
      () => undefined,
      (e: unknown) => e,
    )
    const elapsed = performance.now() - started
    stop()
    expect(error).toBeInstanceOf(PdfTimeout)
    expect(elapsed).toBeLessThan(1_500)
    expect(ticks.count).toBeGreaterThan(5) // a blocked event loop would have counted none
  })

  test('aborting the signal mid-parse rejects promptly with the abort reason', async () => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(new Error('caller left')), 50)
    const started = performance.now()
    const error = await extractPdfPages(pdf('x'), { worker: HANG, timeoutMs: 10_000, signal: controller.signal }).then(
      () => undefined,
      (e: unknown) => e,
    )
    expect((error as Error).message).toBe('caller left')
    expect(performance.now() - started).toBeLessThan(1_000)
  })

  test('a signal that is already aborted rejects without starting a worker', async () => {
    const error = await extractPdfPages(pdf('x'), { signal: AbortSignal.abort(new Error('already')) }).then(
      () => undefined,
      (e: unknown) => e,
    )
    expect((error as Error).message).toBe('already')
  })
})
