import { describe, expect, test } from 'bun:test'
import { idealoProductId } from './shop-offers-parse.ts'
import {
  categoryPageUrl,
  idealoCategory,
  parseIdealoCategory,
  parseMemorySpec,
  parseSsdSpec,
} from './shop-list-parse.ts'
import { failure, fixture, rig } from './shop-rig.test.ts'

const MEMORY_URL = 'https://www.idealo.de/preisvergleich/ProductCategory/4552F102189759-102286859.html'
const SSD_URL = 'https://www.idealo.de/preisvergleich/ProductCategory/14613F994150.html'
const PSU_URL = 'https://www.idealo.de/preisvergleich/ProductCategory/5432.html'

const memoryPage = async () => parseIdealoCategory(await fixture('idealo-category-memory-48gb'), MEMORY_URL)
const ssdPage = async () => parseIdealoCategory(await fixture('idealo-category-ssd-m2'), SSD_URL)

describe('category URLs', () => {
  test('a category page with filters is taken as given; the query is dropped', () => {
    expect(idealoCategory(MEMORY_URL)).toEqual({ id: '4552', base: MEMORY_URL })
    expect(idealoCategory(`${SSD_URL}?sortKey=minPrice`)).toEqual({ id: '14613', base: SSD_URL })
    expect(idealoCategory(PSU_URL)).toEqual({ id: '5432', base: PSU_URL })
  })

  test('anything else is refused: a product page, a page suffix, another host, a lookalike', () => {
    for (const url of [
      'https://www.idealo.de/preisvergleich/OffersOfProduct/206095266_-ryzen-9-9950x3d-amd.html',
      'https://www.idealo.de/preisvergleich/ProductCategory/14613F994150I16-15.html',
      'https://www.idealo.de/preisvergleich/MainSearchProductCategory.html?q=ssd',
      'https://idealo.de.evil.example/preisvergleich/ProductCategory/5432.html',
      'http://www.idealo.de/preisvergleich/ProductCategory/5432.html',
      'https://geizhals.de/?cat=ramddr3',
      'not a url',
    ])
      expect(idealoCategory(url)).toBeNull()
  })

  test("the sort rides as idealo's own sortKey and page n is idealo's own page suffix", () => {
    const ssd = idealoCategory(SSD_URL)!
    expect(categoryPageUrl(ssd, 'popularity', 0)).toBe(SSD_URL)
    expect(categoryPageUrl(ssd, 'price', 0)).toBe(`${SSD_URL}?sortKey=minPrice`)
    expect(categoryPageUrl(ssd, 'base-price', 0)).toBe(`${SSD_URL}?sortKey=sortMinBasePrice`)
    expect(categoryPageUrl(ssd, 'popularity', 1)).toBe(
      'https://www.idealo.de/preisvergleich/ProductCategory/14613F994150I16-15.html',
    )
    expect(categoryPageUrl(idealoCategory(MEMORY_URL)!, 'price', 2)).toBe(
      'https://www.idealo.de/preisvergleich/ProductCategory/4552F102189759-102286859I16-30.html?sortKey=minPrice',
    )
  })
})

