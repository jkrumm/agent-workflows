import { z } from 'zod'
import type { Ctx } from '../context.ts'
import { fail } from '../errors.ts'
import { defineCapability } from '../procedure.ts'
import type { ShopFetch } from './shop-fetch.ts'
import type { ReadArgs, SourceResult } from './shop-offers.ts'
import type { ProductPage } from './shop-offers-parse.ts'
import {
  type Collection,
  collectionFeedUrl,
  collectionSchema,
  collectionsUrl,
  type ListingItem,
  listingItemSchema,
  namesPartNumber,
  pageOfItem,
  parseCollectionFeed,
  parseCollections,
  parseProductJs,
  parseSuggest,
  productJsUrl,
  SHOPIFY_HOSTS,
  type ShopifySource,
  shopifyHost,
  shopifyProductHandle,
  shopifySource,
  suggestUrl,
  titleMatches,
} from './shop-shopify-parse.ts'

// Shopify storefronts (first www.it-veith.de) through the JSON endpoints every store serves without a key: a search by
// part number (`/search/suggest.json`, then `/products/<handle>.js`), the store's collections and one collection's product
// feed. Conduct as the other shops (docs/shop.md §Conduct): one request per page through the shared fetcher, a wall ends
// the call as `blocked (<reason>)`, no retry, no HTML where JSON answers.

/** Pages are read at most once an hour per process, as the other offers pages. */
const TTL_MS = 3_600_000
/** The suggest endpoint never returns more than ten products. */
const SUGGEST_MAX = 10

type PageCtx = Pick<Ctx, 'signal' | 'addUsage'>

/** The store host of a `shopify:<host>` source, or INVALID_INPUT naming the stores that are listed. */
export function requireShopifyHost(source: string, door: string): string {
  const host = shopifyHost(source)
  if (host) return host
  throw fail(
    'INVALID_INPUT',
    `${door}: ${source} is not a listed Shopify store; the listed stores are ${SHOPIFY_HOSTS.map(shopifySource).join(', ')}`,
  )
}

const notFound = (message: string) => fail('NOT_FOUND', `shop.offers: ${message}`)
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

/**
 * One Shopify store's offer for ONE exact part number. By part number it is ONE request: the suggest endpoint lists the
 * listing whose title names it as a whole word, with price, availability, tags and the listing text (EAN, "Kostenloser
 * Versand"), which is all an offer needs. By product page URL it is the product's `/products/<handle>.js` (variants, one
 * offer each, SKUs and barcodes), and the page's title, SKUs or barcodes are checked against the part number the caller
 * expects. No equal part number is NOT_FOUND with the near misses, never a similar product.
 */
export async function readShopify(
  shop: ShopFetch,
  args: ReadArgs & { source: ShopifySource },
  ctx: PageCtx,
): Promise<SourceResult> {
  const host = requireShopifyHost(args.source, 'shop.offers')
  const isUrl = /^https?:\/\//i.test(args.ref)
  const mpn = isUrl ? (args.expectMpn ?? null) : args.ref.trim()
  let page: ProductPage
  let others: ListingItem[] = []
  let cached: boolean
  let fetchedAt: string
  if (isUrl) {
    const parsed = shopifyProductHandle(args.ref)
    if (!parsed || parsed.host !== host)
      throw fail('INVALID_INPUT', `shop.offers: not a ${args.source} product page URL: ${args.ref.slice(0, 120)}`)
    const read = await shop.page(
      {
        url: productJsUrl(host, parsed.handle),
        ttlMs: TTL_MS,
        fresh: args.fresh,
        label: `the ${args.source} product page`,
        parse: (text) => parseProductJs(text, host),
      },
      ctx,
    )
    if (mpn !== null && !namesPartNumber({ title: read.value.product.name, skus: read.value.skus }, mpn))
      throw notFound(`the ${args.source} page does not name part number ${mpn}`)
    ;({ cached, fetchedAt } = read)
    page = read.value
  } else {
    const search = await shop.page(
      {
        url: suggestUrl(host, mpn!, SUGGEST_MAX),
        ttlMs: TTL_MS,
        fresh: args.fresh,
        label: `the ${args.source} search for ${mpn}`,
        parse: (text) => parseSuggest(text, host),
      },
      ctx,
    )
    const matches = search.value
      .filter((item) => namesPartNumber({ title: item.title }, mpn!))
      .sort(
        (a, b) =>
          Number(b.available === true) - Number(a.available === true) ||
          (a.priceEur ?? Infinity) - (b.priceEur ?? Infinity),
      )
    const best = matches[0]
    if (!best) {
      const near = search.value
        .slice(0, 5)
        .map((i) => clip(i.title, 60))
        .join(' | ')
      throw notFound(`${args.source} has no product with part number ${mpn}${near ? ` (near misses: ${near})` : ''}`)
    }
    others = matches.slice(1, 4)
    ;({ cached, fetchedAt } = search)
    page = pageOfItem(best, host)
  }
  const notes = [
    ...(page.product.notes ?? []),
    ...(others.length > 0
      ? [`${others.length} more listing(s) of this part number: ${others.map((o) => o.url).join(' ')}`]
      : []),
  ]
  const totals = page.offers.map((o) => o.totalEur).filter((t): t is number => t !== null)
  return {
    source: args.source,
    product: { ...page.product, mpn, notes },
    offers: [...page.offers].sort(
      (a, b) => (a.totalEur ?? a.priceEur ?? Infinity) - (b.totalEur ?? b.priceEur ?? Infinity),
    ),
    lowestTotalEur: totals.length === 0 ? null : Math.min(...totals),
    history: null,
    cached,
    fetchedAt,
  }
}

