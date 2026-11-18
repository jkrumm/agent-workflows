import { z } from 'zod'
import type { Ctx } from '../context.ts'
import { CapabilityError, fail } from '../errors.ts'
import { defineCapability } from '../procedure.ts'
import { isBlockedError, type ShopFetch } from './shop-fetch.ts'
import {
  alternateProductId,
  alternateSearchUrl,
  casekingProductId,
  casekingSearchUrl,
  mindfactoryProductId,
  mindfactorySearchUrl,
  parseAlternateProduct,
  parseAlternateSearch,
  parseCasekingProduct,
  parseCasekingSearch,
  parseMindfactoryProduct,
  parseMindfactorySearch,
} from './shop-direct-parse.ts'
import { readShopify } from './shop-shopify.ts'
import {
  isShopifySource,
  shopifyProductHandle,
  shopifyHost,
  SHOPIFY_HOSTS,
  shopifySource,
} from './shop-shopify-parse.ts'
import {
  AGGREGATORS,
  type AnySource,
  anySourceSchema,
  DIRECT_SHOPS,
  geizhalsProductId,
  geizhalsSearchUrl,
  HISTORY_PERIODS,
  type History,
  historySchema,
  idealoHistoryUrl,
  idealoProductId,
  idealoSearchUrl,
  normMpn,
  OFFER_SOURCES,
  type Offer,
  type OfferSource,
  offerSchema,
  parseGeizhalsProduct,
  parseGeizhalsSearch,
  parseIdealoHistory,
  parseIdealoProduct,
  pageNamesMpn,
  parseIdealoSearch,
  type Product,
  productSchema,
  type ProductPage,
  type SearchCandidate,
  type SearchPage,
} from './shop-offers-parse.ts'

/** Search, product and history pages are read at most once an hour per process: a price moves, a part number does not. */
const OFFERS_TTL_MS = 3_600_000

const sourceResultSchema = z.object({
  source: anySourceSchema,
  product: productSchema,
  offers: z.array(offerSchema).describe('The offers on the page read, cheapest total first'),
  lowestTotalEur: z.number().nullable().describe('The cheapest total with shipping among `offers`'),
  history: historySchema.nullable().describe('The price series when `--history` asked for one; idealo only'),
  cached: z.boolean(),
  fetchedAt: z.string(),
})
export type SourceResult = z.infer<typeof sourceResultSchema>

const offersInput = z.object({
  product: z
    .string()
    .trim()
    .min(1)
    .max(500)
    .describe('A manufacturer part number, or a product page URL on one of the sources'),
  source: z
    .string()
    .default('idealo')
    .describe(
      "Which site to read, one search page and one product page each: idealo, geizhals (price comparison, many shops per page), alternate, mindfactory, caseking (the shop's own page) or shopify:<host> (a Shopify store's own listing: shopify:www.it-veith.de). `all` reads idealo and geizhals (as it always did), `shops` the three tech shops, `everything` every fixed source (not the Shopify stores); a URL names its own site",
    ),
  history: z
    .enum(HISTORY_PERIODS)
    .optional()
    .describe('Also return the idealo price series for 3 months, 6 months or a year (one more read)'),
  fresh: z.boolean().default(false).describe('Read the pages again even if this process read them within the hour'),
})

const offersOutput = z.object({
  query: z.string(),
  results: z.array(sourceResultSchema),
  errors: z
    .array(z.object({ source: anySourceSchema, code: z.string(), message: z.string() }))
    .describe('Sources that could not answer while another did (`source: all`); a call that no source answers fails'),
  text: z.string().describe('The offers as plain text, for `--format plain`'),
})

type PageCtx = Pick<Ctx, 'signal' | 'addUsage'>

const SITES = {
  idealo: {
    searchUrl: idealoSearchUrl,
    parseSearch: parseIdealoSearch,
    parseProduct: parseIdealoProduct,
    productId: idealoProductId,
  },
  geizhals: {
    searchUrl: geizhalsSearchUrl,
    parseSearch: parseGeizhalsSearch,
    parseProduct: parseGeizhalsProduct,
    productId: geizhalsProductId,
  },
  alternate: {
    searchUrl: alternateSearchUrl,
    parseSearch: parseAlternateSearch,
    parseProduct: parseAlternateProduct,
    productId: alternateProductId,
  },
  mindfactory: {
    searchUrl: mindfactorySearchUrl,
    parseSearch: parseMindfactorySearch,
    parseProduct: parseMindfactoryProduct,
    productId: mindfactoryProductId,
  },
  caseking: {
    searchUrl: casekingSearchUrl,
    parseSearch: parseCasekingSearch,
    parseProduct: parseCasekingProduct,
    productId: casekingProductId,
  },
} as const

