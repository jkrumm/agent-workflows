import { z } from 'zod'
import { decode, elementEnd, parsePrice, textOf } from './shop-parse.ts'

// The category-page parser of idealo.de: a pure function from the HTML string of a `ProductCategory` page (as the research
// Chrome rendered it) to the product cards on it, their parsed spec lines and the page's facet counts. No network, no model,
// no clock. Every selector is a `data-testid` read off real pages (`fixtures/shop/idealo-category-*`, provenance in
// `docs/shop.md`); a field the card does not carry is `null`, never a guess.

const IDEALO_ORIGIN = 'https://www.idealo.de'

// ---- URLs ---------------------------------------------------------------------------------------------------------

/** `<category id>[F<filter ids>]`: the opaque part of a category URL, taken as given (the filter id is idealo's, never built here). */
const CATEGORY_PATH = /^\/preisvergleich\/ProductCategory\/(\d+)(F[\d-]+)?\.html$/

export const LIST_SORTS = ['popularity', 'price', 'base-price'] as const
export type ListSort = (typeof LIST_SORTS)[number]

/** idealo's `?sortKey=` of each sort (read off the page's own sort box, 2026-11-18); the default order has none. */
const SORT_KEYS: Record<ListSort, string | null> = {
  popularity: null,
  price: 'minPrice',
  'base-price': 'sortMinBasePrice',
}

/**
 * idealo's page suffix: page `n` (0-based) of a category is `<category>I16-<15 n>.html` (read off the page's own paging,
 * 2026-11-18: the pagination of a filtered page is script-driven and carries no link, only this address after a click).
 */
const PAGE_STEP = 15

export interface CategoryRef {
  id: string
  /** The category URL without query and page suffix: page 1. */
  base: string
}

/** A category page URL (page 1, no page suffix), or null when it is not one. The query string is dropped. */
export function idealoCategory(raw: string): CategoryRef | null {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.origin !== IDEALO_ORIGIN) return null
  const match = CATEGORY_PATH.exec(url.pathname)
  return match ? { id: match[1]!, base: `${IDEALO_ORIGIN}${url.pathname}` } : null
}

/** The URL of page `pageIndex` (0-based) of a category, in the sort asked for. */
export function categoryPageUrl(category: CategoryRef, sort: ListSort, pageIndex: number): string {
  const path = pageIndex === 0 ? category.base : category.base.replace(/\.html$/, `I16-${PAGE_STEP * pageIndex}.html`)
  const key = SORT_KEYS[sort]
  return key === null ? path : `${path}?sortKey=${key}`
}

// ---- output -------------------------------------------------------------------------------------------------------

const memorySchema = z.object({
  generation: z.int().nullable().describe('DDR generation: 5 for DDR5'),
  totalGb: z.number().nullable(),
  modules: z.int().nullable().describe('Module count; null when the card does not say'),
  gbPerModule: z.number().nullable(),
  speedMts: z.int().nullable().describe('Data rate in MT/s'),
  cl: z.int().nullable().describe('The first CAS latency of "CL 40-40-40-77"'),
  formFactor: z.string().nullable().describe('UDIMM, SODIMM, RDIMM …'),
})

const ssdSchema = z.object({
  capacityGb: z.number().nullable().describe('Capacity in GB (1 TB = 1000 GB); null on a parent card'),
  pcieGen: z.number().nullable().describe('4 for "PCIe 4.0 x4"'),
  pcieLanes: z.int().nullable(),
  sata: z.boolean().describe('The spec line names SATA (and no PCIe)'),
  readMBs: z.int().nullable(),
  writeMBs: z.int().nullable(),
  tbw: z.number().nullable().describe('Endurance in TB written'),
  nand: z.string().nullable().describe('As printed: "3D TLC", "3D V-NAND", "V-NAND TLC", "MLC" …'),
  heatsink: z.boolean().describe('The spec line or the name names a heatsink (Kühlkörper)'),
})

export type MemorySpec = z.infer<typeof memorySchema>
export type SsdSpec = z.infer<typeof ssdSchema>