// ---- listing -----------------------------------------------------------------------------------------------------

export interface StoreFilter {
  /** Title words: `|` separates alternatives, the words of one alternative must all appear. */
  contains?: string
  maxPriceEur?: number
  maxPricePerGbEur?: number
  availableOnly?: boolean
}

/** The items a filter keeps. A price filter drops an item with no price (or no capacity for a per-GB ceiling): nothing is guessed. */
export function filterItems(items: ListingItem[], filter: StoreFilter): ListingItem[] {
  return items.filter(
    (i) =>
      titleMatches(i.title, filter.contains) &&
      (!filter.availableOnly || i.available === true) &&
      (filter.maxPriceEur === undefined || (i.priceEur !== null && i.priceEur <= filter.maxPriceEur)) &&
      (filter.maxPricePerGbEur === undefined ||
        (i.pricePerGbEur !== null && i.pricePerGbEur <= filter.maxPricePerGbEur)),
  )
}

export interface ListingRead {
  items: ListingItem[]
  /** A full last page: the collection has more products than were read. */
  hasMore: boolean
  cached: boolean
}

/** One collection's products (`/collections/<handle>/products.json`, `pages` pages of `limit`) or the suggest hits of a query. */
export async function readListing(
  shop: ShopFetch,
  args: { host: string; collection?: string; query?: string; pages: number; limit: number; fresh: boolean },
  ctx: PageCtx,
): Promise<ListingRead> {
  const { host, fresh } = args
  if (args.query !== undefined) {
    const read = await shop.page(
      {
        url: suggestUrl(host, args.query, Math.min(args.limit, SUGGEST_MAX)),
        ttlMs: TTL_MS,
        fresh,
        label: `the ${host} search for ${args.query}`,
        parse: (text) => parseSuggest(text, host),
      },
      ctx,
    )
    return { items: read.value, hasMore: read.value.length >= Math.min(args.limit, SUGGEST_MAX), cached: read.cached }
  }
  const collection = args.collection!
  const items: ListingItem[] = []
  let hasMore = false
  let cached = true
  for (let page = 1; page <= args.pages; page++) {
    const read = await shop.page(
      {
        url: collectionFeedUrl(host, collection, args.limit, page),
        ttlMs: TTL_MS,
        fresh,
        label: `the ${host} collection ${collection} page ${page}`,
        parse: (text) => parseCollectionFeed(text, host),
      },
      ctx,
    )
    cached &&= read.cached
    items.push(...read.value)
    hasMore = read.value.length >= args.limit
    if (!hasMore) break
  }
  return { items, hasMore, cached }
}

const listingInput = z.object({
  source: z
    .string()
    .default(shopifySource(SHOPIFY_HOSTS[0]))
    .describe(`The store as shopify:<host>; listed: ${SHOPIFY_HOSTS.map(shopifySource).join(', ')}`),
  collection: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      "A collection handle: the store's product feed of it, newest page first. Omit both `collection` and `query` to list the collections",
    ),
  query: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("The store's own search (at most 10 products): what the feed cannot give when the store closes it"),
  contains: z
    .string()
    .optional()
    .describe('Keep products whose title has every word of one alternative; `|` separates alternatives ("DDR5|NVMe")'),
  maxPricePerGb: z
    .number()
    .positive()
    .optional()
    .describe('Keep products whose price per GB (from the title) is at or under this, EUR'),
  maxPrice: z.number().positive().optional().describe('Keep products at or under this price, EUR'),
  availableOnly: z.boolean().default(false).describe('Keep products that can be bought now'),
  pages: z
    .int()
    .min(1)
    .max(5)
    .default(1)
    .describe('Pages of `limit` products to read from a collection, one request each'),
  limit: z.int().min(1).max(250).default(250).describe('Products per page'),
  fresh: z.boolean().default(false).describe('Read the pages again even if this process read them within the hour'),
})