const cheapestFirst = (a: Offer, b: Offer) =>
  (a.totalEur ?? Number.POSITIVE_INFINITY) - (b.totalEur ?? Number.POSITIVE_INFINITY)

const isUrl = (ref: string) => /^https?:\/\//i.test(ref)

/** The site a product page URL belongs to, or INVALID_INPUT. */
function sourceOfUrl(ref: string): AnySource {
  for (const source of OFFER_SOURCES) if (SITES[source].productId(ref)) return source
  const store = shopifyProductHandle(ref)
  if (store) return shopifySource(store.host)
  throw fail(
    'INVALID_INPUT',
    `shop.offers: not a product page URL of ${[...OFFER_SOURCES, ...SHOPIFY_HOSTS.map(shopifySource)].join(', ')}: ${ref.slice(0, 120)}`,
  )
}

const notFound = (message: string) => fail('NOT_FOUND', `shop.offers: ${message}`)

/** The typed error of a page the site answered 404 for. */
export const isMissingPage = (error: unknown) =>
  error instanceof CapabilityError &&
  error.code === 'UPSTREAM_ERROR' &&
  (error.data as { status?: number } | undefined)?.status === 404

export interface ReadArgs {
  source: AnySource
  /** A part number, or the product page URL of the site (a watch keeps it after the first search). */
  ref: string
  /** The part number the page must name: set with a URL; with a part number `ref` is the one. */
  expectMpn?: string
  history?: (typeof HISTORY_PERIODS)[number]
  fresh: boolean
}

/** Product pages of an idealo search whose cards name no part number are read to look for it, at most this many (one request each). */
const MAX_PROBES = 2

interface Located {
  url: string
  /** The page itself when the site redirected straight to it. */
  landed?: ProductPage
  /** Product pages to read in order until one names the part number: the cards of a list that carry none (idealo SSDs, CPUs). */
  probes?: { url: string; name: string }[]
}

/** The product page a search by part number leads to: its URL, and the page itself when the site redirected straight to it. */
async function locate(shop: ShopFetch, args: ReadArgs & { source: OfferSource }, ctx: PageCtx): Promise<Located> {
  const site = SITES[args.source]
  if (isUrl(args.ref)) {
    if (!site.productId(args.ref)) throw fail('INVALID_INPUT', `shop.offers: not a ${args.source} product page URL`)
    return { url: args.ref }
  }
  let search: SearchPage
  try {
    const read = await shop.page(
      {
        url: site.searchUrl(args.ref),
        ttlMs: OFFERS_TTL_MS,
        fresh: args.fresh,
        label: `the ${args.source} search for ${args.ref}`,
        parse: site.parseSearch,
      },
      ctx,
    )
    search = read.value
  } catch (error) {
    if (isMissingPage(error)) throw notFound(`${args.source} lists no product for part number ${args.ref}`)
    throw error
  }
  if (search.kind === 'product') return { url: search.page.product.url, landed: search.page }
  const wanted = normMpn(args.ref)
  const named = (c: SearchCandidate) => [c.mpn, ...(c.tokens ?? [])].some((word) => word && normMpn(word) === wanted)
  const exact = search.candidates.find(named)
  if (exact) return { url: exact.url }
  // A shop whose search cards carry no part number (caseking, mindfactory): a search with exactly one hit is read, and the
  // product page's own part number, checked in `readSource`, decides. Several hits are not read one by one, and that is an
  // error, not "the shop does not list it": the product may be among them.
  const blind = search.candidates.filter((c) => c.mpnOnPage)
  if (blind.length === 1 && search.candidates.length === 1) return { url: blind[0]!.url }
  // idealo prints no part number in the name of an SSD or a CPU, so no card can equal it. The search ranks the product that
  // carries it first, so the first cards without a part number are read and the product page's offer titles decide.
  const probes = search.candidates
    .filter((c) => c.probe)
    .map((c) => ({ url: c.url, name: c.name }))
    .slice(0, MAX_PROBES)
  if (probes.length > 0) return { url: probes[0]!.url, probes }
  if (blind.length > 1)
    throw fail(
      'UPSTREAM_ERROR',
      `shop.offers: the ${args.source} search for ${args.ref} lists ${blind.length} products with no part number on the card; none was read`,
      {},
    )
  const near = search.candidates
    .slice(0, 5)
    .map((c) => c.mpn ?? c.name)
    .join(', ')
  throw notFound(`${args.source} has no product with part number ${args.ref}${near ? ` (near misses: ${near})` : ''}`)
}

