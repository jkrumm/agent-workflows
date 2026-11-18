import { z } from 'zod'
import { attr, decode, elementEnd, parseCount, parsePrice, textOf } from './shop-parse.ts'

// The price-comparison parsers: pure functions from the HTML string of an idealo.de or geizhals.de page (as the research
// Chrome rendered it) to typed data. No network, no model, no clock. Every selector was read off a real page
// (`fixtures/shop/`, provenance in `docs/shop.md`); a field the page does not carry is `null`, never a guess.

const IDEALO_ORIGIN = 'https://www.idealo.de'
const GEIZHALS_ORIGIN = 'https://geizhals.de'

/** The price comparison sites: one product page lists many shops' offers. */
export const AGGREGATORS = ['idealo', 'geizhals'] as const
/** The tech shops read on their own pages (`shop-direct-parse.ts`): one product page lists the shop's own offer. */
export const DIRECT_SHOPS = ['alternate', 'mindfactory', 'caseking'] as const
export const OFFER_SOURCES = [...AGGREGATORS, ...DIRECT_SHOPS] as const
export type OfferSource = (typeof OFFER_SOURCES)[number]
export type DirectShop = (typeof DIRECT_SHOPS)[number]
/** A Shopify storefront read through its JSON endpoints (shop-shopify-parse.ts): shopify:<host>. */
export const shopifySourceSchema = z.templateLiteral(['shopify:', z.string()])
/** Every source an offer can come from: the fixed ones and a listed Shopify store. */
export type AnySource = OfferSource | z.infer<typeof shopifySourceSchema>
export const anySourceSchema = z.union([z.enum(OFFER_SOURCES), shopifySourceSchema])
export const isDirectShop = (source: string): source is DirectShop =>
  (DIRECT_SHOPS as readonly string[]).includes(source)

const memorySchema = z.object({
  modules: z.int().min(1),
  moduleGb: z.number().positive(),
  totalGb: z.number().positive(),
})
type Memory = z.infer<typeof memorySchema>

export const offerSchema = z.object({
  shop: z.string().nullable().describe('The shop or seller as the site names it; null when the offer block names none'),
  marketplace: z
    .boolean()
    .nullable()
    .describe('A marketplace seller (idealo: "Marktplatzhändler", eBay); null where the site does not say'),
  priceEur: z.number().nullable().describe('Item price'),
  shippingEur: z.number().nullable().describe('Shipping on the cheapest way to pay; 0 for free shipping'),
  totalEur: z.number().nullable().describe('Item price plus shipping on the cheapest way to pay'),
  totalEurNoPrepayment: z
    .number()
    .nullable()
    .describe('The total on the cheapest way to pay that is not prepayment; null when the offer is prepayment only'),
  rating: z.number().nullable().describe('Shop rating, 0..5'),
  ratingCount: z.int().nullable(),
  paymentMethods: z.array(z.string()),
  prepaymentOnly: z.boolean().describe('Every payment method the offer lists is prepayment (Vorkasse, Überweisung)'),
  delivery: z.string().nullable().describe('Delivery date or stock text, as the page prints it'),
  inStock: z
    .boolean()
    .nullable()
    .describe('false when the site marks the offer unavailable; null when it says nothing'),
})
export type Offer = z.infer<typeof offerSchema>

