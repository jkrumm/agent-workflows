import { describe, expect, test } from 'bun:test'
import {
  geizhalsSearchUrl,
  idealoHistoryUrl,
  idealoSearchUrl,
  normMpn,
  parseGeizhalsPayment,
  parseGeizhalsProduct,
  parseGeizhalsSearch,
  parseIdealoHistory,
  parseIdealoProduct,
  parseIdealoSearch,
} from './shop-offers-parse.ts'
import { parseItem } from './shop-parse.ts'
import {
  failure,
  fixture,
  GEIZHALS_CMK,
  IDEALO_CATEGORY,
  IDEALO_CMK,
  IDEALO_PVV,
  idealoPages,
  rig,
} from './shop-rig.test.ts'

describe('part numbers', () => {
  test('compare as letters and digits, in any case', () => {
    expect(normMpn('cmk48gx5m2b5600c40')).toBe(normMpn('CMK48GX5M2B5600C40'))
    expect(normMpn('CMK-48GX5 M2B5600C40')).toBe('CMK48GX5M2B5600C40')
    expect(normMpn('CMK48GX5M2B5600C4')).not.toBe(normMpn('CMK48GX5M2B5600C40'))
  })
})

describe('idealo parsers', () => {
  test('a search list: name, part number, link and id of every card', async () => {
    const page = parseIdealoSearch(await fixture('idealo-search-cmk'), IDEALO_CATEGORY)
    expect(page.kind).toBe('list')
    if (page.kind !== 'list') return
    expect(page.candidates.map((c) => c.mpn)).toEqual([
      'CMK48GX5M2B5600C40',
      'CMH48GX5M2B5600C40',
      'CMK48GX5M2B7000C40',
      'CMK32GX5M2B5600C40W',
    ])
    expect(page.candidates[0]).toEqual({
      id: '202332264',
      url: IDEALO_CMK,
      name: 'Corsair Vengeance 48GB Kit DDR5-5600 CL40 (CMK48GX5M2B5600C40)',
      mpn: 'CMK48GX5M2B5600C40',
    })
  })

  test('a search redirected to a product page is that product', async () => {
    const page = parseIdealoSearch(await fixture('idealo-product-cmk'), IDEALO_CMK)
    expect(page.kind).toBe('product')
  })

  test('a page that is no search list is an unknown layout, not an empty result', () => {
    expect(() => parseIdealoSearch('<html><body>nothing</body></html>', IDEALO_CATEGORY)).toThrow('unrecognized')
    expect(parseIdealoSearch('<div data-testid="delphi-hint">x</div>', IDEALO_CATEGORY)).toEqual({
      kind: 'list',
      candidates: [],
    })
  })

  test('the product page of the Corsair 2 x 24 GB kit: product facts and every offer field', async () => {
    const { product, offers } = parseIdealoProduct(await fixture('idealo-product-cmk'), `${IDEALO_CMK}?x=1`)
    expect(product).toEqual({
      source: 'idealo',
      id: '202332264',
      url: IDEALO_CMK,
      name: 'Corsair Vengeance 48GB Kit DDR5-5600 CL40 (CMK48GX5M2B5600C40)',
      mpn: 'CMK48GX5M2B5600C40',
      gtin: null,
      memory: { modules: 2, moduleGb: 24, totalGb: 48 },
      offerCount: 11,
      dataTime: '2026-11-17T15:14',
    })
    expect(offers).toHaveLength(11)
    expect(offers[0]).toEqual({
      shop: 'it-veith.de',
      marketplace: false,
      priceEur: 564.85,
      shippingEur: 0,
      totalEur: 564.85,
      totalEurNoPrepayment: 564.85,
      rating: 4.7,
      ratingCount: 204,
      paymentMethods: ['Rechnung', 'Vorkasse', 'PayPal', 'Visa', 'Mastercard', 'Klarna'],
      prepaymentOnly: false,
      delivery: 'Lieferung: bis Do. 19.11.',
      inStock: null,
    })
    // A marketplace seller is marked in the shop name or by the shop type; the suffix is not part of the name.
    const byShop = (name: string) => offers.find((o) => o.shop === name)
    expect(byShop('otto.de')).toMatchObject({ marketplace: true, rating: 2.2, ratingCount: 170 })
    expect(byShop('Galaxus.de')?.marketplace).toBe(true)
    expect(byShop('eBay')?.marketplace).toBe(true)
    expect(byShop('proshop.de')?.marketplace).toBe(false)
    // A shop with no rating has none, never a guess.
    expect(byShop('pccomponentes.de')).toMatchObject({ rating: null, ratingCount: null })
    expect(offers.every((o) => o.totalEur !== null && o.paymentMethods.length > 0)).toBe(true)
  })

  test('the product page of the Patriot 2 x 16 GB kit states 2 x 16 GB (32 GB), and that the list is a first page of 28', async () => {
    const { product, offers } = parseIdealoProduct(await fixture('idealo-product-pvv'), IDEALO_PVV)
    expect(product.mpn).toBe('PVV532G600C30K')
    expect(product.memory).toEqual({ modules: 2, moduleGb: 16, totalGb: 32 })
    expect(product.offerCount).toBe(28)
    expect(offers.length).toBeLessThan(28)
  })

  test('a product page without a title or an offer list is an unknown layout', () => {
    expect(() => parseIdealoProduct('<html></html>', IDEALO_CMK)).toThrow('unrecognized')
    expect(() => parseIdealoProduct('<html></html>', 'https://www.idealo.de/preisvergleich/x.html')).toThrow(
      'not an idealo',
    )
  })

  test('the history answer: daily points in euros and the period statistics', async () => {
    const history = parseIdealoHistory(await fixture('idealo-history'), '1Y')
    expect(history.period).toBe('1Y')
    expect(history.points).toHaveLength(60)
    expect(history.points[0]).toEqual({ date: '2025-11-17', priceEur: 222.8 })
    expect(history.points.at(-1)).toEqual({ date: '2026-11-17', priceEur: 564.85 })
    expect(history).toMatchObject({ lowestEur: 174.92, averageEur: 523.88, highestEur: 740.44 })
    expect(() => parseIdealoHistory('<html><body><pre>not json</pre></body></html>', '1Y')).toThrow('not JSON')
    expect(() => parseIdealoHistory('<html></html>', '1Y')).toThrow('no JSON')
  })
})

