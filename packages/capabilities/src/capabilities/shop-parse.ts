import { z } from 'zod'

// The amazon.de parsers: pure functions from the HTML string of a page to typed data. No network, no model, no clock.
// Every selector was read off a real page (`fixtures/shop/`, provenance in `docs/shop.md`); a field the page does not
// carry is `null`, never a guess. The page is untrusted text: nothing here executes or follows what it says.

export const AMAZON_ORIGIN = 'https://www.amazon.de'

export const searchResultSchema = z.object({
  position: z.int().min(1).describe('1-based place on the page, sponsored results included'),
  asin: z.string(),
  title: z.string(),
  url: z.string().describe('Canonical product URL, https://www.amazon.de/dp/<ASIN>'),
  priceEur: z.number().nullable().describe('Price in euros; null when the card shows none'),
  priceText: z.string().nullable().describe('The price as the page prints it'),
  rating: z.number().nullable().describe('Average stars, 0..5'),
  reviewCount: z.int().nullable(),
  imageUrl: z.string().nullable(),
  sponsored: z.boolean(),
  prime: z
    .boolean()
    .describe('The card carries a Prime badge; an anonymous session is shown none, so false is not proof'),
  availability: z
    .string()
    .nullable()
    .describe('A stock or offer note on the card ("Nur noch 4 auf Lager"), as printed'),
})
export type SearchResult = z.infer<typeof searchResultSchema>

export const specSchema = z.object({ name: z.string(), value: z.string() })

export const itemSchema = z.object({
  asin: z.string(),
  url: z.string(),
  title: z.string().nullable(),
  brand: z.string().nullable(),
  priceEur: z.number().nullable(),
  priceText: z.string().nullable(),
  availability: z.string().nullable(),
  rating: z.number().nullable(),
  reviewCount: z.int().nullable(),
  bullets: z.array(z.string()).nullable().describe('"Info zu diesem Artikel"; null when the page has none'),
  specs: z
    .array(specSchema)
    .nullable()
    .describe('The product-overview and technical-details tables, in page order; null when the page has none'),
  images: z.array(z.string()).nullable().describe('Full-size image URLs, main image first'),
  seller: z.string().nullable(),
})
export type Item = z.infer<typeof itemSchema>

export type BlockKind = 'rate-limited' | 'bot-protection' | 'login-required' | 'forbidden'

// ---- text helpers ---------------------------------------------------------------------------------------------

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  euro: '€',
  shy: '',
  ndash: '–',
  mdash: '—',
  hellip: '…',
}

function decode(text: string): string {
  return text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (whole, body: string) => {
    if (body[0] === '#') {
      const code =
        body[1]?.toLowerCase() === 'x' ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10)
      if (!Number.isInteger(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return whole
      return String.fromCodePoint(code)
    }
    return ENTITIES[body.toLowerCase()] ?? whole
  })
}

/** The readable text of an HTML fragment: scripts and styles dropped, tags removed, entities decoded, whitespace collapsed. */
export function textOf(fragment: string): string {
  return decode(
    fragment
      .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, ' ')
      .replace(/<br\s*\/?>|<\/(p|div|li|tr|h[1-6])\s*>/gi, ' ')
      .replace(/<[^>]*>/g, ' '),
  )
    .replace(/[\s ‎‏]+/g, ' ')
    .trim()
}

/** An attribute's decoded value out of one opening tag, either quote style; undefined when absent. */
function attr(tag: string, name: string): string | undefined {
  const match = tag.match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i'))
  const value = match?.[1] ?? match?.[2]
  return value === undefined ? undefined : decode(value)
}

/** The end of the element whose opening tag starts at `start`, counting nested tags of the same name. */
function elementEnd(html: string, start: number, tag: string): number {
  const re = new RegExp(`<(/?)${tag}\\b[^>]*>`, 'gi')
  re.lastIndex = start
  let depth = 0
  for (let match = re.exec(html); match; match = re.exec(html)) {
    depth += match[1] ? -1 : 1
    if (depth === 0) return match.index + match[0].length
  }
  return Math.min(html.length, start + 60_000)
}

/** The outer HTML of the element with this id, or undefined. */
function elementById(html: string, id: string): string | undefined {
  const open = html.match(new RegExp(`<([a-z][a-z0-9]*)\\b[^>]*\\bid=["']${id}["'][^>]*>`, 'i'))
  if (!open || open.index === undefined) return undefined
  return html.slice(open.index, elementEnd(html, open.index, open[1]!))
}