export const productSchema = z.object({
  source: anySourceSchema,
  id: z.string(),
  url: z.string().describe('The product page'),
  name: z.string(),
  mpn: z.string().nullable().describe('The manufacturer part number the page names'),
  mpnBasis: z
    .literal('offer titles')
    .optional()
    .describe(
      'Set when the page names no part number of its own (idealo SSDs and CPUs) and `mpn` is the one asked, which the titles of the offers on the page name; absent when the page names it',
    ),
  gtin: z.string().nullable(),
  memory: memorySchema
    .nullable()
    .describe('Module count and size when the page states them (memory kits); null otherwise'),
  offerCount: z.int().describe('Offers the site says it has; `offers` holds the ones on the page read'),
  dataTime: z
    .string()
    .nullable()
    .describe('When the site says its data is from: ISO with offset (geizhals), local German time (idealo)'),
  tags: z
    .array(z.string())
    .optional()
    .describe("A Shopify store's tags as served (margin scheme, daily markdown, ...)"),
  notes: z.array(z.string()).optional().describe('What the tags this shop was seen to use mean'),
  compareAtEur: z.number().nullable().optional().describe("A Shopify store's struck-through price"),
  capacityGb: z
    .number()
    .nullable()
    .optional()
    .describe('Read from the product TITLE (Shopify stores): GB, 1 TB = 1000'),
  pricePerGbEur: z.number().nullable().optional().describe('Cheapest available item price per GB of capacityGb'),
})
export type Product = z.infer<typeof productSchema>

export const HISTORY_PERIODS = ['3M', '6M', '1Y'] as const
export const historySchema = z.object({
  period: z.enum(HISTORY_PERIODS),
  points: z.array(z.object({ date: z.string(), priceEur: z.number() })),
  lowestEur: z.number().nullable(),
  averageEur: z.number().nullable(),
  highestEur: z.number().nullable(),
})
export type History = z.infer<typeof historySchema>

/** A search hit: enough to pick the product whose part number equals the one asked, before its page is read. */
export interface SearchCandidate {
  id: string
  url: string
  name: string
  mpn: string | null
  /** Words of the card that may be the part number (a subtitle that lists it among other words); one that equals it makes the card a match. */
  tokens?: string[]
  /** The card carries no part number at all (a shop's tile names its item number): the product page's own part number decides. */
  mpnOnPage?: true
  /** idealo: the name carries no part number in brackets (every SSD and CPU), but the offers' titles on the product page may name it. */
  probe?: true
}

export interface ProductPage {
  product: Product
  offers: Offer[]
  /** idealo: the titles the shops give the product in their offers, which is where a part number the name lacks is printed. */
  titles?: string[]
}

export type SearchPage = { kind: 'list'; candidates: SearchCandidate[] } | { kind: 'product'; page: ProductPage }

// ---- shared helpers ----------------------------------------------------------------------------------------------

/** A part number as comparable text: upper case, letters and digits only ("cmk48gx5m2b5600c40" = "CMK48GX5M2B5600C40"). */
export const normMpn = (mpn: string): string => mpn.toUpperCase().replace(/[^A-Z0-9]/g, '')

const round2 = (n: number) => Math.round(n * 100) / 100

/** "Corsair Vengeance 48GB Kit DDR5-5600 CL40 (CMK48GX5M2B5600C40)" → "CMK48GX5M2B5600C40" */
const mpnOfName = (name: string): string | null => name.match(/\(([^()]+)\)\s*$/)?.[1]?.trim() || null

const memoryOf = (modules: number, moduleGb: number): Memory | null =>
  modules >= 1 && moduleGb > 0 ? { modules, moduleGb, totalGb: round2(modules * moduleGb) } : null

/** "Anzahl Module 2 … Kapazität pro Modul 24 GB" (idealo) or "Module 2x 24GB" (geizhals), as page text. */
function parseMemory(text: string): Memory | null {
  const idealo = text.match(/Anzahl Module\s*(\d+)[\s\S]{0,40}?Kapazität pro Modul\s*(\d+(?:,\d+)?)\s*GB/)
  if (idealo) return memoryOf(Number(idealo[1]), Number(idealo[2]!.replace(',', '.')))
  const geizhals = text.match(/\bModule\s*(\d+)\s*x\s*(\d+(?:,\d+)?)\s*GB/)
  if (geizhals) return memoryOf(Number(geizhals[1]), Number(geizhals[2]!.replace(',', '.')))
  return null
}

