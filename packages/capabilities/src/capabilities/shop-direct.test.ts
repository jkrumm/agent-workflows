import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  alternateProductId,
  alternateSearchUrl,
  casekingProductId,
  casekingSearchUrl,
  memoryOfText,
  mindfactoryProductId,
  mindfactorySearchUrl,
  parseAlternateProduct,
  parseAlternateSearch,
  parseCasekingProduct,
  parseCasekingSearch,
  parseMindfactoryProduct,
  parseMindfactorySearch,
} from './shop-direct-parse.ts'
import { geizhalsSearchUrl, idealoSearchUrl } from './shop-offers-parse.ts'
import {
  failure,
  fixture,
  GEIZHALS_CMK,
  IDEALO_CATEGORY,
  IDEALO_CMK,
  idealoPages,
  rig,
  type Served,
} from './shop-rig.test.ts'
import { watchEntrySchema, qualifyingOffer } from './shop-watch-rules.ts'

const ENTRY = { mpn: 'CMK48GX5M2B5600C40', label: 'Corsair 2x24 5600', ceilingEur: 600 }

const ALTERNATE_CMK =
  'https://www.alternate.de/Corsair/DIMM-48-GB-DDR5-5600-2x-24-GB-Dual-Kit-Arbeitsspeicher/html/product/1900210'
const CASEKING_PVV =
  'https://www.caseking.de/patriot-viper-venom-ddr5-5600-ram-cl40-xmp-expo-64-gb-dual-kit-schwarz/MEPM-140.html'
const MINDFACTORY_CMK =
  'https://www.mindfactory.de/product_info.php/48GB-Corsair-Vengeance-schwarz-DDR5-5600-DIMM-CL40-Dual-Kit_1483744.html'
const MINDFACTORY_LANDED = MINDFACTORY_CMK.replace('/product_info.php/', '/product_info.php/search/true/')

describe('product page URLs', () => {
  test('each shop knows its own, and nothing else', () => {
    expect(alternateProductId(ALTERNATE_CMK)).toBe('1900210')
    expect(casekingProductId(CASEKING_PVV)).toBe('MEPM-140')
    expect(mindfactoryProductId(MINDFACTORY_CMK)).toBe('1483744')
    expect(mindfactoryProductId(MINDFACTORY_LANDED)).toBe('1483744')
    expect(alternateProductId('https://www.alternate.de/listing.xhtml?q=x')).toBeNull()
    expect(casekingProductId('https://www.caseking.de/search?q=MEPM-140')).toBeNull()
    expect(casekingProductId('https://www.caseking.de/pc-komponenten/arbeitsspeicher/ddr5')).toBeNull()
    expect(mindfactoryProductId('https://www.mindfactory.de/search_result.php?search_query=x')).toBeNull()
    expect(alternateProductId('https://www.alternate.de.evil.example/a/html/product/1')).toBeNull()
  })

  test('a part number is encoded into the search URL', () => {
    expect(alternateSearchUrl('A B/C')).toBe('https://www.alternate.de/listing.xhtml?q=A%20B%2FC')
    expect(casekingSearchUrl('PVV564G560C40K')).toBe('https://www.caseking.de/search?q=PVV564G560C40K')
    expect(mindfactorySearchUrl('X')).toBe('https://www.mindfactory.de/search_result.php?search_query=X')
  })
})

describe('memory from a shop text', () => {
  test('"(2x 24 GB)" is explicit; a "Dual Kit" of a total reads as two modules; nothing else is guessed', () => {
    expect(memoryOfText('DIMM 48 GB DDR5-5600 (2x 24 GB) Dual-Kit')).toEqual({ modules: 2, moduleGb: 24, totalGb: 48 })
    expect(memoryOfText('48GB Corsair Vengeance schwarz DDR5-5600 DIMM CL40 Dual Kit')).toEqual({
      modules: 2,
      moduleGb: 24,
      totalGb: 48,
    })
    expect(memoryOfText('Corsair Vengeance 32GB DDR5')).toBeNull()
  })
})

