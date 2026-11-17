import {
  type Offer,
  type Product,
  type ProductPage,
  type SearchCandidate,
  type SearchPage,
  type DirectShop,
} from './shop-offers-parse.ts'
import { attr, decode, elementEnd, textOf } from './shop-parse.ts'

// The parsers of the tech shops' own pages (Alternate, Caseking, Mindfactory): pure functions from the HTML string of a
// search or product page to the same typed data the aggregator parsers return. No network, no model, no clock. A shop's own
// page names ONE offer (its own), so a product page yields exactly one `Offer`, with no shop rating (the page has none).
// Every selector was read off a real page (`fixtures/shop/`, provenance in `docs/shop.md`); a field the page does not
// carry is `null`, never a guess.

const ALTERNATE_ORIGIN = 'https://www.alternate.de'
const CASEKING_ORIGIN = 'https://www.caseking.de'
const MINDFACTORY_ORIGIN = 'https://www.mindfactory.de'

export const alternateSearchUrl = (mpn: string) => `${ALTERNATE_ORIGIN}/listing.xhtml?q=${encodeURIComponent(mpn)}`
export const casekingSearchUrl = (mpn: string) => `${CASEKING_ORIGIN}/search?q=${encodeURIComponent(mpn)}`
export const mindfactorySearchUrl = (mpn: string) =>
  `${MINDFACTORY_ORIGIN}/search_result.php?search_query=${encodeURIComponent(mpn)}`