const PREPAYMENT = new Set(['Vorkasse', 'Überweisung'])
const PAYMENT_WORDS = [
  'Vorkasse',
  'Überweisung',
  'Sofortüberweisung',
  'Nachnahme',
  'Kreditkarte',
  'PayPal',
  'Klarna',
  'Rechnung',
  'Lastschrift',
  'Ratenzahlung',
  'Barzahlung',
  'Apple Pay',
  'Google Pay',
  'Amazon Payments',
]
const PAYMENT_NAMES: Record<string, string> = {
  paypal: 'PayPal',
  visa: 'Visa',
  mastercard: 'Mastercard',
  klarna: 'Klarna',
  'american-express': 'American Express',
  'diners-club': 'Diners Club',
  amzpay: 'Amazon Pay',
}
const paymentName = (raw: string): string => PAYMENT_NAMES[raw.trim().toLowerCase()] ?? raw.trim()

const dedupe = (items: string[]) => [...new Set(items.filter(Boolean))]
const prepaymentOnly = (methods: string[]) => methods.length > 0 && methods.every((m) => PREPAYMENT.has(m))
const hasNonPrepayment = (methods: string[]) => methods.length === 0 || methods.some((m) => !PREPAYMENT.has(m))

/** "9,99 €" or "1.068,90 €" (markup, `&nbsp;` included) → number. */
const euro = (markup: string | undefined): number | null => (markup ? parsePrice(textOf(markup)) : null)

/** The product page URL without query or fragment. */
const bare = (url: string) => {
  const u = new URL(url)
  return `${u.origin}${u.pathname}`
}

// ---- idealo -------------------------------------------------------------------------------------------------------

export const idealoSearchUrl = (query: string) =>
  `${IDEALO_ORIGIN}/preisvergleich/MainSearchProductCategory.html?q=${encodeURIComponent(query)}`

export const idealoHistoryUrl = (id: string, period: History['period']) =>
  `${IDEALO_ORIGIN}/price-chart/sites/1/products/${id}/history?period=${period}`

const IDEALO_PRODUCT = /^https:\/\/www\.idealo\.de\/preisvergleich\/OffersOfProduct\/(\d+)_-[a-z0-9-]*\.html$/

/** The idealo product id of a product page URL, or null when it is not one. */
export function idealoProductId(url: string): string | null {
  try {
    return IDEALO_PRODUCT.exec(bare(url))?.[1] ?? null
  } catch {
    return null
  }
}

/**
 * The page a search by part number lands on. idealo answers with the category list (cards with the product's name, its
 * part number in brackets and its facts) or, for one clear hit, may redirect to the product page itself.
 */
export function parseIdealoSearch(html: string, finalUrl: string): SearchPage {
  if (idealoProductId(finalUrl)) return { kind: 'product', page: parseIdealoProduct(html, finalUrl) }
  if (!/data-testid="(?:result-list|delphi-hint)"/.test(html)) throw new Error('unrecognized idealo search layout')
  const candidates: SearchCandidate[] = []
  const starts = [...html.matchAll(/data-testid="result-item"/g)].map((m) => m.index)
  starts.forEach((start, i) => {
    const card = html.slice(start, starts[i + 1] ?? html.length)
    const link = card.match(/href="(https:\/\/www\.idealo\.de\/preisvergleich\/OffersOfProduct\/(\d+)_-[^"?#]*\.html)/)
    const name = textOf(card.match(/data-testid="product-summary-title"[^>]*>([\s\S]*?)<\/div>/)?.[1] ?? '')
    if (!link || !name) return
    const mpn = mpnOfName(name)
    candidates.push({ id: link[2]!, url: link[1]!, name, mpn, ...(mpn === null ? { probe: true as const } : {}) })
  })
  return { kind: 'list', candidates }
}

const GERMAN_DATA_TIME = /Daten vom (\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}):(\d{2})/

