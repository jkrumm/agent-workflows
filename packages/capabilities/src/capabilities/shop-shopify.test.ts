import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { failure, rig } from './shop-rig.test.ts'
import {
  capacityOf,
  collectionFeedUrl,
  collectionsUrl,
  parseCollectionFeed,
  parseCollections,
  parseProductJs,
  parseSuggest,
  pricePerGb,
  productJsUrl,
  shopifyHost,
  shopifyProductHandle,
  suggestUrl,
  tagNotes,
  titleMatches,
} from './shop-shopify-parse.ts'

// Fixtures: fixtures/shop/shopify-*.json.txt (provenance in docs/shop.md §Shopify stores). The suggest answer, the product
// (.js) and the collection list are real answers of www.it-veith.de of 2026-11-18, trimmed; the collection feed is
// SYNTHETIC in shape (the store answers its product feeds 429), made of real titles, prices and tags of the store's atom feed.

const fixture = (name: string) => Bun.file(new URL(`./fixtures/shop/${name}.json.txt`, import.meta.url)).text()

const HOST = 'www.it-veith.de'
const SOURCE = 'shopify:www.it-veith.de'
const MPN = 'CMK48GX5M2B5600C40'
const HANDLE =
  'corsair-vengeance-ddr5-64gb-2x32gb-5600mhz-c40-intel-optimierter-desktop-speicher-onboard-spannungsregelung-benutzerdefinierte-xmp-3-0-profile-kompakt-formfaktor-schwarz-cmk64gx5m2b5600c40-3'
const PRODUCT_URL = `https://${HOST}/products/${HANDLE}`

const json = (text: string, status = 200) =>
  new Response(text, { status, headers: { 'content-type': 'application/json; charset=utf-8' } })

async function shopRig(extra: Record<string, () => Response> = {}) {
  const suggest = await fixture('shopify-suggest-cmk')
  const product = await fixture('shopify-product-cmk')
  const collections = await fixture('shopify-collections')
  const feed = await fixture('shopify-collection-feed')
  const requests: string[] = []
  const routes: Record<string, () => Response> = {
    [suggestUrl(HOST, MPN)]: () => json(suggest),
    [productJsUrl(HOST, HANDLE)]: () => json(product),
    [collectionsUrl(HOST)]: () => json(collections),
    [collectionFeedUrl(HOST, 'computer-und-elektronik', 250, 1)]: () => json(feed),
    ...extra,
  }
  const r = rig({
    directFetch: async (url) => {
      requests.push(url)
      return routes[url]?.() ?? new Response('', { status: 404 })
    },
  })
  return { ...r, requests, routes }
}