describe('alternate.de parsers', () => {
  test('a search lists the cards; the part number is among the words of the subtitle, not a field', async () => {
    const page = parseAlternateSearch(await fixture('alternate-search-cmk'), alternateSearchUrl('CMK48GX5M2B5600C40'))
    expect(page.kind).toBe('list')
    if (page.kind !== 'list') return
    expect(page.candidates.map((c) => c.id)).toEqual(['1900210', '1900209'])
    expect(page.candidates[0]).toMatchObject({ url: ALTERNATE_CMK, mpn: null })
    expect(page.candidates[0]!.tokens).toContain('CMK48GX5M2B5600C40')
    expect(page.candidates[1]!.tokens).toContain('CMH48GX5M2B5600C40')
  })

  test('a product page: JSON-LD price, part number, EAN, shipping rate and the shop saying it cannot be bought', async () => {
    const { product, offers } = parseAlternateProduct(await fixture('alternate-product-cmk'), ALTERNATE_CMK)
    expect(product).toMatchObject({
      source: 'alternate',
      id: '1900210',
      mpn: 'CMK48GX5M2B5600C40',
      gtin: '0840006665021',
      memory: { modules: 2, moduleGb: 24, totalGb: 48 },
      offerCount: 1,
    })
    expect(offers).toEqual([
      expect.objectContaining({
        shop: 'Alternate',
        marketplace: false,
        priceEur: 730,
        shippingEur: 7.99,
        totalEur: 737.99,
        totalEurNoPrepayment: 737.99,
        rating: null,
        inStock: false,
        delivery: 'Artikel kann derzeit nicht gekauft werden · Versand 7,99 €',
      }),
    ])
  })

  test('a page that is neither is an unknown layout, not an empty result', () => {
    expect(() => parseAlternateSearch('<html><body>nothing</body></html>', alternateSearchUrl('x'))).toThrow(
      'unrecognized',
    )
    expect(() => parseAlternateProduct('<html></html>', ALTERNATE_CMK)).toThrow('unrecognized')
  })
})

describe('caseking.de parsers', () => {
  test('a search tile names the product and its item number, no part number', async () => {
    const page = parseCasekingSearch(await fixture('caseking-search-pvv'), casekingSearchUrl('PVV564G560C40K'))
    expect(page).toEqual({
      kind: 'list',
      candidates: [
        {
          id: 'MEPM-140',
          url: CASEKING_PVV,
          name: 'Patriot Viper Venom DDR5-5600 RAM, CL40, XMP/EXPO - 64 GB Dual-Kit, schwarz',
          mpn: null,
          mpnOnPage: true,
        },
      ],
    })
  })

  test('a search with no hit is an empty list', async () => {
    expect(parseCasekingSearch(await fixture('caseking-search-none'), casekingSearchUrl('x'))).toEqual({
      kind: 'list',
      candidates: [],
    })
  })

  test("a product page: the manufacturer's part number is the MPN attribute, not the JSON-LD `mpn` (the shop's item number)", async () => {
    const { product, offers } = parseCasekingProduct(await fixture('caseking-product-pvv'), CASEKING_PVV)
    expect(product).toMatchObject({
      source: 'caseking',
      id: 'MEPM-140',
      mpn: 'PVV564G560C40K',
      gtin: '4711378423693',
      memory: { modules: 2, moduleGb: 32, totalGb: 64 },
    })
    expect(offers[0]).toMatchObject({
      shop: 'Caseking',
      priceEur: 899.9,
      shippingEur: 4.99,
      totalEur: 904.89,
      inStock: true,
      delivery: 'Auf Lager · Versand ab 4,99 €',
    })
  })
})

describe('mindfactory.de parsers', () => {
  test('a search that landed on the product page is that product, at the page without the search marker', async () => {
    const page = parseMindfactorySearch(await fixture('mindfactory-product-cmk'), MINDFACTORY_LANDED)
    expect(page.kind).toBe('product')
    if (page.kind !== 'product') return
    expect(page.page.product.url).toBe(MINDFACTORY_CMK)
  })

  test('a search with no hit is an empty list', async () => {
    expect(
      parseMindfactorySearch(await fixture('mindfactory-search-none'), mindfactorySearchUrl('ZZQX9999NOPE')),
    ).toEqual({ kind: 'list', candidates: [] })
  })

  test("a product page: schema.org microdata, the SKU as part number, the footer's minimum shipping", async () => {
    const { product, offers } = parseMindfactoryProduct(await fixture('mindfactory-product-cmk'), MINDFACTORY_LANDED)
    expect(product).toMatchObject({
      source: 'mindfactory',
      id: '1483744',
      mpn: 'CMK48GX5M2B5600C40',
      gtin: '0840006665021',
      memory: { modules: 2, moduleGb: 24, totalGb: 48 },
    })
    // Geizhals showed 860,79 for the shop at the same time: 851,89 plus the 8,90 minimum shipping.
    expect(offers[0]).toMatchObject({
      shop: 'Mindfactory',
      priceEur: 851.89,
      shippingEur: 8.9,
      totalEur: 860.79,
      inStock: true,
      delivery: 'Verfügbar · Versand ab 8,90 €',
    })
  })
})