/** The shop of an offer block: its name (the "Marktplatzhändler" suffix is a marker, not part of the name), whether it is a marketplace seller, and the item price its tracking data carries. */
function idealoShop(open: string): { shop: string | null; marketplace: boolean; jsonPrice: number | null } {
  let name: string | null = null
  let jsonPrice: number | null = null
  try {
    const parsed = JSON.parse(attr(open, 'data-mtrx-click') ?? '{}') as {
      shop_name?: string
      products?: { price?: number }[]
    }
    name = parsed.shop_name?.trim() || null
    jsonPrice = typeof parsed.products?.[0]?.price === 'number' ? parsed.products[0].price : null
  } catch {
    // a shop name the markup does not carry stays null
  }
  const shopType = attr(open, 'data-shop')?.match(/"type"\s*:\s*"([A-Z]+)"/)?.[1]
  return {
    shop: name?.replace(/\s*\(Marktplatzhändler\)\s*$/i, '') || null,
    marketplace: /\(Marktplatzhändler\)|\bMarketplace\b/i.test(name ?? '') || shopType === 'EBYDE',
    jsonPrice,
  }
}

/** The ways to pay: the titled text items (Rechnung, Vorkasse, …) and the payment icons' file names. */
function idealoMethods(block: string): string[] {
  return dedupe([
    ...[...block.matchAll(/productOffers-listItemOfferShippingDetailsRightItem" title="([^"]+)"/g)].map((m) =>
      paymentName(decode(m[1]!)),
    ),
    ...[...block.matchAll(/payment-icons\/2x\/([a-z0-9-]+?)-[0-9a-f]{10,}\.png/g)].map((m) => paymentName(m[1]!)),
  ])
}

function idealoDelivery(block: string): string | null {
  const dates = block.match(
    /productOffers-listItemOfferDeliveryStatusDatesTitle">([\s\S]*?)<\/[a-z]+>\s*<[^>]*productOffers-listItemOfferDeliveryStatusDatesRange">([\s\S]*?)<\/[a-z]+>/,
  )
  return dates ? `${textOf(dates[1]!)} ${textOf(dates[2]!)}`.trim() : null
}

const ratingOf = (text: string | undefined, decimal: RegExp) => (text ? Number(text.replace(decimal, '.')) : null)

function idealoOffer(block: string): Offer {
  const { shop, marketplace, jsonPrice } = idealoShop(block.slice(0, block.indexOf('>') + 1))
  const price = euro(block.match(/class="productOffers-listItemOfferPrice"[^>]*>([\s\S]*?)<\/a>/)?.[1]) ?? jsonPrice
  const totalText = decode(block.match(/class="productOffers-listItemOfferShippingDetails" title="([^"]*)"/)?.[1] ?? '')
  const total = /inkl\.\s*Versand/i.test(totalText) ? parsePrice(totalText.match(/[\d.]+,\d{2}\s*€/)?.[0]) : null
  const methods = idealoMethods(block)
  const delivery = idealoDelivery(block)
  return {
    shop,
    marketplace,
    priceEur: price,
    shippingEur: total !== null && price !== null ? Math.max(0, round2(total - price)) : null,
    totalEur: total,
    totalEurNoPrepayment: hasNonPrepayment(methods) ? total : null,
    rating: ratingOf(
      block.match(/starAndRatingWrapper"[^>]*>(?:(?!<li\b)[\s\S]){0,800}?<b>(\d(?:,\d)?)<\/b>/)?.[1],
      /,/,
    ),
    ratingCount: parseCount(block.match(/numberOfRatings">\s*([\d.]+)/)?.[1]),
    paymentMethods: methods,
    prepaymentOnly: prepaymentOnly(methods),
    delivery,
    inStock: /nicht (?:lieferbar|verfügbar)|ausverkauft/i.test(delivery ?? '') ? false : null,
  }
}

/** An idealo product page: the product and the offers listed on it (the first page of a longer list). */
export function parseIdealoProduct(html: string, finalUrl: string): ProductPage {
  const url = bare(finalUrl)
  const id = idealoProductId(url)
  if (!id) throw new Error('not an idealo product page URL')
  const nameHtml = html.match(/<h1\b[^>]*\bid="oopStage-title"[^>]*>([\s\S]*?)<\/h1>/)?.[1]
  const name = nameHtml ? textOf(nameHtml) : ''
  const listAt = html.search(/<ul class="productOffers-list"/)
  if (!name || listAt < 0) throw new Error('unrecognized idealo product page layout')
  const list = html.slice(listAt, elementEnd(html, listAt, 'ul'))
  const starts = [...list.matchAll(/<li class="productOffers-listItem row/g)].map((m) => m.index)
  const offers = starts.map((start, i) => idealoOffer(list.slice(start, starts[i + 1] ?? list.length)))
  const topAt = html.search(/class="oopStage-productInfoTopItems/)
  const overview = topAt < 0 ? '' : textOf(html.slice(topAt, elementEnd(html, html.lastIndexOf('<div', topAt), 'div')))
  const time = decode(html.match(/data-import-time="([^"]*)"/)?.[1] ?? '').match(GERMAN_DATA_TIME)
  const titles = [...list.matchAll(/productOffers-listItemTitleInner\s*"\s+title="([^"]*)"/g)].map((m) =>
    decode(m[1]!)
      .replace(/\u00ad/g, '')
      .trim(),
  )
  return {
    product: {
      source: 'idealo',
      id,
      url,
      name,
      mpn: mpnOfName(name),
      gtin: null,
      memory: parseMemory(overview),
      offerCount: Number(html.match(/"offerCount":(\d+)/)?.[1] ?? offers.length),
      dataTime: time ? `${time[3]}-${time[2]}-${time[1]}T${time[4]}:${time[5]}` : null,
    },
    offers,
    titles,
  }
}

/**
 * Whether the page is the product with part number `mpn`: its own part number equals it, or, when the name carries none (idealo
 * names an SSD "Samsung 990 Pro 2TB"), the titles of the offers on the page name it as a word. A title may print a part number
 * with other separators, so the comparison ignores them. Few of an SSD page's offers print it (5 of the 20 listed on the page of
 * the 2 TB WD Black SN850X, 2026-11-18), so the proportion is no test; one shop's sloppy title must not decide either: two
 * titles must name it (all of them when fewer are listed).
 */
export function pageNamesMpn(page: ProductPage, mpn: string): boolean {
  if (page.product.mpn !== null) return normMpn(page.product.mpn) === normMpn(mpn)
  const chars = normMpn(mpn).split('')
  if (chars.length < 6 || !page.titles || page.titles.length === 0) return false
  const word = new RegExp(`(?<![A-Za-z0-9])${chars.join('[^A-Za-z0-9]?')}(?![A-Za-z0-9])`, 'i')
  const named = page.titles.filter((title) => word.test(title)).length
  return named >= Math.min(2, page.titles.length)
}

/** The history JSON as the research Chrome shows it (`<pre>{…}</pre>`): daily points in cents and the period's statistics. */
export function parseIdealoHistory(html: string, period: History['period']): History {
  const body = html.match(/<pre[^>]*>([\s\S]*?)<\/pre>/)?.[1]
  if (!body) throw new Error('unrecognized idealo history answer (no JSON)')
  let json: unknown
  try {
    json = JSON.parse(decode(body))
  } catch {
    throw new Error('unrecognized idealo history answer (not JSON)')
  }
  const parsed = z
    .object({
      data: z.array(z.object({ x: z.string(), y: z.number() })),
      statistics: z
        .object({ avgPrice: z.number(), lowestPrice: z.number(), highestPrice: z.number() })
        .partial()
        .optional(),
    })
    .safeParse(json)
  if (!parsed.success) throw new Error('unrecognized idealo history answer (unexpected shape)')
  const cents = (n: number | undefined) => (n === undefined ? null : round2(n / 100))
  const stats = parsed.data.statistics
  return {
    period,
    points: parsed.data.data.map((p) => ({ date: p.x, priceEur: round2(p.y / 100) })),
    lowestEur: cents(stats?.lowestPrice),
    averageEur: cents(stats?.avgPrice),
    highestEur: cents(stats?.highestPrice),
  }
}

// ---- geizhals -----------------------------------------------------------------------------------------------------

export const geizhalsSearchUrl = (query: string) => `${GEIZHALS_ORIGIN}/?fs=${encodeURIComponent(query)}&hloc=de`

const GEIZHALS_PRODUCT = /^https:\/\/geizhals\.de\/[a-z0-9-]+-a(\d+)\.html$/

/** The geizhals product id of a product page URL, or null when it is not one. */
export function geizhalsProductId(url: string): string | null {
  try {
    return GEIZHALS_PRODUCT.exec(bare(url))?.[1] ?? null
  } catch {
    return null
  }
}

/**
 * The search list of geizhals: cards with name, part number and product link. The search matches loosely (a nonsense
 * query still lists products), so the caller compares part numbers.
 */
export function parseGeizhalsSearch(html: string, finalUrl: string): SearchPage {
  if (geizhalsProductId(finalUrl)) return { kind: 'product', page: parseGeizhalsProduct(html, finalUrl) }
  const starts = [...html.matchAll(/<article class="galleryview__item card/g)].map((m) => m.index)
  if (starts.length === 0) {
    if (/keine (?:Treffer|Ergebnisse|Produkte)/i.test(textOf(html))) return { kind: 'list', candidates: [] }
    throw new Error('unrecognized geizhals search layout')
  }
  const candidates: SearchCandidate[] = []
  for (const start of starts) {
    const card = html.slice(start, elementEnd(html, start, 'article'))
    const link = card.match(/<a\b[^>]*galleryview__name-link[^>]*>/)?.[0]
    const url = link ? attr(link, 'href') : undefined
    const id = url ? geizhalsProductId(url) : null
    const name = textOf(card.match(/<a\b[^>]*galleryview__name-link[^>]*>([\s\S]*?)<\/a>/)?.[1] ?? '')
    if (!url || !id || !name) continue
    candidates.push({
      id,
      url: bare(url),
      name,
      mpn: textOf(card.match(/class="galleryview__mpn"[^>]*>([\s\S]*?)<\/span>/)?.[1] ?? '') || null,
    })
  }
  return { kind: 'list', candidates }
}

const SHIPPING_FREE = /GRATISVERSAND|kostenfrei|kostenlos/i
/** Sentences of a delivery-and-payment note that are no shipping price of the offer. */
const NOT_SHIPPING = /Expressversand|Finanzierung|Abholung|Lieferung|Preis vom/i

/** What the delivery-and-payment note says: the payment methods and the cheapest shipping, overall and without prepayment. */
export function parseGeizhalsPayment(text: string): {
  methods: string[]
  shipping: number | null
  shippingNoPrepayment: number | null
} {
  const ways: { methods: string[]; amount: number }[] = []
  const methods: string[] = []
  for (const sentence of text.split(/\s*\.(?=\s|$)/)) {
    if (!sentence.trim() || NOT_SHIPPING.test(sentence)) continue
    const found = PAYMENT_WORDS.filter((word) => sentence.includes(word))
    methods.push(...found)
    const amount = SHIPPING_FREE.test(sentence) ? 0 : parsePrice(sentence.match(/€\s*[\d.]+,\d{2}/)?.[0])
    if (amount !== null) ways.push({ methods: found, amount })
  }
  const cheapest = (list: typeof ways) => (list.length === 0 ? null : Math.min(...list.map((w) => w.amount)))
  return {
    methods: dedupe(methods),
    shipping: cheapest(ways),
    shippingNoPrepayment: cheapest(ways.filter((w) => hasNonPrepayment(w.methods))),
  }
}

/** The totals of a geizhals offer: item price plus the cheapest shipping, overall and without prepayment. */
function geizhalsTotals(
  price: number | null,
  pay: ReturnType<typeof parseGeizhalsPayment>,
  methods: string[],
): Pick<Offer, 'shippingEur' | 'totalEur' | 'totalEurNoPrepayment'> {
  return {
    shippingEur: pay.shipping,
    totalEur: price !== null && pay.shipping !== null ? round2(price + pay.shipping) : null,
    totalEurNoPrepayment:
      price !== null && pay.shippingNoPrepayment !== null && hasNonPrepayment(methods)
        ? round2(price + pay.shippingNoPrepayment)
        : null,
  }
}

function geizhalsOffer(block: string): Offer & { time: string | null } {
  const price = euro(block.match(/class="gh_price">([\s\S]*?)<\/span>/)?.[1])
  const pay = parseGeizhalsPayment(textOf(block.match(/class="offer__delivery-payment">([\s\S]*?)<\/div>/)?.[1] ?? ''))
  const icons = [...block.matchAll(/<img\b[^>]*offer__payment-icon[^>]*>/g)].map((m) =>
    paymentName(attr(m[0], 'alt') ?? ''),
  )
  const methods = dedupe([...pay.methods, ...icons])
  const merchant = block.match(/<[a-z]+\b[^>]*data-merchant-name="[^"]*"[^>]*>/)?.[0]
  return {
    shop: merchant ? (attr(merchant, 'data-merchant-name') ?? null) : null,
    marketplace: null,
    priceEur: price,
    ...geizhalsTotals(price, pay, methods),
    rating: ratingOf(block.match(/Bewertung:\s*(\d(?:\.\d)?) von 5/)?.[1], /,/),
    ratingCount: parseCount(block.match(/stars-rating-label-bottom[^>]*>\s*([\d.]+)\s*Bewertung/)?.[1]),
    paymentMethods: methods,
    prepaymentOnly: prepaymentOnly(methods),
    delivery: textOf(block.match(/class="offer__delivery-time">([\s\S]*?)<\/div>/)?.[1] ?? '') || null,
    inStock: /\boffer--unavailable\b/.test(block.slice(0, block.indexOf('>') + 1)) ? false : null,
    time: block.match(/<time datetime="([^"]*)"/)?.[1] ?? null,
  }
}

interface GeizhalsVariant {
  name?: string
  mpn?: string
  gtin?: string
  url?: string
  offers?: { offerCount?: number }
}

/** A geizhals product page: the product (from its JSON-LD variant) and the offers listed on it. */
export function parseGeizhalsProduct(html: string, finalUrl: string): ProductPage {
  const url = bare(finalUrl)
  const id = geizhalsProductId(url)
  if (!id) throw new Error('not a geizhals product page URL')
  let variant: GeizhalsVariant | undefined
  for (const script of html.matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)) {
    try {
      const ld = JSON.parse(script[1]!) as GeizhalsVariant & { hasVariant?: GeizhalsVariant[] }
      variant = (ld.hasVariant ?? [ld]).find((v) => v.url?.includes(`-a${id}.html`) && v.mpn !== undefined)
      if (variant) break
    } catch {
      // another script block
    }
  }
  if (!variant?.name) throw new Error('unrecognized geizhals product page layout (no product data)')
  const starts = [...html.matchAll(/<div class="offer offer--[^"]*" id="offer-index-\d+"/g)].map((m) => m.index)
  const parsed = starts.map((start) => geizhalsOffer(html.slice(start, elementEnd(html, start, 'div'))))
  const times = parsed.map((o) => o.time).filter((t): t is string => t !== null)
  return {
    product: {
      source: 'geizhals',
      id,
      url,
      name: variant.name,
      mpn: variant.mpn?.trim() || null,
      gtin: variant.gtin?.trim() || null,
      memory: parseMemory(textOf(html)),
      offerCount: variant.offers?.offerCount ?? parsed.length,
      dataTime:
        times.length === 0 ? null : times.reduce((a, b) => (a > b ? a : b)).replace(/([+-]\d{2})(\d{2})$/, '$1:$2'),
    },
    offers: parsed.map(({ time: _time, ...offer }) => offer),
  }
}