describe('memory category page (48 GB DDR5, 3,082 products)', () => {
  test('the page says its size; the cards of a page are the products kept plus the cards that are no product page', async () => {
    const page = await memoryPage()
    expect(page).toMatchObject({ title: '48 GB DDR5-RAM', totalProducts: 3082, pageCount: 86 })
    expect(page.products.length).toBeGreaterThanOrEqual(30)
    // One used offer (no product page) and one offer card whose link is a form post.
    expect(page.dropped).toEqual({ sponsored: 0, used: 1, other: 1 })
    expect(page.products.length + 2).toBe(36)
  })

  test('the Corsair 2 x 24 GB kit: part number, ids, memory fields, offer count, lowest price', async () => {
    const kit = (await memoryPage()).products.find((p) => p.mpn === 'CMK48GX5M2B5600C40')!
    expect(kit).toMatchObject({
      id: '202332264',
      url: 'https://www.idealo.de/preisvergleich/OffersOfProduct/202332264_-vengeance-48gb-kit-ddr5-5600-cl40-cmk48gx5m2b5600c40-corsair.html',
      name: 'Corsair Vengeance 48GB Kit DDR5-5600 CL40 (CMK48GX5M2B5600C40)',
      kind: 'variant',
      class: 'memory',
      memory: { generation: 5, totalGb: 48, modules: 2, gbPerModule: 24, speedMts: 5600, cl: 40, formFactor: 'UDIMM' },
      offerCount: 11,
      lowestPriceEur: 564.85,
      pricePerGbEur: null,
    })
    expect(kit.specText).toStartWith('DDR5-RAM, 48 GB, Anzahl Module 2, Kapazität pro Modul 24 GB, 5.600 MT/s')
  })

  test('a single 48 GB module has one module', async () => {
    const single = (await memoryPage()).products.find((p) => p.mpn === 'CT48G56C46S5')!
    expect(single.name).toBe('Crucial 48GB DDR5-5600 CL46 (CT48G56C46S5)')
    expect(single.memory).toMatchObject({ totalGb: 48, modules: 1, gbPerModule: 48, speedMts: 5600, cl: 46 })
    expect(single.offerCount).toBe(3)
    expect(single.lowestPriceEur).toBe(942.58)
  })

  test('a card with one offer shows the price without "ab", and a review count without a grade is kept', async () => {
    const pro = (await memoryPage()).products.find((p) => p.mpn === 'CP2K24G56C46U5')!
    expect(pro).toMatchObject({ offerCount: 1, lowestPriceEur: 699, reviewCount: 41, grade: null })
  })

  test('the facet counts of the page: "Kapazität pro Modul: 24 GB 130" and the module counts', async () => {
    const { facets } = await memoryPage()
    const option = (facet: string, label: string) =>
      facets.find((f) => f.name === facet)?.options.find((o) => o.label === label)
    expect(option('Kapazität pro Modul', '24 GB')).toEqual({ label: '24 GB', count: 130, selected: false })
    expect(option('Kapazität pro Modul', '48 GB')?.count).toBe(2195)
    expect(option('Anzahl Module', '2')?.count).toBe(136)
    expect(option('Anzahl Module', '1')?.count).toBe(2189)
    expect(option('Speicherkapazität', '48 GB')).toEqual({ label: '48 GB', count: 3082, selected: true })
    expect(option('Preis', 'bis 1.500 €')?.count).toBe(1876)
  })

  test('every product URL is an idealo product page `shop offers` reads', async () => {
    for (const p of (await memoryPage()).products) expect(idealoProductId(p.url)).toBe(p.id)
  })
})

describe('SSD category page (M.2, 2,077 products)', () => {
  test('a variant: capacity, PCIe, rates, endurance, NAND, price per GB, offers and lowest price', async () => {
    const ssd = (await ssdPage()).products.find((p) => p.name === 'Samsung 990 Pro 2TB')!
    expect(ssd).toMatchObject({
      id: '202132324',
      url: 'https://www.idealo.de/preisvergleich/OffersOfProduct/202132324_-990-pro-2tb-samsung.html',
      mpn: null,
      kind: 'variant',
      class: 'ssd',
      ssd: {
        capacityGb: 2000,
        pcieGen: 4,
        pcieLanes: 4,
        sata: false,
        readMBs: 7450,
        writeMBs: 6900,
        tbw: 1200,
        nand: '3D V-NAND',
        heatsink: false,
      },
      offerCount: 56,
      lowestPriceEur: 370.1,
      pricePerGbEur: 0.19,
      basePriceText: '(0,19 €/GB)',
      grade: 1.6,
      reviewCount: 1350,
    })
  })

  test('a parent: the model with its variants behind it has no capacity and no price per GB', async () => {
    const parent = (await ssdPage()).products.find((p) => p.name === 'Samsung 990 Pro')!
    expect(parent).toMatchObject({
      kind: 'parent',
      offerCount: 336,
      lowestPriceEur: 217.49,
      pricePerGbEur: null,
      ssd: { capacityGb: null, pcieGen: 4, pcieLanes: 4 },
    })
  })

  test('both kinds are on the page, told apart; sponsored cards are dropped, not returned', async () => {
    const page = await ssdPage()
    const kinds = page.products.map((p) => p.kind)
    expect(kinds).toContain('parent')
    expect(kinds).toContain('variant')
    expect(page.products.every((p) => p.kind === (p.ssd!.capacityGb === null ? 'parent' : 'variant'))).toBe(true)
    expect(page.dropped.sponsored).toBe(2)
    expect(page.products.some((p) => /FanXiang|Gesponsert/.test(p.name))).toBe(false)
    expect(page).toMatchObject({ title: 'M.2 SSDs', totalProducts: 2077, pageCount: 58 })
  })

  test('heatsink, endurance and NAND as printed; terabytes are 1000 GB', async () => {
    const products = (await ssdPage()).products
    expect(products.find((p) => p.name === 'Kingston KC3000 512GB')!.ssd).toMatchObject({
      capacityGb: 512,
      heatsink: true,
      tbw: 400,
      nand: '3D TLC',
    })
    expect(products.find((p) => p.name === 'Samsung 9100 Pro 2TB')!.ssd).toMatchObject({
      pcieGen: 5,
      nand: 'V-NAND TLC',
    })
    expect(products.find((p) => p.name === 'Samsung 990 Pro 4TB')!.ssd?.capacityGb).toBe(4000)
    expect(products.find((p) => p.name === 'Kingston NV3 2TB')!.pricePerGbEur).toBe(0.12)
  })

  test('every product URL is an idealo product page `shop offers` reads', async () => {
    for (const p of (await ssdPage()).products) expect(idealoProductId(p.url)).toBe(p.id)
  })
})

