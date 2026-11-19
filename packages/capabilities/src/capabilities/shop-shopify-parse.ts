import { z } from 'zod'
import { normMpn, type Offer, type Product, type ProductPage } from './shop-offers-parse.ts'

// The Shopify storefront parsers: pure functions from the JSON a store answers on its standard read-only endpoints
// (`/search/suggest.json`, `/products/<handle>.js`, `/collections.json`, `/collections/<handle>/products.json`) to typed
// data. No network, no model, no clock. A field the JSON does not carry is `null`, never a guess.

/** Stores read as `--source shopify:<host>`. A store is one line here: the fetcher reads no host that is not listed. */
export const SHOPIFY_HOSTS = ['www.it-veith.de'] as const
const SHOPIFY_PREFIX = 'shopify:'

export type ShopifySource = `shopify:${string}`

export const isShopifySource = (source: string): source is ShopifySource => source.startsWith(SHOPIFY_PREFIX)
export const shopifySource = (host: string): ShopifySource => `${SHOPIFY_PREFIX}${host}`

/** The host of a `shopify:<host>` source when the store is listed, else null. */
export function shopifyHost(source: string): string | null {
  if (!isShopifySource(source)) return null
  const host = source.slice(SHOPIFY_PREFIX.length).toLowerCase()
  return (SHOPIFY_HOSTS as readonly string[]).includes(host) ? host : null
}

const origin = (host: string) => `https://${host}`

export const suggestUrl = (host: string, query: string, limit = 10) =>
  `${origin(host)}/search/suggest.json?q=${encodeURIComponent(query)}&resources[type]=product&resources[limit]=${limit}`
export const productJsUrl = (host: string, handle: string) =>
  `${origin(host)}/products/${encodeURIComponent(handle)}.js`
export const collectionsUrl = (host: string) => `${origin(host)}/collections.json?limit=250`
export const collectionFeedUrl = (host: string, handle: string, limit: number, page: number) =>
  `${origin(host)}/collections/${encodeURIComponent(handle)}/products.json?limit=${limit}&page=${page}`

/** The handle of a product page URL (`https://<host>/products/<handle>`, optional query) on a listed store, else null. */
export function shopifyProductHandle(url: string): { host: string; handle: string } | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:' || !(SHOPIFY_HOSTS as readonly string[]).includes(parsed.hostname)) return null
  const handle = parsed.pathname.match(/^\/products\/([^/]+?)(?:\.js|\.json)?$/)?.[1]
  return handle ? { host: parsed.hostname, handle: decodeURIComponent(handle) } : null
}

// ---- shared helpers ----------------------------------------------------------------------------------------------

const round2 = (n: number) => Math.round(n * 100) / 100

/** "564.85" → 564.85; null for a price that is not a number. */
const eurOfString = (value: string | number | null | undefined): number | null => {
  if (value === null || value === undefined || value === '') return null
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? round2(n) : null
}

/** The `.js` endpoint prices in cents: 56485 → 564.85. */
const eurOfCents = (cents: number | null | undefined): number | null =>
  cents === null || cents === undefined ? null : round2(cents / 100)

/** The shop's listings lead their titles with a check mark; the name is without it. */
const cleanTitle = (title: string) => title.replace(/^(?:✔️?|✅)\s*/u, '').trim()

/** "www.it-veith.de" → "it-veith.de": the shop as an offer names it. */
const shopName = (host: string) => host.replace(/^www\./, '')

const FREE_SHIPPING = /kostenlose[rn]?\s+Versand|versandkostenfrei/i

const MEMORY_TITLE = /\bDDR\d|\bDIMM\b|\bRAM\b|Arbeitsspeicher/i

export interface Capacity {
  totalGb: number
  /** Set when the title names a kit ("2x24GB"). */
  modules: number | null
  moduleGb: number | null
}

const KIT = /(\d{1,2})\s*[x×]\s*(\d+(?:[.,]\d+)?)\s*(GB|TB)\b/i
const SIZE = /(\d+(?:[.,]\d+)?)\s*(GB|TB)\b(?!\s*\/\s*s)/gi
const toGb = (value: string, unit: string) => Number(value.replace(',', '.')) * (unit.toUpperCase() === 'TB' ? 1000 : 1)

/**
 * The capacity a title states, in GB (1 TB = 1000 GB, as drives are sold): a kit "2x24GB" is 48 GB; otherwise the first
 * "<n> GB|TB" that is not a speed ("GB/s"). Only the title is read: this shop's URL handles are copied between listings
 * (its 48 GB kit has a handle that says 64gb-2x32gb), so a handle is never evidence of a capacity.
 */