describe('the Shopify parsers', () => {
  test('the suggest answer carries price, availability, tags and a capacity read from the title, never the handle', async () => {
    const [item] = parseSuggest(await fixture('shopify-suggest-cmk'), HOST)
    expect(item).toMatchObject({
      url: PRODUCT_URL,
      priceEur: 564.85,
      compareAtEur: 816.99,
      available: true,
      vendor: 'Corsair',
      capacityGb: 48,
      gtin: '0840006665021',
      freeShipping: true,
      tags: ['diffbesteuert', 'halfpercday', 'spreadr-hidden;spreadr-hidden'],
    })
    // The handle says 64gb-2x32gb; the title and the product are the 48 GB kit.
    expect(item!.handle).toContain('64gb-2x32gb')
    expect(item!.title.startsWith('Corsair')).toBe(true)
    expect(item!.pricePerGbEur).toBe(11.7677)
    expect(item!.notes).toEqual(['margin scheme (§25a UStG): no VAT shown on the invoice', 'daily markdown'])
  })

  test('the product (.js): one offer per variant in euros from cents, EAN as gtin, free shipping read from the text', async () => {
    const { product, offers, skus } = parseProductJs(await fixture('shopify-product-cmk'), HOST)
    expect(product).toMatchObject({
      source: SOURCE,
      url: PRODUCT_URL,
      gtin: '840006665021',
      capacityGb: 48,
      memory: { modules: 2, moduleGb: 24, totalGb: 48 },
      compareAtEur: 816.99,
      offerCount: 1,
    })
    expect(offers).toEqual([
      {
        shop: 'it-veith.de',
        marketplace: false,
        priceEur: 564.85,
        shippingEur: 0,
        totalEur: 564.85,
        totalEurNoPrepayment: 564.85,
        rating: null,
        ratingCount: null,
        paymentMethods: [],
        prepaymentOnly: false,
        delivery: 'in stock',
        inStock: true,
      },
    ])
    // The part number is in the title only: the SKU and barcode are the EAN.
    expect(skus).not.toContain(MPN)
  })

  test('a product whose text does not say the shipping is free has no total, never a guessed one', async () => {
    const raw = JSON.parse(await fixture('shopify-product-cmk'))
    raw.description = '<p>Auf Lager</p>'
    const { offers } = parseProductJs(JSON.stringify(raw), HOST)
    expect(offers[0]).toMatchObject({ priceEur: 564.85, shippingEur: null, totalEur: null, totalEurNoPrepayment: null })
  })

  test('several variants are several offers, each named by its title', async () => {
    const raw = JSON.parse(await fixture('shopify-product-cmk'))
    raw.variants = [
      { ...raw.variants[0], title: '1 TB', price: 9900, available: false },
      { ...raw.variants[0], title: '2 TB', price: 15900, available: true },
    ]
    const { offers, product } = parseProductJs(JSON.stringify(raw), HOST)
    expect(offers.map((o) => [o.priceEur, o.inStock, o.delivery])).toEqual([
      [99, false, 'unavailable · 1 TB'],
      [159, true, 'in stock · 2 TB'],
    ])
    // The price per GB uses the cheapest available variant.
    expect(product.offerCount).toBe(2)
  })

  test('the collection feed: the cheapest available variant, tags as served, sold out marked', async () => {
    const items = parseCollectionFeed(await fixture('shopify-collection-feed'), HOST)
    expect(items).toHaveLength(5)
    expect(items[0]).toMatchObject({ priceEur: 564.85, available: true, capacityGb: 48 })
    const samsung = items.find((i) => i.title.includes('Samsung'))!
    expect(samsung).toMatchObject({ priceEur: 691.25, capacityGb: 4000, available: true })
    expect(samsung.pricePerGbEur).toBe(0.1728)
    expect(items.find((i) => i.title.includes('acer'))).toMatchObject({ available: false, capacityGb: 2000 })
  })

  test('the collection list names handle, title and count', async () => {
    const list = parseCollections(await fixture('shopify-collections'))
    expect(list).toHaveLength(8)
    expect(list.find((c) => c.handle === 'computer-und-elektronik')).toEqual({
      handle: 'computer-und-elektronik',
      title: 'Computer und Elektronik',
      productsCount: 725,
    })
  })

  test('an answer that is not the endpoint is an error, not an empty list', () => {
    expect(() => parseSuggest('<html>maintenance</html>', HOST)).toThrow('not JSON')
    expect(() => parseCollectionFeed('{"errors":"x"}', HOST)).toThrow('unrecognized layout')
    expect(() => parseProductJs('{}', HOST)).toThrow('unrecognized layout')
  })
})

