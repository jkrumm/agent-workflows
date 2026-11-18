import { z } from 'zod'
import { fail } from '../errors.ts'
import { defineCapability } from '../procedure.ts'
import type { ReadCount } from './shop-budget.ts'
import type { ShopFetch } from './shop-fetch.ts'
import {
  type CategoryPage,
  categoryPageUrl,
  type Facet,
  facetSchema,
  idealoCategory,
  LIST_SORTS,
  type ListedProduct,
  listedProductSchema,
  parseIdealoCategory,
} from './shop-list-parse.ts'

/** A category page is read at most once an hour per process, like the offers pages: a price moves, a class does not. */
const LIST_TTL_MS = 3_600_000
const HOST = 'www.idealo.de'
/** More pages than this is a crawl, not a shopping list; each page is one more request to the host. */
const MAX_PAGES = 5

const listInput = z.object({
  url: z
    .string()
    .trim()
    .min(1)
    .max(500)
    .describe(
      'An idealo.de category page URL with its filters, as the site shows it: https://www.idealo.de/preisvergleich/ProductCategory/<id>[F<filters>].html (page 1, no page suffix; a query string is dropped)',
    ),
  sort: z
    .enum(LIST_SORTS)
    .default('popularity')
    .describe(
      'popularity (idealo default), price (lowest price first) or base-price (lowest price per GB first, SSDs)',
    ),
  pages: z
    .int()
    .min(1)
    .max(MAX_PAGES)
    .default(1)
    .describe('How many category pages to read, 36 products each; every page is one more request to idealo'),
  fresh: z.boolean().default(false).describe('Read the pages again even if this process read them within the hour'),
})

const pageSchema = z.object({
  page: z.int(),
  url: z.string(),
  cached: z.boolean(),
  fetchedAt: z.string(),
  products: z.int().describe('Products kept from this page'),
  dropped: z
    .object({ sponsored: z.int(), used: z.int(), other: z.int() })
    .describe('Cards that are no product page: ads, used offers, cards with no link'),
})

const listOutput = z.object({
  url: z.string().describe('The category page as given (page 1, no query)'),
  sort: z.enum(LIST_SORTS),
  category: z.object({
    id: z.string(),
    title: z.string().nullable().describe('The page heading, e.g. "48 GB DDR5-RAM"'),
    totalProducts: z.int().nullable().describe('The product count the heading shows, for the whole category'),
    pageCount: z.int().nullable(),
  }),
  pages: z.array(pageSchema),
  products: z.array(listedProductSchema),
  facets: z.array(facetSchema).describe("The filter options with idealo's counts, from page 1"),
  stopped: z.string().nullable().describe('Why fewer pages than asked were read; null when all were'),
  requests: z.int().describe('Pages this call read over the network (a cache hit sends nothing)'),
  reads: z
    .object({ host: z.string(), day: z.string(), count: z.int(), cap: z.int().nullable() })
    .nullable()
    .describe('Reads of idealo today over the network, with the daily cap (a call past it is refused)'),
  text: z.string().describe('The products as plain text, for `--format plain`'),
})
export type ShopListOutput = z.infer<typeof listOutput>

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)
const money = (n: number | null) => (n === null ? '-' : n.toFixed(2).replace('.', ','))
const num = (n: number | null) => (n === null ? '?' : String(n))

/** The parsed fields of a product in one short cell. */
function specCell(p: ListedProduct): string {
  if (p.memory) {
    const m = p.memory
    return [
      m.modules === null || m.gbPerModule === null ? null : `${m.modules}x${m.gbPerModule}`,
      m.totalGb === null ? null : `${m.totalGb} GB`,
      m.speedMts === null ? null : `${m.speedMts}`,
      m.cl === null ? null : `CL${m.cl}`,
    ]
      .filter(Boolean)
      .join(' ')
  }
  if (p.ssd) {
    const s = p.ssd
    return [
      s.capacityGb === null ? null : `${s.capacityGb} GB`,
      s.pcieGen === null ? (s.sata ? 'SATA' : null) : `PCIe${s.pcieGen}x${s.pcieLanes ?? '?'}`,
      s.readMBs === null ? null : `${s.readMBs}/${s.writeMBs ?? '?'} MB/s`,
      s.tbw === null ? null : `${s.tbw} TBW`,
      s.nand,
      s.heatsink ? 'heatsink' : null,
    ]
      .filter(Boolean)
      .join(' ')
  }
  return clip(p.specText, 70)
}

function renderFacets(facets: Facet[]): string[] {
  return facets.map((f) => {
    const shown = f.options.slice(0, 12).map((o) => `${o.label}${o.selected ? '*' : ''} ${num(o.count)}`)
    return `${f.name}: ${shown.join(', ')}${f.options.length > 12 ? `, +${f.options.length - 12}` : ''}`
  })
}

