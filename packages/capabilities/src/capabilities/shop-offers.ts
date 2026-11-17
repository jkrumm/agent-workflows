import { z } from 'zod'
import type { Ctx } from '../context.ts'
import { CapabilityError, fail } from '../errors.ts'
import { defineCapability } from '../procedure.ts'
import { isBlockedError, type ShopFetch } from './shop-fetch.ts'
import {
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
  parseIdealoSearch,
  type Product,
  productSchema,
  type ProductPage,
  type SearchPage,
} from './shop-offers-parse.ts'

/** Search, product and history pages are read at most once an hour per process: a price moves, a part number does not. */
const OFFERS_TTL_MS = 3_600_000

const sourceResultSchema = z.object({
  source: z.enum(OFFER_SOURCES),
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
    .describe('A manufacturer part number, or a product page URL on idealo.de or geizhals.de'),
  source: z
    .enum([...OFFER_SOURCES, 'all'])
    .default('idealo')
    .describe('Which comparison site to read: one request per page. `all` reads both; a URL names its own site'),
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
    .array(z.object({ source: z.enum(OFFER_SOURCES), code: z.string(), message: z.string() }))
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
} as const

const cheapestFirst = (a: Offer, b: Offer) =>
  (a.totalEur ?? Number.POSITIVE_INFINITY) - (b.totalEur ?? Number.POSITIVE_INFINITY)

const isUrl = (ref: string) => /^https?:\/\//i.test(ref)

/** The site a product page URL belongs to, or INVALID_INPUT. */
function sourceOfUrl(ref: string): OfferSource {
  for (const source of OFFER_SOURCES) if (SITES[source].productId(ref)) return source
  throw fail('INVALID_INPUT', `shop.offers: not an idealo.de or geizhals.de product page URL: ${ref.slice(0, 120)}`)
}

const notFound = (message: string) => fail('NOT_FOUND', `shop.offers: ${message}`)

/** The typed error of a page the site answered 404 for. */
export const isMissingPage = (error: unknown) =>
  error instanceof CapabilityError &&
  error.code === 'UPSTREAM_ERROR' &&
  (error.data as { status?: number } | undefined)?.status === 404

export interface ReadArgs {
  source: OfferSource
  /** A part number, or the product page URL of the site (a watch keeps it after the first search). */
  ref: string
  /** The part number the page must name: set with a URL; with a part number `ref` is the one. */
  expectMpn?: string
  history?: (typeof HISTORY_PERIODS)[number]
  fresh: boolean
}

/** The product page a search by part number leads to: its URL, and the page itself when the site redirected straight to it. */
async function locate(shop: ShopFetch, args: ReadArgs, ctx: PageCtx): Promise<{ url: string; landed?: ProductPage }> {
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
  const exact = search.candidates.find((c) => c.mpn !== null && normMpn(c.mpn) === wanted)
  if (exact) return { url: exact.url }
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
  const mpn = isUrl(args.ref) ? (args.expectMpn ?? null) : args.ref
  const { url, landed } = await locate(shop, args, ctx)
  let page = landed
  let cached = false
  let fetchedAt = new Date().toISOString()
  if (!page) {
    const read = await shop.page(
      {
        url,
        ttlMs: OFFERS_TTL_MS,
        fresh: args.fresh,
        label: `the ${args.source} product page`,
        parse: SITES[args.source].parseProduct,
      },
      ctx,
    )
    ;({ value: page, cached, fetchedAt } = read)
  }
  if (mpn !== null && (page.product.mpn === null || normMpn(page.product.mpn) !== normMpn(mpn)))
    throw notFound(`the ${args.source} page names part number ${page.product.mpn ?? 'none'}, not ${mpn}`)
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

/** Plain columns, no drawing characters: total, item, shipping, shop, rating, payment, delivery. */
function renderOffers(results: SourceResult[]): string {
  return results
    .map((r) => {
      const memory = describeMemory(r.product)
      const head = [
        `${r.product.name} [${r.source}]`,
        `part number ${r.product.mpn ?? 'not stated'}${r.product.gtin ? `, GTIN ${r.product.gtin}` : ''}`,
        ...(memory ? [`memory ${memory}`] : []),
        `${r.product.offerCount} offers (${r.offers.length} listed)`,
        ...(r.product.dataTime ? [`data from ${r.product.dataTime}`] : []),
        r.product.url,
      ].join('\n')
      const rows = r.offers.map((o) => [
        money(o.totalEur),
        money(o.priceEur),
        money(o.shippingEur),
        `${o.shop ?? '-'}${o.marketplace ? ' (marketplace)' : ''}`,
        o.rating === null ? '-' : `${o.rating} (${o.ratingCount ?? '?'})`,
        `${o.paymentMethods.join('/') || '-'}${o.prepaymentOnly ? ' [prepayment only]' : ''}`,
        clip(`${o.delivery ?? '-'}${o.inStock === false ? ' [unavailable]' : ''}`, 60),
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

/**
 * `shop.offers`: the offers for ONE exact product from idealo.de and/or geizhals.de, parsed in code (no model). Both
 * sites turn a plain client away, so every page is read in the research Chrome under the shop conduct.
 */
export const createShopOffers = (shop: ShopFetch) =>
  defineCapability({
    id: 'shop.offers',
    summary:
      'Offers for one exact product by part number or product URL from idealo.de and geizhals.de: total with shipping, shop, rating, payment, delivery, memory module count and size, optional price history; parsed in code, no model',
    input: offersInput,
    output: offersOutput,
    cli: { positional: ['product'], defaultFormat: 'plain', plainField: 'text' },
    async handler({ product, source, history, fresh }, ctx) {
      const sources: OfferSource[] = isUrl(product)
        ? [sourceOfUrl(product)]
        : source === 'all'
          ? [...OFFER_SOURCES]
          : [source]
      if (history && !sources.includes('idealo'))
        throw fail(
          'INVALID_INPUT',
          'shop.offers: --history reads the idealo price series; geizhals has none that is readable',
        )
      const results: SourceResult[] = []
      const failures: { source: OfferSource; error: unknown }[] = []
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