export const listedProductSchema = z.object({
  position: z.int().describe('1-based place among the products kept, over all pages read (dropped cards leave no gap)'),
  page: z.int().describe('1-based page the card was on'),
  id: z.string().describe('idealo product id'),
  url: z.string().describe('The product page: a valid input of `agw shop offers`'),
  name: z.string(),
  mpn: z
    .string()
    .nullable()
    .describe('The part number in brackets at the end of the name; null when the name has none'),
  kind: z
    .enum(['variant', 'parent', 'unknown'])
    .describe(
      'variant: one purchasable size (memory with a total capacity, an SSD with a capacity); parent: a model whose variants sit behind it ("Samsung 990 Pro", no capacity); unknown: another class of product',
    ),
  class: z.enum(['memory', 'ssd', 'other']),
  specText: z.string().describe("The card's spec line as printed"),
  memory: memorySchema.nullable(),
  ssd: ssdSchema.nullable(),
  offerCount: z.int().nullable(),
  lowestPriceEur: z.number().nullable().describe('The "ab" price: the cheapest offer, shipping not included'),
  pricePerGbEur: z
    .number()
    .nullable()
    .describe("idealo's own price per GB when the card shows one (a price per TB is divided by 1000)"),
  basePriceText: z.string().nullable().describe('The price per unit as printed, e.g. "(0,19 €/GB)"'),
  grade: z.number().nullable().describe('idealo\'s "Note ∅" (a school grade: 1 is best)'),
  reviewCount: z.int().nullable(),
})
export type ListedProduct = z.infer<typeof listedProductSchema>

export const facetSchema = z.object({
  name: z.string(),
  options: z.array(z.object({ label: z.string(), count: z.int().nullable(), selected: z.boolean() })),
})
export type Facet = z.infer<typeof facetSchema>

export interface CategoryPage {
  title: string | null
  totalProducts: number | null
  pageCount: number | null
  products: Omit<ListedProduct, 'position' | 'page'>[]
  facets: Facet[]
  dropped: { sponsored: number; used: number; other: number }
}

// ---- helpers ------------------------------------------------------------------------------------------------------

/** "7.450" → 7450, "1,25" → 1.25 (German number text). */
function germanNumber(text: string | undefined): number | null {
  if (!text) return null
  const value = Number(
    /^\d{1,3}(\.\d{3})+(,\d+)?$/.test(text) ? text.replace(/\./g, '').replace(',', '.') : text.replace(',', '.'),
  )
  return Number.isFinite(value) ? value : null
}

const round3 = (n: number) => Math.round(n * 1000) / 1000

/** The part number in the brackets that end a name: "… (CMK48GX5M2B5600C40)". */
const mpnOfName = (name: string): string | null => name.match(/\(([^()]+)\)\s*$/)?.[1]?.trim() || null

/** The value of the first `data-testid` element: its inner HTML up to the matching close of a div. */
function testIdInner(html: string, testId: string): string | undefined {
  const at = html.search(new RegExp(`<[a-z][a-z0-9]*\\b[^>]*data-testid="${testId}"`))
  if (at < 0) return undefined
  const tag = html.slice(at + 1).match(/^[a-z0-9]+/i)![0]
  const end = elementEnd(html, at, tag)
  const open = html.indexOf('>', at) + 1
  return html.slice(open, Math.max(open, end - `</${tag}>`.length))
}

// ---- spec lines ---------------------------------------------------------------------------------------------------

/** "DDR5-RAM, 48 GB, Anzahl Module 2, Kapazität pro Modul 24 GB, 5.600 MT/s, PC5-44.800, CL 40-40-40-77, 1,25 V, UDIMM, …" */
export function parseMemorySpec(spec: string, name: string): MemorySpec {
  const total = germanNumber(spec.match(/^[^,]*,\s*(\d+(?:,\d+)?)\s*GB/)?.[1])
  let modules = Number(spec.match(/Anzahl Module\s*(\d+)/)?.[1]) || null
  let perModule = germanNumber(spec.match(/Kapazität pro Modul\s*(\d+(?:,\d+)?)\s*GB/)?.[1])
  // The two stated numbers settle the third; a card that states neither stays null, a kit is never guessed from its name.
  if (modules === null && total !== null && perModule !== null && perModule > 0) {
    const derived = Math.round(total / perModule)
    modules = derived >= 1 && Math.abs(derived * perModule - total) < 0.01 ? derived : null
  }
  if (perModule === null && total !== null && modules !== null) perModule = round3(total / modules)
  return {
    generation: Number(spec.match(/^DDR(\d)/)?.[1] ?? name.match(/\bDDR(\d)/)?.[1]) || null,
    totalGb: total,
    modules,
    gbPerModule: perModule,
    speedMts: germanNumber(spec.match(/([\d.]+)\s*MT\/s/)?.[1]),
    cl: Number(spec.match(/\bCL\s*(\d+)/)?.[1] ?? name.match(/\bCL\s?(\d+)\b/)?.[1]) || null,
    formFactor: spec.match(/\b(CUDIMM|CSODIMM|LRDIMM|RDIMM|UDIMM|SODIMM)\b/)?.[1] ?? null,
  }
}