// ---- through the offers door ---------------------------------------------------------------------------------------------

const html = (body: string): Response =>
  new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })

async function shopRig() {
  const alternateSearch = await fixture('alternate-search-cmk')
  const alternateProduct = await fixture('alternate-product-cmk')
  const direct: string[] = []
  const pages: Record<string, Served> = {
    ...(await idealoPages()),
    [geizhalsSearchUrl('CMK48GX5M2B5600C40')]: { html: await fixture('geizhals-search-cmk') },
    [GEIZHALS_CMK]: { html: await fixture('geizhals-product-cmk') },
    [mindfactorySearchUrl('CMK48GX5M2B5600C40')]: {
      html: await fixture('mindfactory-product-cmk'),
      finalUrl: MINDFACTORY_LANDED,
    },
    [mindfactorySearchUrl('ZZQX9999NOPE')]: { html: await fixture('mindfactory-search-none') },
    [casekingSearchUrl('PVV564G560C40K')]: { html: await fixture('caseking-search-pvv') },
    [casekingSearchUrl('CMK48GX5M2B5600C40')]: { html: await fixture('caseking-search-none') },
    [CASEKING_PVV]: { html: await fixture('caseking-product-pvv') },
  }
  const r = rig({
    pages,
    directFetch: async (url) => {
      direct.push(url)
      if (url === alternateSearchUrl('CMK48GX5M2B5600C40')) return html(alternateSearch)
      if (url === ALTERNATE_CMK) return html(alternateProduct)
      return new Response('', { status: 404 })
    },
  })
  return { ...r, direct }
}