/**
 * One site's offers for ONE exact product. A search by part number only ever yields the product whose part number equals
 * the one asked (letters and digits, any case); the product page's own part number is checked again. No equal part
 * number is NOT_FOUND, with the near misses named, never a similar product (a 2 x 16 GB kit for a 2 x 32 GB question).
 */
export async function readSource(shop: ShopFetch, args: ReadArgs, ctx: PageCtx): Promise<SourceResult> {
  if (isShopifySource(args.source)) return readShopify(shop, { ...args, source: args.source }, ctx)
  return readFixedSource(shop, { ...args, source: args.source }, ctx)
}

async function readFixedSource(
  shop: ShopFetch,
  args: ReadArgs & { source: OfferSource },
  ctx: PageCtx,
): Promise<SourceResult> {
  const mpn = isUrl(args.ref) ? (args.expectMpn ?? null) : args.ref
  const located = await locate(shop, args, ctx)
  const tries = located.probes ?? [{ url: located.url, name: '' }]
  let page: ProductPage | undefined
  let cached = false
  let fetchedAt = new Date().toISOString()
  const read: ProductPage[] = []
  for (const [index, candidate] of tries.entries()) {
    const got =
      located.landed && index === 0
        ? { value: located.landed, cached: false, fetchedAt }
        : await shop.page(
            {
              url: candidate.url,
              ttlMs: OFFERS_TTL_MS,
              fresh: args.fresh,
              label: `the ${args.source} product page`,
              parse: SITES[args.source].parseProduct,
            },
            ctx,
          )
    read.push(got.value)
    if (mpn === null || pageNamesMpn(got.value, mpn)) {
      ;({ value: page, cached, fetchedAt } = got)
      break
    }
  }
  if (!page) {
    if (!located.probes)
      throw notFound(`the ${args.source} page names part number ${read[0]!.product.mpn ?? 'none'}, not ${mpn}`)
    throw notFound(
      `${args.source} has no product with part number ${mpn} (the first ${read.length} search hits without a part number were read and their offer titles do not name it: ${read.map((p) => p.product.name).join(', ')})`,
    )
  }
  // The page names no part number of its own: the offers' titles named the one asked, and the output says so.
  if (mpn !== null && page.product.mpn === null)
    page = { ...page, product: { ...page.product, mpn, mpnBasis: 'offer titles' } }
  const history = args.history && args.source === 'idealo' ? await readHistory(shop, page.product.id, args, ctx) : null
  const offers = [...page.offers].sort(cheapestFirst)
  const totals = offers.map((o) => o.totalEur).filter((t): t is number => t !== null)
  return {
    source: args.source,
    product: page.product,
    offers,
    lowestTotalEur: totals.length === 0 ? null : Math.min(...totals),
    history,
    cached,
    fetchedAt,
  }
}

async function readHistory(shop: ShopFetch, id: string, args: ReadArgs, ctx: PageCtx): Promise<History> {
  const period = args.history!
  const read = await shop.page(
    {
      url: idealoHistoryUrl(id, period),
      ttlMs: OFFERS_TTL_MS,
      fresh: args.fresh,
      label: 'the idealo price history',
      parse: (html) => parseIdealoHistory(html, period),
    },
    ctx,
  )
  return read.value
}

const money = (n: number | null) => (n === null ? '-' : n.toFixed(2).replace('.', ','))
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

/** "2 x 16 GB (32 GB)" for a memory kit; "capacity not stated" when the product reads like memory and the page gives none. */
function describeMemory(product: Product): string | null {
  if (product.memory) {
    const { modules, moduleGb, totalGb } = product.memory
    return `${modules} x ${moduleGb} GB (${totalGb} GB)`
  }
  return /\bDDR\d|\bDIMM\b|\bRAM\b|Arbeitsspeicher/i.test(product.name) ? 'capacity not stated on the page' : null
}

/** What a Shopify store's listing adds: capacity and price per GB, the struck-through price, the tags and what they mean, other listings. */
function storeFacts(product: Product): string[] {
  const perGb = product.pricePerGbEur == null ? null : product.pricePerGbEur.toFixed(3).replace('.', ',')
  const facts = [
    product.capacityGb == null ? null : `capacity ${product.capacityGb} GB${perGb ? `, ${perGb} EUR/GB` : ''}`,
    product.compareAtEur == null ? null : `compare-at price ${money(product.compareAtEur)}`,
    product.tags && product.tags.length > 0 ? `tags ${product.tags.join(', ')}` : null,
    ...(product.notes ?? []).map((note) => `note: ${note}`),
  ]
  return facts.filter((f): f is string => f !== null)
}