/** `/<slug>/html/product/<number>` on alternate.de. */
export function alternateProductId(url: string): string | null {
  return url.match(/^https:\/\/www\.alternate\.de\/[^?#]+\/html\/product\/(\d+)(?:[?#]|$)/)?.[1] ?? null
}

/** `/<slug>/<ITEM-NUMBER>.html` on caseking.de, the item number being `MEPM-140`-shaped. */
export function casekingProductId(url: string): string | null {
  return url.match(/^https:\/\/www\.caseking\.de\/[^?#]+\/([A-Z]{2,6}-\d{1,6})\.html(?:[?#]|$)/)?.[1] ?? null
}

/** `/product_info.php/<slug>_<id>.html` on mindfactory.de; a search that landed on the page adds `search/true/`. */
export function mindfactoryProductId(url: string): string | null {
  return (
    url.match(
      /^https:\/\/www\.mindfactory\.de\/product_info\.php\/(?:search\/true\/)?[^?#]*_(\d+)\.html(?:[?#]|$)/,
    )?.[1] ?? null
  )
}

/** The product page URL without a query, a fragment or the search marker mindfactory adds to a redirect. */
const clean = (url: string) =>
  url.replace(/[?#].*$/, '').replace('/product_info.php/search/true/', '/product_info.php/')

// ---- shared helpers ----------------------------------------------------------------------------------------------------

type JsonObject = Record<string, unknown>
const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const asText = (value: unknown): string | null =>
  typeof value === 'string' || typeof value === 'number' ? String(value).trim() || null : null
const asNumber = (value: unknown): number | null => {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN
  return Number.isFinite(n) ? n : null
}

/** Every schema.org node of the page's `application/ld+json` blocks, arrays and `@graph` flattened. */
function jsonLdNodes(html: string): JsonObject[] {
  const nodes: JsonObject[] = []
  for (const block of html.matchAll(/<script\b[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)) {
    let data: unknown
    try {
      data = JSON.parse(block[1]!)
    } catch {
      continue
    }
    for (const node of Array.isArray(data) ? data : [data]) {
      if (!isObject(node)) continue
      nodes.push(node)
      if (Array.isArray(node['@graph'])) nodes.push(...node['@graph'].filter(isObject))
    }
  }
  return nodes
}

const isType = (node: JsonObject, type: string) => [node['@type']].flat().includes(type)

/** The page's `Product` node and the first of its `Offer`s. */
function jsonLdProduct(html: string): { product: JsonObject; offer: JsonObject | null } | null {
  const product = jsonLdNodes(html).find((n) => isType(n, 'Product'))
  if (!product) return null
  const offer = [product.offers].flat().find(isObject) ?? null
  return { product, offer }
}

/** `InStock` → true, `OutOfStock` and its kin → false, anything else (or nothing) → null. */
function stockOf(availability: unknown): boolean | null {
  const word = asText(availability)?.match(/([A-Za-z]+)$/)?.[1]
  if (word === undefined) return null
  if (/^(InStock|LimitedAvailability|OnlineOnly|InStoreOnly)$/.test(word)) return true
  if (/^(OutOfStock|SoldOut|Discontinued)$/.test(word)) return false
  return null
}

const money = (n: number) => `${n.toFixed(2).replace('.', ',')} €`
const round2 = (n: number) => Math.round(n * 100) / 100

/** "48 GB (2x 24 GB)" or "(2x 24GB)" in text; "48GB ... Dual Kit" with no explicit split reads as two modules. */
export function memoryOfText(text: string): Product['memory'] {
  const split = text.match(/\b(\d+)\s*x\s*(\d+(?:[.,]\d+)?)\s*GB\b/i)
  if (split) {
    const modules = Number(split[1])
    const moduleGb = Number(split[2]!.replace(',', '.'))
    return modules >= 1 && moduleGb > 0 ? { modules, moduleGb, totalGb: round2(modules * moduleGb) } : null
  }
  const kit = text.match(/\b(\d+)\s*GB\b[\s\S]{0,80}?\b(Dual|Quad)[- ]?Kit\b/i)
  if (kit) {
    const modules = kit[2]!.toLowerCase() === 'quad' ? 4 : 2
    const totalGb = Number(kit[1])
    return totalGb > 0 ? { modules, moduleGb: round2(totalGb / modules), totalGb } : null
  }
  return null
}

interface OwnOffer {
  shop: string
  priceEur: number | null
  /** Shipping read off the page; `from` when the page says "ab" / "mind." (the cheapest tier of the shop's shipping table). */
  shippingEur: number | null
  shippingFrom: boolean
  inStock: boolean | null
  /** What the page says about stock, as it prints it. */
  stockText: string | null
}

/** One shop's own offer in the shape of the aggregators' offers: no rating, no marketplace, no prepayment information. */
function ownOffer(o: OwnOffer): Offer {
  const total = o.priceEur !== null && o.shippingEur !== null ? round2(o.priceEur + o.shippingEur) : null
  const shipping = o.shippingEur === null ? null : `Versand${o.shippingFrom ? ' ab' : ''} ${money(o.shippingEur)}`
  return {
    shop: o.shop,
    marketplace: false,
    priceEur: o.priceEur,
    shippingEur: o.shippingEur,
    totalEur: total,
    totalEurNoPrepayment: total,
    rating: null,
    ratingCount: null,
    paymentMethods: [],
    prepaymentOnly: false,
    delivery: [o.stockText, shipping].filter(Boolean).join(' · ') || null,
    inStock: o.inStock,
  }
}

function product(source: DirectShop, fields: Omit<Product, 'source' | 'offerCount' | 'dataTime'>): Product {
  return { source, offerCount: 1, dataTime: null, ...fields }
}

/** `ab 4,99€` / `mind. € 8,90` / `Versandkosten ab 4,99 €` → 4.99. */
function shippingFrom(text: string): number | null {
  const m = text.match(/Versandkosten(?:\s+in\s+Höhe\s+von)?\s+(?:ab|mind\.)\s*(?:€\s*)?(\d+(?:,\d{1,2})?)\s*(?:€)?/i)
  return m ? Number(m[1]!.replace(',', '.')) : null
}

// ---- alternate.de ------------------------------------------------------------------------------------------------------

/** Alternate's search is loose (a nonsense query lists the whole catalogue), so a card is only a candidate: its subtitle holds the part number among other words. */
export function parseAlternateSearch(html: string, finalUrl: string): SearchPage {
  if (alternateProductId(finalUrl)) return { kind: 'product', page: parseAlternateProduct(html, finalUrl) }
  const starts = [...html.matchAll(/<a\b[^>]*href="[^"]*\/html\/product\/\d+"[^>]*class="[^"]*\bproductBox\b/g)].map(
    (m) => m.index,
  )
  if (starts.length === 0) {
    if (/\bkeine (?:Treffer|Ergebnisse|Produkte)\b|nichts gefunden/i.test(textOf(html)))
      return { kind: 'list', candidates: [] }
    throw new Error('unrecognized alternate search layout')
  }
  const candidates: SearchCandidate[] = []
  for (const start of starts) {
    const card = html.slice(start, elementEnd(html, start, 'a'))
    const href = attr(card.match(/^<a\b[^>]*>/)?.[0] ?? '', 'href')
    const id = href ? alternateProductId(`${ALTERNATE_ORIGIN}${href}`) : null
    const name = textOf(card.match(/class="product-name[^"]*"[^>]*>([\s\S]*?)<\/div>/)?.[1] ?? '')
    const sub = textOf(card.match(/class="product-name-sub"[^>]*>([\s\S]*?)<\/span>/)?.[1] ?? '')
    if (!href || !id || !name) continue
    candidates.push({
      id,
      url: clean(`${ALTERNATE_ORIGIN}${href}`),
      name: sub ? `${name} ${sub}` : name,
      mpn: null,
      tokens: sub
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean),
    })
  }
  return { kind: 'list', candidates }
}

export function parseAlternateProduct(html: string, finalUrl: string): ProductPage {
  const id = alternateProductId(finalUrl)
  const found = jsonLdProduct(html)
  if (!id || !found) throw new Error('unrecognized alternate product page')
  const { product: p, offer } = found
  const name = decode(asText(p.name) ?? '')
  if (!name || !offer) throw new Error('alternate product page without a name or an offer')
  const rate = [offer.shippingDetails].flat().find(isObject)?.shippingRate
  const stockText = textOf(html.match(/Artikel kann derzeit nicht gekauft werden/)?.[0] ?? '') || null
  return {
    product: product('alternate', {
      id,
      url: clean(finalUrl),
      name,
      mpn: asText(p.mpn),
      gtin: asText(p.gtin13) ?? asText(p.gtin8) ?? asText(p.gtin),
      memory: memoryOfText(`${name} ${asText(p.description) ?? ''}`),
    }),
    offers: [
      ownOffer({
        shop: 'Alternate',
        priceEur: asNumber(offer.price),
        shippingEur: isObject(rate) ? asNumber(rate.value) : null,
        shippingFrom: false,
        inStock: stockOf(offer.availability),
        stockText,
      }),
    ],
  }
}

// ---- caseking.de -------------------------------------------------------------------------------------------------------

/**
 * A Caseking search tile carries its item number (`MEPM-140`), not the manufacturer's part number, so a candidate has none:
 * `locate` reads the one product page of a single-hit search and the page's own part number decides.
 */
export function parseCasekingSearch(html: string, finalUrl: string): SearchPage {
  if (casekingProductId(finalUrl)) return { kind: 'product', page: parseCasekingProduct(html, finalUrl) }
  const grid = html.indexOf('data-tile-container-id="search-results-product-list"')
  if (grid < 0) {
    if (/"searchResults":0\b|keine Ergebnisse gefunden/.test(html)) return { kind: 'list', candidates: [] }
    throw new Error('unrecognized caseking search layout')
  }
  const candidates: SearchCandidate[] = []
  const seen = new Set<string>()
  const body = html.slice(grid)
  const tiles = [...body.matchAll(/<div class="product-tile"[^>]*>/g)]
  for (const [i, tile] of tiles.entries()) {
    const name = attr(tile[0], 'aria-label')
    // The link is looked for inside this tile only: one without a link is skipped, never given the next tile's.
    const href = body.slice(tile.index, tiles[i + 1]?.index).match(/href="(\/[^"]+\/[A-Z]{2,6}-\d{1,6}\.html)"/)?.[1]
    const id = href ? casekingProductId(`${CASEKING_ORIGIN}${href}`) : null
    if (!name || !href || !id || seen.has(id)) continue
    seen.add(id)
    candidates.push({ id, url: `${CASEKING_ORIGIN}${href}`, name, mpn: null, mpnOnPage: true })
  }
  return { kind: 'list', candidates }
}

export function parseCasekingProduct(html: string, finalUrl: string): ProductPage {
  const id = casekingProductId(finalUrl)
  const found = jsonLdProduct(html)
  if (!id || !found) throw new Error('unrecognized caseking product page')
  const { product: p, offer } = found
  const name = decode(asText(p.name) ?? '')
  if (!name || !offer) throw new Error('caseking product page without a name or an offer')
  // JSON-LD `mpn` is Caseking's own item number; the manufacturer's part number is the "MPN" attribute of the page.
  const attribute = (label: string) =>
    textOf(
      html.match(
        new RegExp(
          `product-attributes-label[^>]*>\\s*${label}\\s*</span>\\s*<span[^>]*product-attributes-value[^>]*>([\\s\\S]*?)</span>`,
        ),
      )?.[1] ?? '',
    ) || null
  const stock = stockOf(offer.availability)
  return {
    product: product('caseking', {
      id,
      url: clean(finalUrl),
      name,
      mpn: attribute('MPN'),
      gtin: asText(p.gtin) ?? attribute('EAN'),
      memory: memoryOfText(`${name} ${decode(asText(p.description) ?? '')}`),
    }),
    offers: [
      ownOffer({
        shop: 'Caseking',
        priceEur: asNumber(offer.price),
        shippingEur: shippingFrom(textOf(html)),
        shippingFrom: true,
        inStock: stock,
        stockText: stock === null ? null : stock ? 'Auf Lager' : 'Nicht auf Lager',
      }),
    ],
  }
}

// ---- mindfactory.de ----------------------------------------------------------------------------------------------------

/** A search with one hit lands on that product (the browser's final URL), a search with none says "ergab 0 Treffer". */
export function parseMindfactorySearch(html: string, finalUrl: string): SearchPage {
  if (mindfactoryProductId(finalUrl)) return { kind: 'product', page: parseMindfactoryProduct(html, finalUrl) }
  if (/ergab 0 Treffer/.test(html)) return { kind: 'list', candidates: [] }
  // A list of several hits was not seen live (a prefix of a part number landed on the product too): the cards are read from
  // their links alone, and none carries a part number, so a list is never read as a match.
  const links = new Map<string, string>()
  for (const m of html.matchAll(
    /<a\b[^>]*href="(https:\/\/www\.mindfactory\.de\/product_info\.php\/[^"#?]*_(\d+)\.html)"[^>]*>/g,
  ))
    if (!links.has(m[2]!)) links.set(m[2]!, m[1]!)
  if (links.size === 0) throw new Error('unrecognized mindfactory search layout')
  return {
    kind: 'list',
    candidates: [...links].map(([id, url]) => ({
      id,
      url,
      name: url.match(/product_info\.php\/(.+)_\d+\.html$/)?.[1] ?? url,
      mpn: null,
      mpnOnPage: true,
    })),
  }
}

export function parseMindfactoryProduct(html: string, finalUrl: string): ProductPage {
  const id = mindfactoryProductId(finalUrl)
  const start = html.indexOf('itemtype="http://schema.org/Product"')
  if (!id || start < 0) throw new Error('unrecognized mindfactory product page')
  const scope = html.slice(start)
  const meta = (prop: string) =>
    scope.match(new RegExp(`itemprop="${prop}"[^>]*?\\scontent="([^"]*)"`, 'i'))?.[1] ?? null
  const name = textOf(scope.match(/<h1\b[^>]*itemprop="name"[^>]*>([\s\S]*?)<\/h1>/)?.[1] ?? '')
  const price = asNumber(meta('price'))
  if (!name || price === null) throw new Error('mindfactory product page without a name or a price')
  const stock = stockOf(scope.match(/itemprop="availability"[^>]*href="([^"]*)"/)?.[1])
  return {
    product: product('mindfactory', {
      id,
      url: clean(finalUrl),
      name,
      mpn: textOf(scope.match(/class="sku-model"[^>]*>([\s\S]*?)<\/span>/)?.[1] ?? '') || null,
      gtin: textOf(scope.match(/class="product-ean"[^>]*>([\s\S]*?)<\/span>/)?.[1] ?? '') || meta('gtin8'),
      memory: memoryOfText(name),
    }),
    offers: [
      ownOffer({
        shop: 'Mindfactory',
        priceEur: price,
        shippingEur: shippingFrom(textOf(html)),
        shippingFrom: true,
        inStock: stock,
        stockText: textOf(scope.match(/class="pshipping[^"]*"[^>]*>([\s\S]*?)<\/div>/)?.[1] ?? '') || null,
      }),
    ],
  }
}