export function capacityOf(title: string): Capacity | null {
  const kit = title.match(KIT)
  if (kit) {
    const modules = Number(kit[1])
    const moduleGb = toGb(kit[2]!, kit[3]!)
    if (modules >= 1 && moduleGb > 0) return { totalGb: round2(modules * moduleGb), modules, moduleGb }
  }
  SIZE.lastIndex = 0
  const plain = SIZE.exec(title)
  if (!plain) return null
  const totalGb = toGb(plain[1]!, plain[2]!)
  return totalGb > 0 ? { totalGb: round2(totalGb), modules: null, moduleGb: null } : null
}

/** The price per GB of a title's stated capacity; null when the title states none or the price is unknown. */
export const pricePerGb = (priceEur: number | null, capacity: Capacity | null): number | null =>
  priceEur === null || capacity === null ? null : Math.round((priceEur / capacity.totalGb) * 10_000) / 10_000

/** What the tags this shop was seen to use mean. Any other tag is carried raw and not interpreted. */
const TAG_MEANING: Record<string, string> = {
  diffbesteuert: 'margin scheme (§25a UStG): no VAT shown on the invoice',
  halfpercday: 'daily markdown',
}

export const tagNotes = (tags: string[]): string[] => tags.flatMap((t) => (TAG_MEANING[t] ? [TAG_MEANING[t]] : []))

/** True when `title` satisfies `expr`: `|` separates alternatives, the words of one alternative must all appear (any case). Empty `expr` matches. */
export function titleMatches(title: string, expr: string | undefined): boolean {
  if (!expr?.trim()) return true
  const lower = title.toLowerCase()
  return expr.split('|').some((alt) => {
    const words = alt.toLowerCase().split(/\s+/).filter(Boolean)
    return words.length > 0 && words.every((w) => lower.includes(w))
  })
}

// ---- listing items -----------------------------------------------------------------------------------------------

export const listingItemSchema = z.object({
  id: z.string(),
  handle: z.string(),
  url: z.string().describe('The product page'),
  title: z.string(),
  vendor: z.string().nullable(),
  priceEur: z
    .number()
    .nullable()
    .describe('The cheapest available variant (the cheapest of all when none is available)'),
  compareAtEur: z.number().nullable().describe("The shop's struck-through price of that variant"),
  available: z.boolean().nullable().describe('Any variant can be bought; null where the endpoint does not say'),
  tags: z.array(z.string()).describe("The shop's tags as served"),
  notes: z.array(z.string()).describe('What the tags this shop was seen to use mean (margin scheme, daily markdown)'),
  capacityGb: z.number().nullable().describe('Read from the TITLE, never the handle: "48GB (2x24GB)" 48, "4TB" 4000'),
  pricePerGbEur: z.number().nullable(),
  gtin: z.string().nullable().describe('The EAN the listing text names; null where the endpoint carries no text'),
  freeShipping: z
    .boolean()
    .nullable()
    .describe('The listing text says the shipping is free; null where the endpoint carries no text'),
})
export type ListingItem = z.infer<typeof listingItemSchema>

function listingItem(
  host: string,
  raw: { id: string | number; handle: string; title: string; vendor?: string | null },
  fields: { priceEur: number | null; compareAtEur: number | null; available: boolean | null; tags: string[] },
  text: string | null = null,
): ListingItem {
  const title = cleanTitle(raw.title)
  const capacity = capacityOf(title)
  return {
    id: String(raw.id),
    handle: raw.handle,
    url: `${origin(host)}/products/${raw.handle}`,
    title,
    vendor: raw.vendor || null,
    ...fields,
    notes: tagNotes(fields.tags),
    capacityGb: capacity?.totalGb ?? null,
    pricePerGbEur: pricePerGb(fields.priceEur, capacity),
    gtin: text?.match(/EAN:(?:<\/b>)?\s*(\d{8,14})/)?.[1] ?? null,
    freeShipping: text === null ? null : FREE_SHIPPING.test(text),
  }
}

/** Tags as an array, whether the endpoint serves one or a comma-separated string. */
const tagsOf = (tags: string[] | string | undefined): string[] =>
  Array.isArray(tags)
    ? tags
    : (tags ?? '')
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean)

const parseJson = (text: string, what: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`${what}: the answer is not JSON`)
  }
}