describe('geizhals parsers', () => {
  test('a search list: the card names its part number', async () => {
    const page = parseGeizhalsSearch(await fixture('geizhals-search-cmk'), 'https://geizhals.de/?fs=x&hloc=de')
    expect(page).toEqual({
      kind: 'list',
      candidates: [
        {
          id: '2900586',
          url: GEIZHALS_CMK,
          name: 'Corsair Vengeance schwarz UDIMM 48GB Kit, DDR5-5600, CL40-40-40-77',
          mpn: 'CMK48GX5M2B5600C40',
        },
      ],
    })
  })

  test('a loose search lists unrelated products; none of them carries the part number asked for', async () => {
    const page = parseGeizhalsSearch(await fixture('geizhals-search-fuzzy'), 'https://geizhals.de/?fs=x&hloc=de')
    if (page.kind !== 'list') throw new Error('expected a list')
    expect(page.candidates.length).toBeGreaterThan(1)
    expect(page.candidates.some((c) => c.mpn !== null && normMpn(c.mpn) === normMpn('ZZQ9NOSUCHMPN77'))).toBe(false)
  })

  test('a layout with no cards and no "no results" notice is unknown', () => {
    expect(() => parseGeizhalsSearch('<html><body>x</body></html>', 'https://geizhals.de/?fs=x')).toThrow(
      'unrecognized',
    )
    expect(parseGeizhalsSearch('<html><body>Leider keine Treffer</body></html>', 'https://geizhals.de/?fs=x')).toEqual({
      kind: 'list',
      candidates: [],
    })
  })

  test('the product page: JSON-LD facts, module count from the spec table, offers with shipping and the data time', async () => {
    const { product, offers } = parseGeizhalsProduct(await fixture('geizhals-product-cmk'), `${GEIZHALS_CMK}?hloc=de`)
    expect(product).toEqual({
      source: 'geizhals',
      id: '2900586',
      url: GEIZHALS_CMK,
      name: 'Corsair Vengeance schwarz UDIMM 48GB Kit, DDR5-5600, CL40-40-40-77',
      mpn: 'CMK48GX5M2B5600C40',
      gtin: '0840006665021',
      memory: { modules: 2, moduleGb: 24, totalGb: 48 },
      offerCount: 9,
      dataTime: '2026-11-17T16:14:04+01:00',
    })
    expect(offers).toHaveLength(9)
    expect(offers[0]).toMatchObject({
      shop: '25now',
      priceEur: 770.07,
      shippingEur: 0,
      totalEur: 770.07,
      rating: 5,
      ratingCount: 1,
      paymentMethods: ['Vorkasse', 'PayPal'],
      prepaymentOnly: false,
      marketplace: null,
      delivery: '1-3 Werktage',
    })
    const byShop = (name: string) => offers.find((o) => o.shop === name)
    // Shipping is priced per way to pay: free for prepayment, 8,90 € otherwise.
    expect(byShop('edigitech')).toMatchObject({
      priceEur: 856.92,
      shippingEur: 0,
      totalEur: 856.92,
      totalEurNoPrepayment: 865.82,
    })
    expect(byShop('Mindfactory')).toMatchObject({ shippingEur: 8.9, totalEur: 860.79, ratingCount: 9056 })
    // The site's own "unavailable" marking is carried.
    expect(byShop('Proshop.de')?.inStock).toBe(false)
  })

  test('the delivery-and-payment note: methods, free shipping, per-method prices, fees that are not shipping', () => {
    expect(parseGeizhalsPayment('Vorkasse, PayPal GRATISVERSAND . Lieferung nur innerhalb Deutschlands.')).toEqual({
      methods: ['Vorkasse', 'PayPal'],
      shipping: 0,
      shippingNoPrepayment: 0,
    })
    expect(parseGeizhalsPayment('Vorkasse kostenfrei. Kreditkarte, PayPal € 8,90 .')).toEqual({
      methods: ['Vorkasse', 'Kreditkarte', 'PayPal'],
      shipping: 0,
      shippingNoPrepayment: 8.9,
    })
    expect(
      parseGeizhalsPayment(
        'Vorkasse, Kreditkarte, Klarna € 6,90 . Finanzierung € 1,00 . Expressversand ab € 16,90 möglich.',
      ),
    ).toMatchObject({ shipping: 6.9, shippingNoPrepayment: 6.9 })
    expect(parseGeizhalsPayment('Vorkasse GRATISVERSAND .')).toMatchObject({ shipping: 0, shippingNoPrepayment: null })
    expect(parseGeizhalsPayment('Lieferung nur innerhalb Deutschlands.')).toEqual({
      methods: [],
      shipping: null,
      shippingNoPrepayment: null,
    })
  })
})