describe('other classes: the spec line as text is enough', () => {
  test('power supplies: 36 cards, kind unknown, text kept, offers and price parsed', async () => {
    const page = parseIdealoCategory(await fixture('idealo-category-psu'), PSU_URL)
    expect(page).toMatchObject({ title: 'Netzteile', totalProducts: 3940, pageCount: 110 })
    expect(page.products).toHaveLength(36)
    const first = page.products[0]!
    expect(first).toMatchObject({ name: 'be quiet! Pure Power 13 M', kind: 'unknown', class: 'other', offerCount: 239 })
    expect(first.specText).toStartWith('PC-Netzteil, ATX12V 3.1, vollmodular')
    expect(first.memory).toBeNull()
    expect(first.ssd).toBeNull()
    expect(page.products.every((p) => p.offerCount !== null && p.lowestPriceEur !== null)).toBe(true)
    for (const p of page.products) expect(idealoProductId(p.url)).toBe(p.id)
  })
})

describe('a list sorted by lowest price starts with used offers and SATA cards', () => {
  test('used offers have no product page and are dropped; SATA is not PCIe', async () => {
    const page = parseIdealoCategory(await fixture('idealo-category-ssd-used'), `${SSD_URL}?sortKey=minPrice`)
    expect(page.dropped.used).toBe(1)
    const [parent, variant] = page.products
    expect(parent).toMatchObject({ name: 'Intenso SATA III Top M.2', kind: 'parent' })
    expect(variant).toMatchObject({ name: 'Intenso SATA III Top 128GB M.2', kind: 'variant' })
    expect(variant!.ssd).toMatchObject({ capacityGb: 128, sata: true, pcieGen: null })
  })
})

describe('spec lines', () => {
  test('memory: the stated numbers settle the third, nothing is guessed from the name', () => {
    expect(parseMemorySpec('DDR5-RAM, 48 GB, 5.600 MT/s, PC5-44.800, 1,1 V, SODIMM', 'X 48GB DDR5-5600')).toMatchObject(
      {
        generation: 5,
        totalGb: 48,
        modules: null,
        gbPerModule: null,
        speedMts: 5600,
        cl: null,
        formFactor: 'SODIMM',
      },
    )
    expect(parseMemorySpec('DDR5-RAM, 48 GB, Kapazität pro Modul 24 GB, CL 36-44', 'X')).toMatchObject({
      modules: 2,
      gbPerModule: 24,
      cl: 36,
    })
    expect(parseMemorySpec('DDR5-RAM, 48 GB, Anzahl Module 2, 6.000 MT/s', 'X CL30')).toMatchObject({
      gbPerModule: 24,
      cl: 30,
    })
  })

  test('SSD: terabytes in the name, a TBW in petabytes, no NAND stated', () => {
    expect(parseSsdSpec('interne SSD-Festplatte, PCIe 5.0 x4, NVMe, M.2', 'Foo 4TB')).toMatchObject({
      capacityGb: 4000,
      pcieGen: 5,
      pcieLanes: 4,
      nand: null,
      tbw: null,
    })
    expect(
      parseSsdSpec('interne SSD-Festplatte, max. Schreibvolumen (TBW) 1,2 PB, 960 GB, TLC, PCIe 4.0 x4', 'Foo'),
    ).toMatchObject({
      capacityGb: 960,
      tbw: 1200,
      nand: 'TLC',
    })
  })
})