const strictOf = <T>(schema: z.ZodType<T>, value: unknown, what: string): T => {
  const parsed = schema.safeParse(value)
  if (!parsed.success) throw new Error(`${what}: unrecognized layout (${parsed.error.issues[0]?.path.join('.') ?? ''})`)
  return parsed.data
}

const id = z.union([z.string(), z.number()])

const suggestSchema = z.looseObject({
  resources: z.looseObject({
    results: z.looseObject({
      products: z.array(
        z.looseObject({
          id,
          handle: z.string(),
          title: z.string(),
          vendor: z.string().nullish(),
          body: z.string().nullish(),
          available: z.boolean().nullish(),
          price: z.union([z.string(), z.number()]).nullish(),
          compare_at_price_min: z.union([z.string(), z.number()]).nullish(),
          tags: z.union([z.array(z.string()), z.string()]).optional(),
        }),
      ),
    }),
  }),
})

/** `/search/suggest.json`: at most ten products with price, availability and tags. */
export function parseSuggest(text: string, host: string): ListingItem[] {
  const data = strictOf(suggestSchema, parseJson(text, 'the suggest answer'), 'the suggest answer')
  return data.resources.results.products.map((p) =>
    listingItem(
      host,
      p,
      {
        priceEur: eurOfString(p.price),
        compareAtEur: eurOfString(p.compare_at_price_min),
        available: p.available ?? null,
        tags: tagsOf(p.tags),
      },
      p.body ?? '',
    ),
  )
}

const feedSchema = z.looseObject({
  products: z.array(
    z.looseObject({
      id,
      handle: z.string(),
      title: z.string(),
      vendor: z.string().nullish(),
      tags: z.union([z.array(z.string()), z.string()]).optional(),
      variants: z.array(
        z.looseObject({
          price: z.union([z.string(), z.number()]).nullish(),
          compare_at_price: z.union([z.string(), z.number()]).nullish(),
          available: z.boolean().nullish(),
        }),
      ),
    }),
  ),
})

/** `/collections/<handle>/products.json`: the products of one collection page. */
export function parseCollectionFeed(text: string, host: string): ListingItem[] {
  const data = strictOf(feedSchema, parseJson(text, 'the collection feed'), 'the collection feed')
  return data.products.map((p) => {
    const buyable = p.variants.filter((v) => v.available === true)
    const pick = (buyable.length > 0 ? buyable : p.variants)
      .map((v) => ({ price: eurOfString(v.price), compareAt: eurOfString(v.compare_at_price) }))
      .filter((v): v is { price: number; compareAt: number | null } => v.price !== null)
      .sort((a, b) => a.price - b.price)[0]
    return listingItem(host, p, {
      priceEur: pick?.price ?? null,
      compareAtEur: pick?.compareAt ?? null,
      available: p.variants.length === 0 ? null : buyable.length > 0,
      tags: tagsOf(p.tags),
    })
  })
}

export const collectionSchema = z.object({
  handle: z.string(),
  title: z.string(),
  productsCount: z.int().nullable(),
})
export type Collection = z.infer<typeof collectionSchema>

const collectionsSchema = z.looseObject({
  collections: z.array(z.looseObject({ handle: z.string(), title: z.string(), products_count: z.number().nullish() })),
})

/** `/collections.json`: the store's collections. */
export function parseCollections(text: string): Collection[] {
  const data = strictOf(collectionsSchema, parseJson(text, 'the collection list'), 'the collection list')
  return data.collections.map((c) => ({ handle: c.handle, title: c.title, productsCount: c.products_count ?? null }))
}

// ---- one product -------------------------------------------------------------------------------------------------

const productJsSchema = z.looseObject({
  id,
  handle: z.string(),
  title: z.string(),
  vendor: z.string().nullish(),
  tags: z.union([z.array(z.string()), z.string()]).optional(),
  description: z.string().nullish(),
  variants: z.array(
    z.looseObject({
      id,
      title: z.string().nullish(),
      sku: z.string().nullish(),
      barcode: z.string().nullish(),
      available: z.boolean().nullish(),
      price: z.number(),
      compare_at_price: z.number().nullish(),
    }),
  ),
})

/**
 * The offer a suggest or feed entry gives: the store's cheapest buyable variant as one offer, for a lookup that needs no
 * second request. Shipping and totals follow `parseProductJs`: known only where the listing text says it is free.
 */