describe('shop.offers from the tech shops', () => {
  test('alternate: read directly, the exact part number picks its card out of a loose list, two requests', async () => {
    const r = await shopRig()
    const out = await r.offers.call({ product: 'CMK48GX5M2B5600C40', source: 'alternate' }, r.options)
    expect(r.direct).toEqual([alternateSearchUrl('CMK48GX5M2B5600C40'), ALTERNATE_CMK])
    expect(r.chrome.reads).toEqual([])
    expect(out.results[0]!.product.mpn).toBe('CMK48GX5M2B5600C40')
    expect(out.results[0]!.lowestTotalEur).toBe(737.99)
    expect(out.text).toContain('Alternate')
    expect(out.text).toContain('[unavailable]')
  })

  test('mindfactory: read in the research Chrome, the search lands on the product, one request', async () => {
    const r = await shopRig()
    const out = await r.offers.call({ product: 'CMK48GX5M2B5600C40', source: 'mindfactory' }, r.options)
    expect(r.chrome.reads).toEqual([mindfactorySearchUrl('CMK48GX5M2B5600C40')])
    expect(r.direct).toEqual([])
    expect(out.results[0]!.offers[0]!.totalEur).toBe(860.79)
  })

  test('caseking: a single-hit search is read and the product page decides; another part number is NOT_FOUND', async () => {
    const r = await shopRig()
    const out = await r.offers.call({ product: 'PVV564G560C40K', source: 'caseking' }, r.options)
    expect(r.chrome.reads).toEqual([casekingSearchUrl('PVV564G560C40K'), CASEKING_PVV])
    expect(out.results[0]!.offers[0]!.totalEur).toBe(904.89)
    // The shop's search finds a product for any text; its page names another part number, so it is not the one asked.
    const other = rig({
      pages: {
        [casekingSearchUrl('PVV564G560C40X')]: { html: await fixture('caseking-search-pvv') },
        [CASEKING_PVV]: { html: await fixture('caseking-product-pvv') },
      },
    })
    const error = await failure(other.offers.call({ product: 'PVV564G560C40X', source: 'caseking' }, other.options))
    expect(error.code).toBe('NOT_FOUND')
    expect(error.message).toContain('names part number PVV564G560C40K, not PVV564G560C40X')
  })

  test('a part number the loose search lists no card for is NOT_FOUND with the near misses', async () => {
    const r = await shopRig()
    const error = await failure(r.offers.call({ product: 'CMK48GX5M2B5600C41', source: 'alternate' }, r.options))
    expect(error.code).toBe('NOT_FOUND')
  })

  test('`shops` reads the three, and one that does not list the part number is a field of the answer', async () => {
    const r = await shopRig()
    const out = await r.offers.call({ product: 'CMK48GX5M2B5600C40', source: 'shops' }, r.options)
    expect(out.results.map((x) => x.source)).toEqual(['alternate', 'mindfactory'])
    expect(out.errors).toEqual([expect.objectContaining({ source: 'caseking', code: 'NOT_FOUND' })])
  })

  test('`all` stays the two aggregators, `everything` reads all five', async () => {
    const r = await shopRig()
    const some = await r.offers.call({ product: 'CMK48GX5M2B5600C40', source: 'all' }, r.options)
    expect(some.errors.map((e) => e.source)).not.toContain('alternate')
    const every = await r.offers.call({ product: 'CMK48GX5M2B5600C40', source: 'everything' }, r.options)
    const named = [...every.results.map((x) => x.source), ...every.errors.map((e) => e.source)].sort()
    expect(named).toEqual(['alternate', 'caseking', 'geizhals', 'idealo', 'mindfactory'])
  })

  test('several tiles with no part number are an error, not "the shop does not list it"', async () => {
    const tile = (await fixture('caseking-search-pvv')).match(
      /<div class="product h-100 w-100"[\s\S]*<\/div>\n<\/div>\n<\/body>/,
    )![0]
    const doubled = `<html><body>${'<p>navigation</p>'.repeat(2000)}`
      .concat(await fixture('caseking-search-pvv'))
      .replace(
        tile,
        `${tile.replace('</div>\n</body>', '')}${tile.replaceAll('MEPM-140', 'MEPM-141').replace('</div>\n</body>', '')}</div>\n</body>`,
      )
    const r = rig({ pages: { [casekingSearchUrl('PVV564G560C40K')]: { html: doubled } } })
    const error = await failure(r.offers.call({ product: 'PVV564G560C40K', source: 'caseking' }, r.options))
    expect(error.code).toBe('UPSTREAM_ERROR')
    expect(error.message).toContain('2 products with no part number on the card')
  })

  test('a product page URL of a shop names its own source', async () => {
    const r = await shopRig()
    const out = await r.offers.call({ product: ALTERNATE_CMK }, r.options)
    expect(out.results[0]!.source).toBe('alternate')
    expect(r.direct).toEqual([ALTERNATE_CMK])
  })

  test('the shops are read on their own hosts only', async () => {
    const r = await shopRig()
    const error = await failure(
      r.offers.call({ product: 'https://www.alternate.de.evil.example/a/html/product/1' }, r.options),
    )
    expect(error.code).toBe('INVALID_INPUT')
  })
})

// ---- the watch ----------------------------------------------------------------------------------------------------------

const NTFY = { NTFY_URL: 'https://ntfy.example.com/', NTFY_TOKEN: 'token-1' }