/** Plain columns, no drawing characters: total, item, shipping, shop, rating, payment, delivery. */
function renderOffers(results: SourceResult[]): string {
  return results
    .map((r) => {
      const memory = describeMemory(r.product)
      const head = [
        `${r.product.name} [${r.source}]`,
        `part number ${r.product.mpn ?? 'not stated'}${r.product.mpnBasis ? ' (named in the offer titles)' : ''}${r.product.gtin ? `, GTIN ${r.product.gtin}` : ''}`,
        ...(memory ? [`memory ${memory}`] : []),
        `${r.product.offerCount} offers (${r.offers.length} listed)`,
        ...(r.product.dataTime ? [`data from ${r.product.dataTime}`] : []),
        ...storeFacts(r.product),
        r.product.url,
      ].join('\n')
      const rows = r.offers.map((o) => [
        money(o.totalEur),
        money(o.priceEur),
        money(o.shippingEur),
        `${o.shop ?? '-'}${o.marketplace ? ' (marketplace)' : ''}`,
        o.rating === null ? '-' : `${o.rating} (${o.ratingCount ?? '?'})`,
        `${o.paymentMethods.join('/') || '-'}${o.prepaymentOnly ? ' [prepayment only]' : ''}`,
        `${clip(o.delivery ?? '-', 60)}${o.inStock === false ? ' [unavailable]' : ''}`,
      ])
      const header = ['Total', 'Item', 'Ship', 'Shop', 'Rating', 'Payment', 'Delivery']
      const widths = header.map((h, c) => Math.max(h.length, ...rows.map((row) => row[c]!.length)))
      const line = (cells: string[]) =>
        cells
          .map((cell, c) => cell.padEnd(widths[c]!))
          .join('  ')
          .trimEnd()
      const history = r.history
        ? `\nhistory ${r.history.period}: ${r.history.points.length} days, low ${money(r.history.lowestEur)}, avg ${money(r.history.averageEur)}, high ${money(r.history.highestEur)}`
        : ''
      return [head, line(header), ...rows.map(line)].join('\n') + history
    })
    .join('\n\n')
}

/** The sources a call reads: a URL names its own; `all`, `shops` and `everything` are groups; else one listed source. */
function sourcesOf(product: string, source: string): AnySource[] {
  if (isUrl(product)) return [sourceOfUrl(product)]
  if (source === 'everything') return [...OFFER_SOURCES]
  if (source === 'all') return [...AGGREGATORS]
  if (source === 'shops') return [...DIRECT_SHOPS]
  if ((OFFER_SOURCES as readonly string[]).includes(source)) return [source as OfferSource]
  if (shopifyHost(source)) return [source as AnySource]
  throw fail(
    'INVALID_INPUT',
    `shop.offers: unknown source ${source}; use ${[...OFFER_SOURCES, 'all', 'shops', 'everything', ...SHOPIFY_HOSTS.map(shopifySource)].join(', ')}`,
  )
}

/**
 * `shop.offers`: the offers for ONE exact product from idealo.de, geizhals.de and the tech shops, parsed in code (no
 * model). Every page is read under the shop conduct, in the research Chrome where the host turns a plain client away.
 */
export const createShopOffers = (shop: ShopFetch) =>
  defineCapability({
    id: 'shop.offers',
    summary:
      'Offers for one exact product by part number or product URL from idealo.de and geizhals.de (many shops per page), from the tech shops Alternate, Mindfactory and Caseking (their own price) and from a listed Shopify store (shopify:www.it-veith.de: price, availability, tags, capacity and price per GB): total with shipping, shop, rating, payment, delivery, memory module count and size, optional idealo price history; parsed in code, no model',
    input: offersInput,
    output: offersOutput,
    cli: { positional: ['product'], defaultFormat: 'plain', plainField: 'text' },
    async handler({ product, source, history, fresh }, ctx) {
      const sources = sourcesOf(product, source)
      if (history && !sources.includes('idealo'))
        throw fail(
          'INVALID_INPUT',
          'shop.offers: --history reads the idealo price series; geizhals has none that is readable',
        )
      const results: SourceResult[] = []
      const failures: { source: AnySource; error: unknown }[] = []
      for (const one of sources) {
        try {
          results.push(await readSource(shop, { source: one, ref: product, history, fresh }, ctx))
        } catch (error) {
          if (sources.length === 1 || ctx.signal.aborted) throw error
          failures.push({ source: one, error })
        }
      }
      if (results.length === 0) throw (failures.find((f) => isBlockedError(f.error)) ?? failures[0])!.error
      return {
        query: product,
        results,
        errors: failures.map(({ source: s, error }) => ({
          source: s,
          code: error instanceof CapabilityError ? error.code : 'UPSTREAM_ERROR',
          message: error instanceof Error ? error.message : String(error),
        })),
        text: renderOffers(results),
      }
    },
  })