const listingOutput = z.object({
  source: z.string(),
  mode: z.enum(['collections', 'collection', 'query']),
  collections: z.array(collectionSchema).describe("The store's collections (mode `collections`)"),
  items: z.array(listingItemSchema).describe('The products that passed the filters'),
  read: z.int().describe('Products read before the filters'),
  hasMore: z.boolean().describe('The last page read was full: the collection has more products'),
  cached: z.boolean(),
  text: z.string(),
})

const money = (n: number | null, digits = 2) => (n === null ? '-' : n.toFixed(digits).replace('.', ','))

function renderItems(items: ListingItem[]): string {
  const header = ['Price', 'EUR/GB', 'Avail', 'Title', 'Tags', 'URL']
  const rows = items.map((i) => [
    money(i.priceEur),
    money(i.pricePerGbEur, 3),
    i.available === null ? '-' : i.available ? 'yes' : 'no',
    clip(i.title, 72),
    i.tags.filter((t) => !t.startsWith('spreadr-')).join(','),
    i.url,
  ])
  const widths = header.map((h, c) => Math.max(h.length, ...rows.map((r) => r[c]!.length)))
  const line = (cells: string[]) =>
    cells
      .map((cell, c) => cell.padEnd(widths[c]!))
      .join('  ')
      .trimEnd()
  return [line(header), ...rows.map(line)].join('\n')
}

/**
 * `shop.store`: what a listed Shopify store sells, without a part number. Its collections, one collection's products or
 * the store's own search, each with price, availability, tags and the price per GB read from the title; filters keep the
 * products a buyer wants (title words, a ceiling per GB).
 */
export const createShopStore = (shop: ShopFetch) =>
  defineCapability({
    id: 'shop.store',
    summary:
      "What a listed Shopify store (shopify:www.it-veith.de) sells: its collections, one collection's products or the store's own search, with price, availability, tags and the price per GB read from the title, optionally filtered by title words and a price ceiling; read from the store's JSON endpoints, no model",
    input: listingInput,
    output: listingOutput,
    cli: { defaultFormat: 'plain', plainField: 'text' },
    async handler(input, ctx) {
      const host = requireShopifyHost(input.source, 'shop.store')
      if (input.collection !== undefined && input.query !== undefined)
        throw fail('INVALID_INPUT', 'shop.store: give a collection or a query, not both')
      const base = { source: input.source, collections: [] as Collection[] }
      if (input.collection === undefined && input.query === undefined) {
        const read = await shop.page(
          {
            url: collectionsUrl(host),
            ttlMs: TTL_MS,
            fresh: input.fresh,
            label: `the ${host} collection list`,
            parse: parseCollections,
          },
          ctx,
        )
        const text = read.value.map((c) => `${c.handle}  ${c.productsCount ?? '?'}  ${c.title}`).join('\n')
        return {
          ...base,
          mode: 'collections' as const,
          collections: read.value,
          items: [],
          read: 0,
          hasMore: false,
          cached: read.cached,
          text,
        }
      }
      const listing = await readListing(
        shop,
        {
          host,
          collection: input.collection,
          query: input.query,
          pages: input.pages,
          limit: input.limit,
          fresh: input.fresh,
        },
        ctx,
      )
      const items = filterItems(listing.items, {
        contains: input.contains,
        maxPriceEur: input.maxPrice,
        maxPricePerGbEur: input.maxPricePerGb,
        availableOnly: input.availableOnly,
      })
      const summary = `${items.length} of ${listing.items.length} products${listing.hasMore ? ' (more on later pages)' : ''}`
      return {
        ...base,
        mode: input.collection === undefined ? ('query' as const) : ('collection' as const),
        items,
        read: listing.items.length,
        hasMore: listing.hasMore,
        cached: listing.cached,
        text: `${renderItems(items)}\n${summary}`,
      }
    },
  })