describe('capacity, price per GB, tags, filters', () => {
  test.each([
    ['Corsair Vengeance DDR5 48GB (2x24GB) 5600MHz C40', 48],
    ['Samsung Portable SSD T9, 4 TB, 2.000 MB/s Lesen', 4000],
    ['acer SSD GM7000 M.2 2TB PCIe G4x4', 2000],
    ['WD Black SN7100 NVMe 4TB, bis 7.250 GB/s', 4000],
    ['Kingston FURY 2 x 16 GB DDR5-6000', 32],
    ['Kingston 1,5 TB Datenträger', 1500],
  ])('%s', (title, gb) => {
    expect(capacityOf(title)?.totalGb).toBe(gb)
  })

  test('a title with no capacity, or only a speed, has none', () => {
    expect(capacityOf('HP Color LaserJet Pro M479fdw')).toBeNull()
    expect(capacityOf('Kabel 10 GB/s')).toBeNull()
    expect(pricePerGb(100, null)).toBeNull()
    expect(pricePerGb(null, capacityOf('4TB'))).toBeNull()
    expect(pricePerGb(523.7, capacityOf('WD SN7100 4TB'))).toBe(0.1309)
  })

  test('the tags this shop was seen to use are explained, the others carried raw', () => {
    expect(tagNotes(['diffbesteuert', '1proday', 'spreadr-hidden;spreadr-hidden'])).toEqual([
      'margin scheme (§25a UStG): no VAT shown on the invoice',
    ])
    expect(tagNotes(['halfpercday'])).toEqual(['daily markdown'])
  })

  test('a title filter: words of one alternative all, alternatives any, any case', () => {
    expect(titleMatches('Corsair DDR5 48GB', 'ddr5')).toBe(true)
    expect(titleMatches('WD Black NVMe SSD 4TB', 'DDR5|NVMe')).toBe(true)
    expect(titleMatches('WD Black NVMe SSD 4TB', 'ddr5 48gb|nvme 8tb')).toBe(false)
    expect(titleMatches('anything', '')).toBe(true)
    expect(titleMatches('anything', undefined)).toBe(true)
  })

  test('stores and product URLs: only the listed stores are known', () => {
    expect(shopifyHost(SOURCE)).toBe(HOST)
    expect(shopifyHost('shopify:evil.example')).toBeNull()
    expect(shopifyHost('idealo')).toBeNull()
    expect(shopifyProductHandle(`${PRODUCT_URL}?_pos=1`)).toEqual({ host: HOST, handle: HANDLE })
    expect(shopifyProductHandle(`${PRODUCT_URL}.js`)).toEqual({ host: HOST, handle: HANDLE })
    expect(shopifyProductHandle('https://evil.example/products/x')).toBeNull()
    expect(shopifyProductHandle(`https://${HOST}/collections/x`)).toBeNull()
  })
})

describe('shop.offers from a Shopify store', () => {
  test('one offer by part number: price, availability, URL and tags, in ONE request', async () => {
    const r = await shopRig()
    const out = await r.offers.call({ product: MPN, source: SOURCE }, r.options)
    expect(r.requests).toEqual([suggestUrl(HOST, MPN)])
    expect(r.chrome.reads).toEqual([])
    const res = out.results[0]!
    expect(res.source).toBe(SOURCE)
    expect(res.offers).toHaveLength(1)
    expect(res.offers[0]).toMatchObject({ shop: 'it-veith.de', priceEur: 564.85, totalEur: 564.85, inStock: true })
    expect(res.product).toMatchObject({
      url: PRODUCT_URL,
      mpn: MPN,
      tags: ['diffbesteuert', 'halfpercday', 'spreadr-hidden;spreadr-hidden'],
      capacityGb: 48,
      pricePerGbEur: 11.7677,
    })
    expect(res.lowestTotalEur).toBe(564.85)
    expect(out.text).toContain('564,85')
    expect(out.text).toContain('memory 2 x 24 GB (48 GB)')
    // The shop's own words reach the plain output, not only the JSON.
    expect(out.text).toContain('capacity 48 GB, 11,768 EUR/GB')
    expect(out.text).toContain('compare-at price 816,99')
    expect(out.text).toContain('tags diffbesteuert, halfpercday')
    expect(out.text).toContain('note: margin scheme (§25a UStG): no VAT shown on the invoice')
    expect(out.text).toContain('note: daily markdown')
  })

  test('the part number must be a whole word of the title: a near miss is NOT_FOUND naming it', async () => {
    const r = await shopRig({
      [suggestUrl(HOST, 'CMK48GX5M2B5600C4')]: async () => json(await fixture('shopify-suggest-cmk')),
    } as never)
    const error = await failure(r.offers.call({ product: 'CMK48GX5M2B5600C4', source: SOURCE }, r.options))
    expect(error.code).toBe('NOT_FOUND')
    expect(error.message).toContain('near misses')
    expect(r.requests).toEqual([suggestUrl(HOST, 'CMK48GX5M2B5600C4')])
  })

  test('a product page URL of the store is read through its .js: its own source, no part number needed', async () => {
    const r = await shopRig()
    const out = await r.offers.call({ product: PRODUCT_URL }, r.options)
    expect(r.requests).toEqual([productJsUrl(HOST, HANDLE)])
    expect(out.results[0]!.source).toBe(SOURCE)
    expect(out.results[0]!.product.mpn).toBeNull()
  })

  test('only the listed stores are read', async () => {
    const r = await shopRig()
    expect((await failure(r.offers.call({ product: MPN, source: 'shopify:evil.example' }, r.options))).code).toBe(
      'INVALID_INPUT',
    )
    expect((await failure(r.offers.call({ product: MPN, source: 'nonsense' }, r.options))).code).toBe('INVALID_INPUT')
    expect((await failure(r.offers.call({ product: 'https://evil.example/products/x' }, r.options))).code).toBe(
      'INVALID_INPUT',
    )
    expect(r.requests).toEqual([])
  })

  test('a wall ends the call as blocked, with no retry, and the host rests', async () => {
    const r = await shopRig({ [suggestUrl(HOST, MPN)]: () => new Response('local_rate_limited', { status: 429 }) })
    const error = await failure(r.offers.call({ product: MPN, source: SOURCE }, r.options))
    expect(error.message).toContain('blocked (rate-limited)')
    expect(r.requests).toEqual([suggestUrl(HOST, MPN)])
    const again = await failure(r.offers.call({ product: MPN, source: SOURCE, fresh: true }, r.options))
    expect(again.message).toContain('blocked (cooldown)')
    expect(r.requests).toHaveLength(1)
  })

  test('a repeat call within the hour is served from the cache', async () => {
    const r = await shopRig()
    await r.offers.call({ product: MPN, source: SOURCE }, r.options)
    const again = await r.offers.call({ product: MPN, source: SOURCE }, r.options)
    expect(again.results[0]!.cached).toBe(true)
    expect(r.requests).toHaveLength(1)
  })
})