describe('amazon item seller', () => {
  test('a page Amazon sells itself names Amazon and says so, instead of null', async () => {
    const item = parseItem(await fixture('item-sold-by-amazon'), 'B0GGJ9YH2D')
    expect(item).toMatchObject({
      title: 'CORSAIR Vengeance RGB RS DDR5 64GB (2 x 32GB) Bis zu 6000MHz AMD Intel RAM',
      priceEur: 929.99,
      seller: 'Amazon',
      soldByAmazon: true,
    })
  })

  test('a third-party seller is not Amazon; a page that names none is null, which is a parse miss', async () => {
    expect(parseItem(await fixture('item-with-specs'), 'B0BLBS5SD6')).toMatchObject({
      seller: 'HOMPER',
      soldByAmazon: false,
    })
    expect(parseItem(await fixture('item-unavailable-no-specs'), 'B0DHH3N6T2')).toMatchObject({
      seller: null,
      soldByAmazon: false,
    })
  })
})

describe('shop.offers', () => {
  test('a part number: search, then the one product page, every offer with its facts; no direct request is made', async () => {
    const r = rig({ pages: await idealoPages() })
    const out = await r.offers.call({ product: 'CMK48GX5M2B5600C40' }, r.options)
    expect(r.chrome.reads).toEqual([idealoSearchUrl('CMK48GX5M2B5600C40'), IDEALO_CMK])
    expect(r.direct).toEqual([])
    expect(out.errors).toEqual([])
    expect(out.results).toHaveLength(1)
    const result = out.results[0]!
    expect(result.product).toMatchObject({
      mpn: 'CMK48GX5M2B5600C40',
      memory: { modules: 2, moduleGb: 24, totalGb: 48 },
      offerCount: 11,
    })
    expect(result.offers[0]).toMatchObject({ shop: 'it-veith.de', totalEur: 564.85, rating: 4.7, ratingCount: 204 })
    expect(result.offers[0]!.paymentMethods).toContain('PayPal')
    expect(result.lowestTotalEur).toBe(564.85)
    expect(result.offers.map((o) => o.totalEur)).toEqual(
      [...result.offers.map((o) => o.totalEur)].sort((a, b) => a! - b!),
    )
    expect(out.text).toContain('memory 2 x 24 GB (48 GB)')
    expect(out.text).toContain('it-veith.de')
    // The pause between two page reads is the shop conduct's, browser or not.
    expect(r.usage.map((u) => u.model)).toEqual(['shop-browser', 'shop-browser'])
  })

  test('the 2 x 16 GB kit is stated as 2 x 16 GB (32 GB), never 64 GB', async () => {
    const pages = await idealoPages()
    // Asked in lower case: the search is the asker's text, the comparison is not case-sensitive.
    const r = rig({
      pages: { ...pages, [idealoSearchUrl('pvv532g600c30k')]: pages[idealoSearchUrl('PVV532G600C30K')]! },
    })
    const out = await r.offers.call({ product: 'pvv532g600c30k' }, r.options)
    expect(out.results[0]!.product.memory).toEqual({ modules: 2, moduleGb: 16, totalGb: 32 })
    expect(out.text).toContain('2 x 16 GB (32 GB)')
    expect(out.text).not.toContain('64')
  })

  test('a part number with no exact match is NOT_FOUND and names the near misses; no product page is read', async () => {
    const r = rig({
      pages: {
        [idealoSearchUrl('CMK48GX5M2B5600C4')]: { html: await fixture('idealo-search-cmk'), finalUrl: IDEALO_CATEGORY },
      },
    })
    const error = await failure(r.offers.call({ product: 'CMK48GX5M2B5600C4' }, r.options))
    expect(error.code).toBe('NOT_FOUND')
    expect(error.message).toContain('no product with part number CMK48GX5M2B5600C4')
    expect(error.message).toContain('CMK48GX5M2B5600C40')
    expect(r.chrome.reads).toHaveLength(1)
  })

  test('a search the site answers 404 is NOT_FOUND too', async () => {
    const r = rig({ pages: { [idealoSearchUrl('ZZQ9')]: { fail: 'the page answered HTTP 404' } } })
    const error = await failure(r.offers.call({ product: 'ZZQ9' }, r.options))
    expect(error.code).toBe('NOT_FOUND')
  })

  test('a product page whose own part number differs from the one asked is NOT_FOUND, whatever the search said', async () => {
    const pages = await idealoPages()
    // The search claims the page is the product asked for; the page names another part number.
    pages[IDEALO_CMK] = {
      html: (pages[IDEALO_CMK]!.html as string).replaceAll('CMK48GX5M2B5600C40', 'CMK48GX5M2B5600C41'),
    }
    const r = rig({ pages })
    const error = await failure(r.offers.call({ product: 'CMK48GX5M2B5600C40' }, r.options))
    expect(error.code).toBe('NOT_FOUND')
    expect(error.message).toContain('not CMK48GX5M2B5600C40')
  })

  test('geizhals: a loose search that lists other products is NOT_FOUND; the exact one is read', async () => {
    const pages = {
      [geizhalsSearchUrl('CMK48GX5M2B5600C40')]: { html: await fixture('geizhals-search-cmk') },
      [geizhalsSearchUrl('ZZQ9NOSUCHMPN77')]: { html: await fixture('geizhals-search-fuzzy') },
      [GEIZHALS_CMK]: { html: await fixture('geizhals-product-cmk') },
    }
    const r = rig({ pages })
    const out = await r.offers.call({ product: 'CMK48GX5M2B5600C40', source: 'geizhals' }, r.options)
    expect(out.results[0]!.product).toMatchObject({ source: 'geizhals', gtin: '0840006665021' })
    expect(out.results[0]!.lowestTotalEur).toBe(770.07)
    const none = await failure(r.offers.call({ product: 'ZZQ9NOSUCHMPN77', source: 'geizhals' }, r.options))
    expect(none.code).toBe('NOT_FOUND')
  })

  test('a product URL names its own site; a URL of another shop is refused', async () => {
    const r = rig({ pages: await idealoPages() })
    const out = await r.offers.call({ product: IDEALO_PVV }, r.options)
    expect(out.results[0]!.product.id).toBe('204432987')
    expect(r.chrome.reads).toEqual([IDEALO_PVV])
    const refused = await failure(r.offers.call({ product: 'https://www.example.com/x' }, r.options))
    expect(refused.code).toBe('INVALID_INPUT')
  })

  test('--history adds the idealo series with one more read; geizhals has none', async () => {
    const pages = {
      ...(await idealoPages()),
      [idealoHistoryUrl('202332264', '1Y')]: { html: await fixture('idealo-history') },
    }
    const r = rig({ pages })
    const out = await r.offers.call({ product: 'CMK48GX5M2B5600C40', history: '1Y' }, r.options)
    expect(out.results[0]!.history).toMatchObject({ period: '1Y', lowestEur: 174.92 })
    expect(r.chrome.reads.at(-1)).toBe(idealoHistoryUrl('202332264', '1Y'))
    expect(out.text).toContain('history 1Y: 60 days')
    const refused = await failure(
      r.offers.call({ product: 'CMK48GX5M2B5600C40', source: 'geizhals', history: '1Y' }, r.options),
    )
    expect(refused.code).toBe('INVALID_INPUT')
  })

  test('--source all returns the site that answered and names the one that did not', async () => {
    const pages = {
      ...(await idealoPages()),
      [geizhalsSearchUrl('CMK48GX5M2B5600C40')]: { html: await fixture('geizhals-search-fuzzy') },
    }
    const r = rig({ pages })
    const out = await r.offers.call({ product: 'CMK48GX5M2B5600C40', source: 'all' }, r.options)
    expect(out.results.map((x) => x.source)).toEqual(['idealo'])
    expect(out.errors).toEqual([expect.objectContaining({ source: 'geizhals', code: 'NOT_FOUND' })])
  })

  test('a wall ends the call as blocked (<reason>); no retry, and the cooldown holds only that host', async () => {
    const pages = {
      ...(await idealoPages()),
      [idealoSearchUrl('CMK48GX5M2B5600C40')]: {
        challenge: true,
        html: '<html>Sorry! Something has gone wrong.</html>',
      },
      [geizhalsSearchUrl('CMK48GX5M2B5600C40')]: { html: await fixture('geizhals-search-cmk') },
      [GEIZHALS_CMK]: { html: await fixture('geizhals-product-cmk') },
    }
    const r = rig({ pages })
    const error = await failure(r.offers.call({ product: 'CMK48GX5M2B5600C40' }, r.options))
    expect(error.message).toContain('blocked (bot-protection)')
    expect(r.chrome.reads).toHaveLength(1)
    // The next read of idealo is refused without a request; geizhals is another host.
    const again = await failure(r.offers.call({ product: 'CMK48GX5M2B5600C40', fresh: true }, r.options))
    expect(again.message).toContain('blocked (cooldown)')
    expect(r.chrome.reads).toHaveLength(1)
    const other = await r.offers.call({ product: 'CMK48GX5M2B5600C40', source: 'geizhals' }, r.options)
    expect(other.results[0]!.source).toBe('geizhals')
    // `all` with one site walled answers from the other and reports the wall.
    const both = await r.offers.call({ product: 'CMK48GX5M2B5600C40', source: 'all' }, r.options)
    expect(both.results.map((x) => x.source)).toEqual(['geizhals'])
    expect(both.errors[0]!.message).toContain('blocked (cooldown)')
  })

  test('a wall at geizhals ends that call as blocked (<reason>) too', async () => {
    const r = rig({ pages: { [geizhalsSearchUrl('X1')]: { challenge: true } } })
    const error = await failure(r.offers.call({ product: 'X1', source: 'geizhals' }, r.options))
    expect(error.message).toContain('blocked (bot-protection)')
  })

  test('no research Chrome configured: NOT_CONFIGURED, nothing sent', async () => {
    const r = rig({ browser: false })
    const error = await failure(r.offers.call({ product: 'CMK48GX5M2B5600C40' }, r.options))
    expect(error.code).toBe('NOT_CONFIGURED')
    expect(error.message).toContain('AGW_BROWSER_CDP_URL')
  })

  test('a page repeated inside the hour is served from the cache; --fresh reads it again', async () => {
    const r = rig({ pages: await idealoPages() })
    await r.offers.call({ product: 'CMK48GX5M2B5600C40' }, r.options)
    await r.offers.call({ product: 'CMK48GX5M2B5600C40' }, r.options)
    expect(r.chrome.reads).toHaveLength(2)
    await r.offers.call({ product: 'CMK48GX5M2B5600C40', fresh: true }, r.options)
    expect(r.chrome.reads).toHaveLength(4)
  })
})
