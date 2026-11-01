import { z } from 'zod'
import { defineCapability } from '../procedure.ts'
import { SEARCH_TTL_MS, type ShopFetch } from './shop-fetch.ts'
import { AMAZON_ORIGIN, parseSearch, type SearchResult, searchResultSchema } from './shop-parse.ts'

export const searchInput = z.object({
  query: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .refine((query) => ![...query].some((c) => c.charCodeAt(0) < 32), { message: 'no control characters' })
    .describe('What to search for on amazon.de'),
  includeSponsored: z.boolean().default(false).describe('Keep the results marked as sponsored (dropped by default)'),
  limit: z.int().min(1).max(60).optional().describe('Return at most this many results, in page order'),
  fresh: z.boolean().default(false).describe('Read the page again even if this process read it within the last hour'),
})

export const searchOutput = z.object({
  query: z.string(),
  url: z.string().describe('The search page that was read'),
  results: z.array(searchResultSchema),
  total: z.int().describe('Result cards on the page, sponsored ones included'),
  excludedSponsored: z.int().describe('Sponsored cards left out of `results`'),
  cached: z.boolean(),
  fetchedAt: z.string(),
  table: z.string().describe('The results as a plain table, for `--format plain`'),
})

export function searchUrl(query: string): string {
  return `${AMAZON_ORIGIN}/s?k=${encodeURIComponent(query).replace(/%20/g, '+')}`
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

/** One line per result: position, ASIN, price, stars (reviews), title, URL. Plain columns, no drawing characters. */
export function renderTable(results: SearchResult[]): string {
  if (results.length === 0) return 'no results'
  const rows = results.map((r) => [
    String(r.position),
    r.asin,
    r.priceText ?? r.availability ?? '-',
    r.rating === null ? '-' : `${r.rating} (${r.reviewCount ?? '?'})`,
    `${clip(r.title, 70)}${r.sponsored ? ' [sponsored]' : ''}`,
    r.url,
  ])
  const header = ['#', 'ASIN', 'Price', 'Rating', 'Title', 'URL']
  const widths = header.map((h, c) => Math.max(h.length, ...rows.map((row) => row[c]!.length)))
  const line = (cells: string[]) =>
    cells
      .map((cell, c) => cell.padEnd(widths[c]!))
      .join('  ')
      .trimEnd()
  return [line(header), ...rows.map(line)].join('\n')
}

/**
 * `shop.search`: the amazon.de search page read once and parsed in code (no model): ASIN, title, price, rating, review
 * count, image and URL per card. The order is the page's, and a repeat inside the hour is the same cached page.
 */
export const createShopSearch = (shop: ShopFetch) =>
  defineCapability({
    id: 'shop.search',
    summary:
      'Search amazon.de and list the result cards (ASIN, title, price, rating, image, URL), parsed in code, no model',
    input: searchInput,
    output: searchOutput,
    cli: { positional: ['query'], defaultFormat: 'plain', plainField: 'table' },
    async handler({ query, includeSponsored, limit, fresh }, ctx) {
      const url = searchUrl(query)
      const page = await shop.page(
        { url, ttlMs: SEARCH_TTL_MS, fresh, label: 'the search page', parse: parseSearch },
        ctx,
      )
      const kept = includeSponsored ? page.value : page.value.filter((result) => !result.sponsored)
      const results = limit === undefined ? kept : kept.slice(0, limit)
      return {
        query,
        url,
        results,
        total: page.value.length,
        excludedSponsored: page.value.length - kept.length,
        cached: page.cached,
        fetchedAt: page.fetchedAt,
        table: renderTable(results),
      }
    },
  })