export function pageOfItem(item: ListingItem, host: string): ProductPage {
  const total = item.priceEur !== null && item.freeShipping === true ? item.priceEur : null
  const capacity = capacityOf(item.title)
  const offer: Offer = {
    shop: shopName(host),
    marketplace: false,
    priceEur: item.priceEur,
    shippingEur: item.freeShipping === true ? 0 : null,
    totalEur: total,
    totalEurNoPrepayment: total,
    rating: null,
    ratingCount: null,
    paymentMethods: [],
    prepaymentOnly: false,
    delivery:
      item.available === true ? 'in stock' : item.available === false ? 'unavailable' : 'availability not stated',
    inStock: item.available,
  }
  const product: Product = {
    source: shopifySource(host),
    id: item.id,
    url: item.url,
    name: item.title,
    mpn: null,
    gtin: item.gtin,
    memory:
      capacity?.modules && capacity.moduleGb && MEMORY_TITLE.test(item.title)
        ? { modules: capacity.modules, moduleGb: capacity.moduleGb, totalGb: capacity.totalGb }
        : null,
    offerCount: 1,
    dataTime: null,
    tags: item.tags,
    notes: item.notes,
    compareAtEur: item.compareAtEur,
    capacityGb: item.capacityGb,
    pricePerGbEur: item.pricePerGbEur,
  }
  return { product, offers: [offer] }
}

/** The words of a title or a variant code that may be a part number: split at whitespace, commas, brackets and slashes. */
const tokensOf = (text: string): string[] => text.split(/[\s,;()[\]/]+/).filter(Boolean)

/**
 * The product through `/products/<handle>.js`: one offer per variant. Shipping is a shop setting the storefront JSON does
 * not carry, so it is known only where the product's own text says it is free ("Kostenloser Versand", this shop's
 * listings): `shippingEur` is 0 then, and otherwise `shippingEur` and the totals are null, never a guess.
 */
export function parseProductJs(text: string, host: string): ProductPage & { skus: string[] } {
  const p = strictOf(productJsSchema, parseJson(text, 'the product'), 'the product')
  const title = cleanTitle(p.title)
  const tags = tagsOf(p.tags)
  const freeShipping = FREE_SHIPPING.test(p.description ?? '')
  const multiple = p.variants.length > 1
  const priced = p.variants.map((v) => eurOfCents(v.price))
  const buyable = p.variants.filter((v) => v.available === true)
  const headline = (buyable.length > 0 ? buyable : p.variants).map((v) => eurOfCents(v.price) ?? Infinity)
  const lowest = headline.length === 0 ? null : Math.min(...headline)
  const capacity = capacityOf(title)
  const first = p.variants[0]
  const offers: Offer[] = p.variants.map((v, i) => {
    const priceEur = priced[i] ?? null
    const total = priceEur !== null && freeShipping ? priceEur : null
    return {
      shop: shopName(host),
      marketplace: false,
      priceEur,
      shippingEur: freeShipping ? 0 : null,
      totalEur: total,
      totalEurNoPrepayment: total,
      rating: null,
      ratingCount: null,
      paymentMethods: [],
      prepaymentOnly: false,
      delivery: `${v.available === true ? 'in stock' : v.available === false ? 'unavailable' : 'availability not stated'}${multiple && v.title ? ` · ${v.title}` : ''}`,
      inStock: v.available ?? null,
    }
  })
  const product: Product = {
    source: shopifySource(host),
    id: String(p.id),
    url: `${origin(host)}/products/${p.handle}`,
    name: title,
    mpn: null,
    gtin: first?.barcode || null,
    memory:
      capacity?.modules && capacity.moduleGb && MEMORY_TITLE.test(title)
        ? { modules: capacity.modules, moduleGb: capacity.moduleGb, totalGb: capacity.totalGb }
        : null,
    offerCount: offers.length,
    dataTime: null,
    tags,
    notes: tagNotes(tags),
    compareAtEur: eurOfCents(first?.compare_at_price ?? null),
    capacityGb: capacity?.totalGb ?? null,
    pricePerGbEur: pricePerGb(lowest === Infinity ? null : lowest, capacity),
  }
  const skus = p.variants.flatMap((v) => [v.sku, v.barcode]).filter((s): s is string => !!s)
  return { product, offers, skus }
}

/** True when the title (as whole words) or a variant's SKU or barcode equals the part number, letters and digits, any case. */
export function namesPartNumber(args: { title: string; skus?: string[] }, wanted: string): boolean {
  const target = normMpn(wanted)
  if (!target) return false
  return [...tokensOf(args.title), ...(args.skus ?? [])].some((word) => normMpn(word) === target)
}