describe('shop.store', () => {
  test('no collection or query lists the collections', async () => {
    const r = await shopRig()
    const out = await r.store.call({ source: SOURCE }, r.options)
    expect(out.mode).toBe('collections')
    expect(out.collections.map((c) => c.handle)).toContain('computer-und-elektronik')
    expect(out.text).toContain('computer-und-elektronik  725')
    expect(r.requests).toEqual([collectionsUrl(HOST)])
  })

  test('a collection read returns its products with price, availability and tags', async () => {
    const r = await shopRig()
    const out = await r.store.call({ source: SOURCE, collection: 'computer-und-elektronik' }, r.options)
    expect(out.mode).toBe('collection')
    expect(out.read).toBe(5)
    expect(out.hasMore).toBe(false)
    expect(out.items[0]).toMatchObject({
      priceEur: 564.85,
      available: true,
      tags: expect.arrayContaining(['diffbesteuert']),
    })
    expect(r.requests).toEqual([collectionFeedUrl(HOST, 'computer-und-elektronik', 250, 1)])
    // A plain-format listing can be followed to the product.
    expect(out.text).toContain(PRODUCT_URL)
  })

  test('filters: title words, a ceiling per GB, available only', async () => {
    const r = await shopRig()
    const base = { source: SOURCE, collection: 'computer-und-elektronik' }
    const ssd = await r.store.call({ ...base, contains: 'SSD', maxPricePerGb: 0.15 }, r.options)
    expect(ssd.items.map((i) => i.title)).toEqual([expect.stringContaining('acer')])
    const both = await r.store.call({ ...base, contains: 'DDR5|SSD', availableOnly: true }, r.options)
    expect(both.items).toHaveLength(2)
    expect(both.items.every((i) => i.available)).toBe(true)
    expect(both.read).toBe(5)
    // A ceiling per GB drops what states no capacity: nothing is guessed.
    const none = await r.store.call({ ...base, contains: 'LaserJet', maxPricePerGb: 100 }, r.options)
    expect(none.items).toEqual([])
  })

  test('a full page says there is more; pages are read one request each', async () => {
    const feed = JSON.parse(await fixture('shopify-collection-feed'))
    const r = await shopRig({
      [collectionFeedUrl(HOST, 'c', 2, 1)]: () => json(JSON.stringify({ products: feed.products.slice(0, 2) })),
      [collectionFeedUrl(HOST, 'c', 2, 2)]: () => json(JSON.stringify({ products: feed.products.slice(2, 3) })),
    })
    const out = await r.store.call({ source: SOURCE, collection: 'c', limit: 2, pages: 3 }, r.options)
    expect(out.read).toBe(3)
    expect(out.hasMore).toBe(false)
    expect(r.requests).toEqual([collectionFeedUrl(HOST, 'c', 2, 1), collectionFeedUrl(HOST, 'c', 2, 2)])
    const cut = await r.store.call({ source: SOURCE, collection: 'c', limit: 2, pages: 1, fresh: true }, r.options)
    expect(cut.hasMore).toBe(true)
  })

  test('a closed product feed (429) is a blocked call naming the reason; the search still answers after the cooldown ends', async () => {
    const feedUrl = collectionFeedUrl(HOST, 'computer-und-elektronik', 250, 1)
    const r = await shopRig({ [feedUrl]: () => new Response('local_rate_limited', { status: 429 }) })
    const error = await failure(r.store.call({ source: SOURCE, collection: 'computer-und-elektronik' }, r.options))
    expect(error.message).toContain('blocked (rate-limited)')
    r.time.advance(16 * 60_000)
    const out = await r.store.call({ source: SOURCE, query: MPN }, r.options)
    expect(out.mode).toBe('query')
    expect(out.items).toHaveLength(1)
  })

  test('a collection and a query together, or an unlisted store, are refused', async () => {
    const r = await shopRig()
    expect((await failure(r.store.call({ source: SOURCE, collection: 'a', query: 'b' }, r.options))).code).toBe(
      'INVALID_INPUT',
    )
    expect((await failure(r.store.call({ source: 'shopify:evil.example', query: 'b' }, r.options))).code).toBe(
      'INVALID_INPUT',
    )
  })
})