describe('layouts', () => {
  test('a product page is not a category page, and a page with no result list is an unknown layout', () => {
    expect(() => parseIdealoCategory('<html></html>', MEMORY_URL)).toThrow('unrecognized idealo category layout')
    expect(() =>
      parseIdealoCategory(
        '<div data-testid="result-list"></div>',
        'https://www.idealo.de/preisvergleich/OffersOfProduct/1_-x.html',
      ),
    ).toThrow('product page')
  })

  test('a list with no card is an empty list, not an error', () => {
    expect(parseIdealoCategory('<div data-testid="result-list"></div>', MEMORY_URL).products).toEqual([])
  })
})

describe('shop.list', () => {
  const pages = async () => ({ [MEMORY_URL]: { html: await fixture('idealo-category-memory-48gb') } })

  test('reads one page: the products, the facets, one request, and the read count of the day', async () => {
    const r = rig({ pages: await pages() })
    const out = await r.list.call({ url: MEMORY_URL }, r.options)
    expect(out.products.length).toBeGreaterThanOrEqual(30)
    expect(out.products.find((p) => p.mpn === 'CMK48GX5M2B5600C40')).toMatchObject({
      position: expect.any(Number),
      page: 1,
      kind: 'variant',
    })
    expect(out.products.map((p) => p.position)).toEqual(out.products.map((_, i) => i + 1))
    expect(out.facets.find((f) => f.name === 'Kapazität pro Modul')?.options[0]).toMatchObject({
      label: '24 GB',
      count: 130,
    })
    expect(out.requests).toBe(1)
    expect(out.reads).toEqual({
      host: 'www.idealo.de',
      day: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      count: 1,
      cap: 80,
    })
    expect(out.pages).toHaveLength(1)
    expect(out.stopped).toBeNull()
    expect(r.chrome.reads).toEqual([MEMORY_URL])
    expect(out.text).toContain('reads of www.idealo.de')
    expect(out.text).toContain('Kapazität pro Modul: 24 GB 130')
    expect(out.text).toContain('CMK48GX5M2B5600C40')
  })

  test('a second run within the hour makes no request and counts no read; --fresh reads again', async () => {
    const r = rig({ pages: await pages() })
    await r.list.call({ url: MEMORY_URL }, r.options)
    r.time.advance(30 * 60_000)
    const again = await r.list.call({ url: MEMORY_URL }, r.options)
    expect(again.requests).toBe(0)
    expect(again.pages[0]!.cached).toBe(true)
    expect(again.reads?.count).toBe(1)
    expect(r.chrome.reads).toHaveLength(1)
    r.time.advance(31 * 60_000)
    const later = await r.list.call({ url: MEMORY_URL }, r.options)
    expect(later.requests).toBe(1)
    expect(later.reads?.count).toBe(2)
    const fresh = await r.list.call({ url: MEMORY_URL, fresh: true }, r.options)
    expect(fresh.reads?.count).toBe(3)
    expect(r.chrome.reads).toHaveLength(3)
  })

  test("the sort and the next pages are idealo's own addresses; a page is one request; products are not repeated", async () => {
    const base = 'https://www.idealo.de/preisvergleich/ProductCategory/4552F102189759-102286859'
    const html = await fixture('idealo-category-memory-48gb')
    const r = rig({ pages: { [`${base}.html`]: { html }, [`${base}I16-15.html`]: { html } } })
    const out = await r.list.call({ url: MEMORY_URL, sort: 'price', pages: 2 }, r.options)
    expect(r.chrome.reads).toEqual([`${base}.html?sortKey=minPrice`, `${base}I16-15.html?sortKey=minPrice`])
    // The fake page 2 is page 1 again: nothing new, so the call stops there and says why.
    expect(out.pages).toHaveLength(1)
    expect(out.stopped).toContain('page 2 listed no product that was not on an earlier page')
    expect(out.reads?.count).toBe(2)
    expect(new Set(out.products.map((p) => p.id)).size).toBe(out.products.length)
  })

  test('a second page adds the products that were not on the first, positions continuing (a product listed twice is kept once)', async () => {
    const base = 'https://www.idealo.de/preisvergleich/ProductCategory/14613F994150'
    const r = rig({
      pages: {
        [`${base}.html`]: { html: await fixture('idealo-category-ssd-m2') },
        [`${base}I16-15.html`]: { html: await fixture('idealo-category-ssd-used') },
      },
    })
    const out = await r.list.call({ url: SSD_URL, pages: 2 }, r.options)
    expect(out.pages.map((p) => p.page)).toEqual([1, 2])
    expect(out.products.filter((p) => p.page === 2).map((p) => p.name)).toEqual([
      'Intenso SATA III Top 128GB M.2',
      'MediaRange SATA III 128GB M.2 (MR1021)',
    ])
    expect(out.products.at(-1)!.position).toBe(out.products.length)
  })

  test('a category with fewer pages than asked for is read to its end', async () => {
    const html = (await fixture('idealo-category-ssd-used')).replace(
      '</body>',
      '<div data-testid="pagination"><span aria-label="1">1</span></div></body>',
    )
    const r = rig({ pages: { [SSD_URL]: { html } } })
    const out = await r.list.call({ url: SSD_URL, pages: 4 }, r.options)
    expect(out.pages).toHaveLength(1)
    expect(out.stopped).toBe('the category has 1 page')
    expect(r.chrome.reads).toHaveLength(1)
  })

  test('the daily cap refuses the read past it and sends nothing; the count survives a new process', async () => {
    const env = { AGW_SHOP_DAILY_CAP: 'www.idealo.de=2' }
    const first = rig({ pages: await pages(), env })
    await first.list.call({ url: MEMORY_URL, fresh: true }, first.options)
    await first.list.call({ url: MEMORY_URL, fresh: true }, first.options)
    // A new process over the same directory has an empty cache but the same count.
    const second = rig({ pages: await pages(), env, dir: first.dir })
    const refused = await failure(second.list.call({ url: MEMORY_URL }, second.options))
    expect(refused.message).toContain('daily read cap reached for www.idealo.de: 2 of 2')
    expect(second.chrome.reads).toHaveLength(0)
    expect(first.chrome.reads).toHaveLength(2)
  })

  test('the cap reached on a later page returns the pages already read, and says why it stopped', async () => {
    const base = 'https://www.idealo.de/preisvergleich/ProductCategory/14613F994150'
    const r = rig({
      env: { AGW_SHOP_DAILY_CAP: 'www.idealo.de=1' },
      pages: {
        [`${base}.html`]: { html: await fixture('idealo-category-ssd-m2') },
        [`${base}I16-15.html`]: { html: await fixture('idealo-category-ssd-used') },
      },
    })
    const out = await r.list.call({ url: SSD_URL, pages: 2 }, r.options)
    expect(out.pages).toHaveLength(1)
    expect(out.products.length).toBeGreaterThan(0)
    expect(out.stopped).toContain('daily read cap reached for www.idealo.de: 1 of 1')
    expect(r.chrome.reads).toHaveLength(1)
  })

  test('a wall ends the call as blocked, with no retry and no partial list', async () => {
    const r = rig({ pages: { [MEMORY_URL]: { challenge: true, html: '<html>Just a moment</html>' } } })
    const error = await failure(r.list.call({ url: MEMORY_URL }, r.options))
    expect(error.message).toContain('blocked (bot-protection)')
    expect(r.chrome.reads).toHaveLength(1)
  })

  test('a URL that is no category page is refused before anything is read', async () => {
    const r = rig({ pages: await pages() })
    const error = await failure(
      r.list.call(
        { url: 'https://www.idealo.de/preisvergleich/OffersOfProduct/206095266_-ryzen-9-9950x3d-amd.html' },
        r.options,
      ),
    )
    expect(error.code).toBe('INVALID_INPUT')
    expect(r.chrome.reads).toHaveLength(0)
  })
})