describe('the watch reads the tech shops', () => {
  async function watchRig(entry: Record<string, unknown>, legacyState?: unknown) {
    const dir = mkdtempSync(join(tmpdir(), 'shop-watch-direct-'))
    writeFileSync(join(dir, 'watch.json'), JSON.stringify({ products: [entry] }))
    if (legacyState) writeFileSync(join(dir, 'state.json'), JSON.stringify(legacyState))
    const alternateSearch = await fixture('alternate-search-cmk')
    const alternateProduct = await fixture('alternate-product-cmk')
    const sent: string[] = []
    const notifyFetch = (async (_url: string, init: RequestInit) => {
      sent.push(String(init.body))
      return new Response('', { status: 200 })
    }) as unknown as typeof fetch
    const pages: Record<string, Served> = {
      [idealoSearchUrl('CMK48GX5M2B5600C40')]: { html: await fixture('idealo-search-cmk'), finalUrl: IDEALO_CATEGORY },
      [IDEALO_CMK]: { html: await fixture('idealo-product-cmk') },
      [geizhalsSearchUrl('CMK48GX5M2B5600C40')]: { html: await fixture('geizhals-search-cmk') },
      [GEIZHALS_CMK]: { html: await fixture('geizhals-product-cmk') },
      [mindfactorySearchUrl('CMK48GX5M2B5600C40')]: {
        html: await fixture('mindfactory-product-cmk'),
        finalUrl: MINDFACTORY_LANDED,
      },
      [casekingSearchUrl('CMK48GX5M2B5600C40')]: { html: await fixture('caseking-search-none') },
    }
    const r = rig({
      pages,
      env: NTFY,
      watch: { dir, notifyFetch },
      directFetch: async (url) =>
        url === alternateSearchUrl('CMK48GX5M2B5600C40')
          ? html(alternateSearch)
          : url === ALTERNATE_CMK
            ? html(alternateProduct)
            : new Response('', { status: 404 }),
    })
    return { ...r, dir, sent, state: () => JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')) }
  }

  test('by default all three: a shop that lists the part number is a source, one that does not is a zero, not an error', async () => {
    const r = await watchRig(ENTRY)
    const out = await r.watch.call({}, r.options)
    const row = out.rows[0]!
    expect(row.offers).toEqual({ idealo: 11, geizhals: 9, alternate: 1, mindfactory: 1, caseking: 0 })
    expect(row.errors).toEqual([])
    // Alternate says it cannot be bought; Mindfactory's 860,79 € qualifies without a shop rating, but idealo is cheaper.
    expect(row).toMatchObject({ qualifying: expect.any(Number), source: 'idealo', lowestTotalEur: 564.85 })
    expect(r.state().CMK48GX5M2B5600C40.pageUrls).toMatchObject({
      alternate: ALTERNATE_CMK,
      mindfactory: MINDFACTORY_CMK,
      geizhals: GEIZHALS_CMK,
      idealo: IDEALO_CMK,
    })
    expect(r.state().CMK48GX5M2B5600C40.pageUrls.caseking ?? null).toBeNull()
  })

  test("a shop's own offer counts without a rating, an aggregator's offer without one does not", async () => {
    const r = await shopRig()
    const entry = watchEntrySchema.parse({ ...ENTRY, ceilingEur: 900 })
    const offer = (await r.offers.call({ product: 'CMK48GX5M2B5600C40', source: 'mindfactory' }, r.options)).results[0]!
      .offers[0]!
    expect(qualifyingOffer(entry, 'mindfactory', offer, MINDFACTORY_CMK)).toMatchObject({
      source: 'mindfactory',
      shop: 'Mindfactory',
      totalEur: 860.79,
      rating: null,
    })
    expect(qualifyingOffer(entry, 'idealo', offer, 'u')).toBeNull()
    expect(qualifyingOffer(entry, 'alternate', { ...offer, inStock: false }, 'u')).toBeNull()
  })

  test('`shops` limits the tech shops read; [] reads none', async () => {
    const some = await watchRig({ ...ENTRY, shops: ['mindfactory'] })
    const out = await some.watch.call({}, some.options)
    expect(Object.keys(out.rows[0]!.offers)).toEqual(['idealo', 'geizhals', 'mindfactory'])
    expect(some.direct).toEqual([])
    const none = await watchRig({ ...ENTRY, shops: [] })
    expect(Object.keys((await none.watch.call({}, none.options)).rows[0]!.offers)).toEqual(['idealo', 'geizhals'])
  })

  test('a state file from before the tech shops still reads: its stored pages are used, not searched again', async () => {
    const r = await watchRig(
      { ...ENTRY, shops: [] },
      {
        CMK48GX5M2B5600C40: {
          idealoUrl: IDEALO_CMK,
          geizhalsUrl: GEIZHALS_CMK,
          underCeiling: true,
          lastAlertedEur: 564.85,
          recent: [564.85],
        },
      },
    )
    const out = await r.watch.call({}, r.options)
    expect(r.chrome.reads).toEqual([IDEALO_CMK, GEIZHALS_CMK])
    expect(out.rows[0]!.alert).toBeNull()
    const saved = r.state().CMK48GX5M2B5600C40
    expect(saved.pageUrls).toEqual({ idealo: IDEALO_CMK, geizhals: GEIZHALS_CMK })
    expect(saved).not.toHaveProperty('idealoUrl')
  })
})