// ---- the watch ----------------------------------------------------------------------------------------------------------

const NTFY = { NTFY_URL: 'https://ntfy.example.com/', NTFY_TOKEN: 'token-1' }

describe('the watch reads Shopify stores', () => {
  async function watchRig(list: unknown, extra: Record<string, () => Response> = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'shop-watch-shopify-'))
    writeFileSync(join(dir, 'watch.json'), JSON.stringify(list))
    const suggest = await fixture('shopify-suggest-cmk')
    const product = await fixture('shopify-product-cmk')
    const feed = await fixture('shopify-collection-feed')
    const sent: { title: string; body: string }[] = []
    const notifyFetch = (async (_url: string, init: RequestInit) => {
      sent.push({ title: String((init.headers as Record<string, string>).Title), body: String(init.body) })
      return new Response('', { status: 200 })
    }) as unknown as typeof fetch
    const routes: Record<string, () => Response> = {
      [suggestUrl(HOST, MPN)]: () => json(suggest),
      [productJsUrl(HOST, HANDLE)]: () => json(product),
      [collectionFeedUrl(HOST, 'computer-und-elektronik', 250, 1)]: () => json(feed),
      ...extra,
    }
    const requests: string[] = []
    const r = rig({
      env: NTFY,
      watch: { dir, notifyFetch },
      directFetch: async (url) => {
        requests.push(url)
        return routes[url]?.() ?? new Response('', { status: 404 })
      },
    })
    return {
      ...r,
      dir,
      sent,
      routes,
      requests,
      file: (name: string) => JSON.parse(readFileSync(join(dir, name), 'utf8')),
    }
  }

  test('a product names the store as a source: its own price counts, the page is kept for the next run', async () => {
    const r = await watchRig({
      products: [{ mpn: MPN, label: 'Corsair 48', ceilingEur: 600, shops: [], shopify: [SOURCE] }],
    })
    // The aggregators are in the way of this test only as errors: the Chrome has no page for them.
    const out = await r.watch.call({}, r.options)
    const row = out.rows[0]!
    expect(row.offers[SOURCE]).toBe(1)
    expect(row).toMatchObject({
      source: SOURCE,
      shop: 'it-veith.de',
      lowestTotalEur: 564.85,
      alert: 'ceiling',
      notified: 'sent',
    })
    expect(r.file('state.json')[MPN].pageUrls[SOURCE]).toBe(PRODUCT_URL)
    expect(r.sent[0]!.body).toContain("it-veith.de's own page")
    // A store is searched by part number every run (one request); the product page is not its way in.
    r.requests.length = 0
    await r.watch.call({}, r.options)
    expect(r.requests).toEqual([suggestUrl(HOST, MPN)])
  })

  test('a feed remembers its matches on the first run and reports a new matching product on the next', async () => {
    const feedUrl = collectionFeedUrl(HOST, 'computer-und-elektronik', 250, 1)
    const full = JSON.parse(await fixture('shopify-collection-feed'))
    const feedFile = {
      feeds: [
        {
          label: 'Memory and SSD',
          source: SOURCE,
          collection: 'computer-und-elektronik',
          contains: 'DDR5|SSD',
          maxPricePerGb: 20,
        },
      ],
    }
    const r = await watchRig(feedFile, {
      [feedUrl]: () => json(JSON.stringify({ products: full.products.slice(0, 3) })),
    })
    const first = await r.watch.call({}, r.options)
    expect(first.feeds[0]).toMatchObject({
      seeded: true,
      matched: 2,
      read: 3,
      newItems: [],
      notified: null,
      error: null,
    })
    expect(r.sent).toEqual([])
    expect(r.file('feeds.json')['Memory and SSD'].seen).toHaveLength(2)

    r.routes[feedUrl] = () => json(JSON.stringify({ products: full.products }))
    const second = await r.watch.call({}, r.options)
    // The acer SSD is sold out (availableOnly defaults to true): the camera and printer do not match the title words.
    expect(second.feeds[0]).toMatchObject({ seeded: false, matched: 2, newItems: [], notified: null })
    expect(r.sent).toEqual([])

    const extra = {
      ...full.products[0],
      id: 99,
      handle: 'new-ddr5',
      title: '✔️ Kingston FURY 32GB (2x16GB) DDR5-6000',
      variants: [{ ...full.products[0].variants[0], price: '300.00' }],
    }
    r.routes[feedUrl] = () => json(JSON.stringify({ products: [...full.products, extra] }))
    const third = await r.watch.call({}, r.options)
    expect(third.feeds[0]!.newItems.map((i) => [i.id, i.priceEur, i.pricePerGbEur])).toEqual([['99', 300, 9.375]])
    expect(third.feeds[0]!.notified).toBe('sent')
    expect(r.sent[0]!.title).toBe('New: Memory and SSD')
    expect(r.sent[0]!.body).toContain('300.00 EUR (9.375/GB) Kingston FURY')
    expect(third.sent).toBe(1)

    // The same list again is silent.
    await r.watch.call({}, r.options)
    expect(r.sent).toHaveLength(1)
    expect(r.file('feeds.jsonl'.replace('.jsonl', '.json'))['Memory and SSD'].seen).toHaveLength(3)
  })

  test('a feed the store closes is a field of its row; the run goes on and its state is kept', async () => {
    const feedUrl = collectionFeedUrl(HOST, 'computer-und-elektronik', 250, 1)
    const r = await watchRig(
      {
        products: [{ mpn: MPN, label: 'Corsair 48', ceilingEur: 600, shops: [], shopify: [SOURCE] }],
        feeds: [{ label: 'All', source: SOURCE, collection: 'computer-und-elektronik' }],
      },
      { [feedUrl]: () => new Response('local_rate_limited', { status: 429 }) },
    )
    const out = await r.watch.call({}, r.options)
    expect(out.rows[0]!.lowestTotalEur).toBe(564.85)
    expect(out.feeds[0]!.error).toContain('blocked (rate-limited)')
    expect(out.text).toContain('[shopify:www.it-veith.de: ')
  })

  test('a list names an unlisted store or two feeds of one label: refused', async () => {
    const r = await watchRig({ products: [{ mpn: MPN, label: 'x', ceilingEur: 1, shopify: ['shopify:evil.example'] }] })
    expect((await failure(r.watch.call({}, r.options))).code).toBe('INVALID_INPUT')
    const feed = { label: 'a', source: SOURCE, query: 'ddr5' }
    const dup = await watchRig({ feeds: [feed, feed] })
    expect((await failure(dup.watch.call({}, dup.options))).code).toBe('INVALID_INPUT')
    const both = await watchRig({ feeds: [{ ...feed, collection: 'x' }] })
    expect((await failure(both.watch.call({}, both.options))).code).toBe('INVALID_INPUT')
  })
})