/** "interne SSD-Festplatte, Lesetransferrate 7.450 MB/s, …, max. Schreibvolumen (TBW) 1.200 TB, …, 2.000 GB, 3D V-NAND, PCIe 4.0 x4, NVMe, …, M.2" */
export function parseSsdSpec(spec: string, name: string): SsdSpec {
  // The capacity is the bare ", 2.000 GB" item; a "7.450 MB/s" rate or "(TBW) 1.200 TB" is not preceded by a comma.
  const bare = spec.match(/,\s*(\d{1,3}(?:\.\d{3})*|\d+(?:,\d+)?)\s*(GB|TB)\b/)
  const named = name.match(/\b(\d+(?:[.,]\d+)?)\s*(GB|TB)\b/i)
  const capacity = (found: RegExpMatchArray | null) => {
    const value = germanNumber(found?.[1]?.replace(/^(\d+)\.(\d{1,2})$/, '$1,$2'))
    return value === null ? null : round3(value * (found![2]!.toUpperCase() === 'TB' ? 1000 : 1))
  }
  const pcie = spec.match(/PCIe\s*(\d(?:\.\d)?)\s*x(\d+)/)
  const tbw = spec.match(/\(TBW\)\s*([\d.,]+)\s*(TB|PB)/)
  return {
    capacityGb: capacity(bare) ?? capacity(named),
    pcieGen: pcie ? Number(pcie[1]) : null,
    pcieLanes: pcie ? Number(pcie[2]) : null,
    sata: !pcie && /\bSATA\b/.test(spec),
    readMBs: germanNumber(spec.match(/Lesetransferrate\s*([\d.]+)\s*MB\/s/)?.[1]),
    writeMBs: germanNumber(spec.match(/Schreibtransferrate\s*([\d.]+)\s*MB\/s/)?.[1]),
    tbw: tbw ? round3((germanNumber(tbw[1]) ?? 0) * (tbw[2] === 'PB' ? 1000 : 1)) : null,
    nand: spec.match(/\b(?:3D )?(?:V-NAND TLC|V-NAND|TLC|QLC|MLC|SLC)\b/)?.[0] ?? null,
    heatsink: /Kühlkörper/i.test(spec) || /\bheatsink\b/i.test(name),
  }
}

// ---- cards --------------------------------------------------------------------------------------------------------

const PRODUCT_LINK = /href="(https:\/\/www\.idealo\.de\/preisvergleich\/OffersOfProduct\/(\d+)_-[^"?#]*\.html)/

type Card = Omit<ListedProduct, 'position' | 'page'>