/** "1.459,99 €" or "9,99€" → 1459.99 / 9.99. Anything that is not a euro amount in German notation is null. */
export function parsePrice(text: string | null | undefined): number | null {
  if (!text || !/€|EUR/.test(text)) return null
  const digits = text.replace(/[^\d.,]/g, '')
  if (!/^(\d{1,3}(\.\d{3})+|\d+)(,\d{1,2})?$/.test(digits)) return null
  return Number(digits.replace(/\./g, '').replace(',', '.'))
}

/** "4,5 von 5 Sternen" → 4.5 */
function parseRating(text: string | undefined): number | null {
  const match = text?.match(/^(\d(?:,\d)?)\s+von\s+5/)
  if (!match) return null
  const value = Number(match[1]!.replace(',', '.'))
  return value >= 0 && value <= 5 ? value : null
}

/** "7.795" or "(207)" → 7795 / 207 */
function parseCount(text: string | undefined): number | null {
  const match = text?.match(/^\(?(\d{1,3}(?:\.\d{3})+|\d+)\)?(?:\s|$)/)
  return match ? Number(match[1]!.replace(/\./g, '')) : null
}

const ASIN = /^[A-Z0-9]{10}$/

export function itemUrl(asin: string): string {
  return `${AMAZON_ORIGIN}/dp/${asin}`
}

// ---- blocked pages ----------------------------------------------------------------------------------------------

const ROBOT_MARKERS =
  /\/errors\/validateCaptcha|Geben Sie die angezeigten Zeichen|Enter the characters you see below|kein Roboter|not a robot/i