function render(out: Omit<ShopListOutput, 'text'>): string {
  const kind = { variant: 'variant', parent: 'parent', unknown: '-' } as const
  const head = [
    `${out.category.title ?? 'category'} (${out.category.totalProducts ?? '?'} products, ${out.category.pageCount ?? '?'} pages), sort ${out.sort}`,
    `read ${out.pages.length} page${out.pages.length === 1 ? '' : 's'}, ${out.requests} request${out.requests === 1 ? '' : 's'}${out.stopped ? `; stopped: ${out.stopped}` : ''}`,
    out.reads
      ? `reads of ${out.reads.host} on ${out.reads.day}: ${out.reads.count}${out.reads.cap === null ? '' : ` of ${out.reads.cap}`}`
      : null,
  ].filter((line): line is string => line !== null)
  const header = ['#', 'Kind', 'Name', 'Part number', 'Spec', 'Offers', 'From', 'EUR/GB', 'URL']
  const rows = out.products.map((p) => [
    String(p.position),
    kind[p.kind],
    clip(p.name, 56),
    p.mpn ?? '-',
    specCell(p),
    num(p.offerCount),
    money(p.lowestPriceEur),
    p.pricePerGbEur === null ? '-' : p.pricePerGbEur.toFixed(3).replace('.', ','),
    p.url,
  ])
  const widths = header.map((h, c) => Math.max(h.length, ...rows.map((row) => row[c]!.length)))
  const line = (cells: string[]) =>
    cells
      .map((cell, c) => cell.padEnd(widths[c]!))
      .join('  ')
      .trimEnd()
  return [
    ...head,
    '',
    line(header),
    ...rows.map(line),
    ...(out.facets.length > 0 ? ['', 'Facets (page 1, * = applied):', ...renderFacets(out.facets)] : []),
  ].join('\n')
}

/**
 * `shop.list`: the products of ONE idealo category page with its filters (and, on request, the next pages), parsed in code, no
 * model. Each page is read under the shop conduct in the research Chrome, one request, counted against idealo's daily budget.
 */
export const createShopList = (shop: ShopFetch) =>
  defineCapability({
    id: 'shop.list',
    summary:
      'List the products of one idealo.de category page with its filters (a whole class: every DDR5 kit with 2 x 24 GB, every 2 TB M.2 SSD): name, part number, product URL, spec line and parsed fields, offer count, lowest price, idealo price per GB, variant or parent, plus the facet counts; parsed in code, no model, one request per page, counted against a daily cap',
    input: listInput,
    output: listOutput,
    cli: { positional: ['url'], defaultFormat: 'plain', plainField: 'text' },
    async handler({ url, sort, pages, fresh }, ctx) {
      const category = idealoCategory(url)
      if (!category)
        throw fail(
          'INVALID_INPUT',
          `shop.list: not an idealo category page URL (https://www.idealo.de/preisvergleich/ProductCategory/<id>[F<filters>].html, page 1): ${url.slice(0, 120)}`,
        )
      const read: { page: number; url: string; cached: boolean; fetchedAt: string; data: CategoryPage }[] = []
      const products: ListedProduct[] = []
      const seen = new Set<string>()
      let stopped: string | null = null
      for (let index = 0; index < pages; index++) {
        const first = read[0]?.data
        if (first?.pageCount != null && index >= first.pageCount) {
          stopped = `the category has ${first.pageCount} page${first.pageCount === 1 ? '' : 's'}`
          break
        }
        const pageUrl = categoryPageUrl(category, sort, index)
        const got = await shop.page(
          {
            url: pageUrl,
            ttlMs: LIST_TTL_MS,
            fresh,
            label: `the idealo category page ${index + 1}`,
            parse: parseIdealoCategory,
          },
          ctx,
        )
        const kept = got.value.products.filter((p) => !seen.has(p.id))
        if (index > 0 && kept.length === 0) {
          stopped = `page ${index + 1} listed no product that was not on an earlier page`
          break
        }
        for (const p of kept) {
          seen.add(p.id)
          products.push({ ...p, position: products.length + 1, page: index + 1 })
        }
        read.push({ page: index + 1, url: pageUrl, cached: got.cached, fetchedAt: got.fetchedAt, data: got.value })
      }
      const first = read[0]!.data
      const counted: ReadCount | null = (await shop.reads(HOST)) ?? null
      const out = {
        url: category.base,
        sort,
        category: {
          id: category.id,
          title: first.title,
          totalProducts: first.totalProducts,
          pageCount: first.pageCount,
        },
        pages: read.map((r) => ({
          page: r.page,
          url: r.url,
          cached: r.cached,
          fetchedAt: r.fetchedAt,
          products: products.filter((p) => p.page === r.page).length,
          dropped: r.data.dropped,
        })),
        products,
        facets: first.facets,
        stopped,
        requests: read.filter((r) => !r.cached).length,
        reads: counted && { host: counted.host, day: counted.day, count: counted.count, cap: counted.cap },
      }
      return { ...out, text: render(out) }
    },
  })