/** What one `result-item` is: a product, or a card that is no product page (an ad, a used offer, a card with no link). */
function parseCard(card: string): Card | 'sponsored' | 'used' | 'other' {
  if (/data-testid="used-condition-offer-badge"/.test(card)) return 'used'
  const link = card.match(PRODUCT_LINK)
  if (/Gesponsert|type=sponsoredoffer/.test(card)) return 'sponsored'
  const name = textOf(testIdInner(card, 'product-summary-title') ?? '')
  if (!link || !name) return 'other'
  const spec = textOf(card.match(/<p\b[^>]*>([\s\S]*?)<\/p>/)?.[1] ?? '').replace(/\s+([,.])/g, '$1')
  const cls = /^DDR\d-RAM\b/.test(spec) ? 'memory' : /\bSSD-Festplatte\b/.test(spec) ? 'ssd' : 'other'
  const memory = cls === 'memory' ? parseMemorySpec(spec, name) : null
  const ssd = cls === 'ssd' ? parseSsdSpec(spec, name) : null
  const mpn = mpnOfName(name)
  const rating = testIdInner(card, 'product-rating') ?? ''
  const info = testIdInner(card, 'detailed-price-info') ?? ''
  const baseText = textOf(testIdInner(card, 'detailed-price-info-base-price') ?? '') || null
  const basePrice = baseText?.match(/^\(\s*([\d.]+,\d{2})\s*€\s*\/\s*(GB|TB)\s*\)$/)
  const basePerUnit = basePrice ? germanNumber(basePrice[1]) : null
  const offerCount = info.match(/(\d+(?:\.\d{3})*)\s+Angebote?\b/)?.[1]
  const priceBox = testIdInner(info, 'detailed-price-info-price')
  const reviews = [...rating.matchAll(/<span\b[^>]*>\s*(\d{1,3}(?:\.\d{3})*|\d+)\s*<\/span>/g)].at(-1)?.[1]
  const kind = memory
    ? memory.totalGb !== null
      ? 'variant'
      : 'parent'
    : ssd
      ? ssd.capacityGb !== null
        ? 'variant'
        : 'parent'
      : 'unknown'
  return {
    id: link[2]!,
    url: link[1]!,
    name,
    mpn,
    kind,
    class: cls,
    specText: spec,
    memory,
    ssd,
    offerCount: offerCount ? Number(offerCount.replace(/\./g, '')) : null,
    lowestPriceEur: parsePrice(priceBox ? textOf(priceBox).replace(/^ab\s*/, '') : undefined),
    pricePerGbEur: basePerUnit === null ? null : round3(basePrice![2] === 'TB' ? basePerUnit / 1000 : basePerUnit),
    basePriceText: baseText,
    grade: germanNumber(textOf(rating).match(/Note\s*∅\s*(\d(?:,\d)?)/)?.[1]),
    reviewCount: reviews ? Number(reviews.replace(/\./g, '')) : null,
  }
}

/** Every filter box of the page (the price ranges too): its name and each option with idealo's count (and whether it is ticked). */
function parseFacets(html: string): Facet[] {
  const starts = [...html.matchAll(/data-testid="(?:filter-box|price-box)"/g)].map((m) => m.index)
  const facets: Facet[] = []
  starts.forEach((start, i) => {
    const box = html.slice(start, starts[i + 1] ?? html.length)
    const name = decode(box.match(/<span\b[^>]*\btitle="([^"]*)"/)?.[1] ?? '').trim()
    const options = [...box.matchAll(/<label\b[^>]*data-testid="checkbox"[^>]*>([\s\S]*?)<\/label>/g)].flatMap(
      (label) => {
        const text = label[1]!
        const value = decode(text.match(/<input\b[^>]*aria-label="([^"]*)"/)?.[1] ?? '').trim()
        const count = text.match(/(\d{1,3}(?:\.\d{3})*|\d+)\s*<\/span>\s*<\/a>/)?.[1]
        return value
          ? [
              {
                label: value,
                count: count ? Number(count.replace(/\./g, '')) : null,
                selected: /<input\b[^>]*\bchecked\b/.test(text),
              },
            ]
          : []
      },
    )
    if (name && options.length > 0) facets.push({ name, options })
  })
  return facets
}

/** An idealo category page: the cards, the facets with their counts and what the page says about its size. */
export function parseIdealoCategory(html: string, finalUrl: string): CategoryPage {
  if (/\/OffersOfProduct\//.test(finalUrl)) throw new Error('idealo answered a product page, not a category page')
  if (!/data-testid="result-list"/.test(html)) throw new Error('unrecognized idealo category layout (no result list)')
  const starts = [...html.matchAll(/data-testid="result-item"/g)].map((m) => m.index)
  const products: Card[] = []
  const dropped = { sponsored: 0, used: 0, other: 0 }
  starts.forEach((start, i) => {
    const parsed = parseCard(html.slice(start, starts[i + 1] ?? html.length))
    if (typeof parsed === 'string') dropped[parsed]++
    else products.push(parsed)
  })
  const count = textOf(testIdInner(html, 'result-count') ?? '').match(/^\((\d{1,3}(?:\.\d{3})*|\d+)\)/)?.[1]
  const pages = [...(testIdInner(html, 'pagination') ?? '').matchAll(/aria-label="(\d+)"/g)].map((m) => Number(m[1]))
  return {
    title: textOf(testIdInner(html, 'result-title') ?? '') || null,
    totalProducts: count ? Number(count.replace(/\./g, '')) : null,
    pageCount: pages.length === 0 ? null : Math.max(...pages),
    products,
    facets: parseFacets(html),
    dropped,
  }
}