/** True when this is a page the parsers know how to read (a search page, or a product page with a title). */
export function isKnownPage(html: string): boolean {
  return /\bs-main-slot\b/.test(html) || /\bid=["']productTitle["']/.test(html)
}

/**
 * Why a response is a wall rather than a page, or null. A status of 429 is a rate limit; a robot-check text on a page
 * that is not a search or product page (a real page is 300 KB or more and never holds it as its subject) is the captcha
 * wall, whatever the status; a redirect to the sign-in flow is a login wall. Never a retry signal: the caller stops.
 */
export function detectBlock(input: { status: number; html: string; finalUrl: string }): BlockKind | null {
  if (input.status === 429) return 'rate-limited'
  if (/\/ap\/(signin|cvf)\b/.test(input.finalUrl)) return 'login-required'
  if (!isKnownPage(input.html) && ROBOT_MARKERS.test(input.html)) return 'bot-protection'
  if (input.status === 403) return 'forbidden'
  return null
}

// ---- search page ------------------------------------------------------------------------------------------------

const CARD_OPEN = /<div\b[^>]*\bdata-component-type="s-search-result"[^>]*>/g
const SPONSORED = /puis-sponsored-label|s-sponsored-label|\bAdHolder\b|>\s*Gesponsert\s*</
const PRIME = /a-icon-prime|aria-label="(?:Amazon )?Prime"/i
const AVAILABILITY =
  /Keine hervorgehobenen Angebote verfügbar|Derzeit nicht verfügbar|Nur noch \d+ (?:Stück )?auf Lager|Auf Lager/

/** The result cards of a search page, in page order. `[]` for a page that says it has none; throws on a page it does not know. */
export function parseSearch(html: string): SearchResult[] {
  if (!isKnownPage(html)) throw new Error('unrecognized search page layout')
  const results: SearchResult[] = []
  CARD_OPEN.lastIndex = 0
  for (let open = CARD_OPEN.exec(html); open; open = CARD_OPEN.exec(html)) {
    const asin = attr(open[0], 'data-asin') ?? ''
    if (!ASIN.test(asin)) continue
    const card = html.slice(open.index, elementEnd(html, open.index, 'div'))
    const title = card.match(/<h2\b[^>]*>([\s\S]*?)<\/h2>/i)?.[1]
    if (!title || !textOf(title)) continue
    const priceText = textOf(
      card.match(/<span class="a-price"[^>]*>\s*<span class="a-offscreen">([^<]*)<\/span>/)?.[1] ?? '',
    )
    const image = card.match(/<img\b[^>]*\bclass="[^"]*\bs-image\b[^"]*"[^>]*>/)?.[0]
    const imageUrl = image ? attr(image, 'src') : undefined
    const cardText = textOf(card)
    results.push({
      position: results.length + 1,
      asin,
      title: textOf(title),
      url: itemUrl(asin),
      priceEur: parsePrice(priceText),
      priceText: priceText || null,
      rating: parseRating(card.match(/aria-label="(\d(?:,\d)? von 5 Sternen)/)?.[1]),
      reviewCount: parseCount(card.match(/aria-label="([\d.]+) Bewertungen"/)?.[1]),
      imageUrl: imageUrl?.startsWith('https://') ? imageUrl : null,
      sponsored: SPONSORED.test(card),
      prime: PRIME.test(card),
      availability: cardText.match(AVAILABILITY)?.[0] ?? null,
    })
  }
  return results
}

// ---- item page --------------------------------------------------------------------------------------------------

const MAX_IMAGES = 12
const SKIPPED_SPECS = new Set(['Durchschnittliche Kundenbewertung'])

function specRows(section: string | undefined): { name: string; value: string }[] {
  if (!section) return []
  const rows: { name: string; value: string }[] = []
  for (const row of section.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...row[1]!.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((c) => textOf(c[1]!))
    const [name, value] = cells
    if (name && value && !SKIPPED_SPECS.has(name)) rows.push({ name, value })
  }
  return rows
}

function imageUrls(html: string): string[] {
  const hiRes = [...html.matchAll(/"hiRes":"(https:[^"]+)"/g)].map((m) => m[1]!)
  if (hiRes.length > 0) return [...new Set(hiRes)].slice(0, MAX_IMAGES)
  const landing = html.match(/<img\b[^>]*\bid="landingImage"[^>]*>/)?.[0]
  const dynamic = landing ? attr(landing, 'data-a-dynamic-image') : undefined
  if (!dynamic) return []
  try {
    const sizes = Object.entries(JSON.parse(dynamic) as Record<string, [number, number]>)
    const largest = sizes.filter(([url]) => url.startsWith('https://')).sort((a, b) => b[1][0] - a[1][0])[0]
    return largest ? [largest[0]] : []
  } catch {
    return []
  }
}

/** The product page's fields. Throws on a page with no product title (a layout the parser does not know). */
export function parseItem(html: string, asin: string): Item {
  const titleHtml = elementById(html, 'productTitle')
  if (!titleHtml) throw new Error('unrecognized product page layout')
  const title = textOf(titleHtml) || null

  const specs = [
    ...specRows(elementById(html, 'productOverview_feature_div')),
    ...specRows(elementById(html, 'prodDetails')),
  ].filter((spec, at, all) => all.findIndex((other) => other.name === spec.name) === at)

  const byline = textOf(elementById(html, 'bylineInfo') ?? '')
  const brand =
    specs.find((spec) => spec.name === 'Marke')?.value ??
    byline.match(/^Besuche (?:den|die|das) (.+?)(?:-| )Store$/)?.[1] ??
    byline.match(/^Marke:\s*(.+)$/)?.[1] ??
    null

  const price = (elementById(html, 'corePrice_feature_div') ?? '').match(
    /<span class="a-price(?![^"]*a-text-price)[^"]*"[^>]*>\s*<span class="a-offscreen">([^<]*)<\/span>/,
  )?.[1]
  const priceText = price ? textOf(price) : null

  const rating = html.match(/\bid="acrPopover"[^>]*\btitle="([^"]*)"/)?.[1]
  const count = elementById(html, 'acrCustomerReviewText')
  const bullets = [
    ...(elementById(html, 'feature-bullets') ?? '').matchAll(/<span class="a-list-item">([\s\S]*?)<\/span>/g),
  ]
    .map((m) => textOf(m[1]!))
    .filter(Boolean)
  const images = imageUrls(html)

  return {
    asin,
    url: itemUrl(asin),
    title,
    brand,
    priceEur: parsePrice(priceText),
    priceText,
    availability:
      textOf(html.match(/<span[^>]*\bprimary-availability-message[^>]*>([\s\S]*?)<\/span>/)?.[1] ?? '') || null,
    rating: parseRating(rating ? decode(rating) : undefined),
    reviewCount: parseCount(count ? textOf(count) : undefined),
    bullets: bullets.length > 0 ? bullets : null,
    specs: specs.length > 0 ? specs : null,
    images: images.length > 0 ? images : null,
    seller: textOf(html.match(/\bid=['"]sellerProfileTriggerId['"][^>]*>([^<]*)</)?.[1] ?? '') || null,
  }
}
