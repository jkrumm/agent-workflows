import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Offer } from './shop-offers-parse.ts'
import { geizhalsSearchUrl, idealoSearchUrl } from './shop-offers-parse.ts'
import {
  failure,
  fixture,
  GEIZHALS_CMK,
  IDEALO_CATEGORY,
  IDEALO_CMK,
  IDEALO_PVV,
  rig,
  type Served,
} from './shop-rig.test.ts'
import {
  cheapest,
  decide,
  emptyState,
  qualifyingOffer,
  type WatchEntry,
  type WatchState,
  watchEntrySchema,
} from './shop-watch-rules.ts'

const entry = (patch: Partial<WatchEntry> = {}): WatchEntry =>
  watchEntrySchema.parse({ mpn: 'CMK48GX5M2B5600C40', label: 'Corsair 2x24', ceilingEur: 600, ...patch })

const offer = (patch: Partial<Offer> = {}): Offer => ({
  shop: 'shop.example',
  marketplace: false,
  priceEur: 590,
  shippingEur: 0,
  totalEur: 590,
  totalEurNoPrepayment: 590,
  rating: 4.6,
  ratingCount: 120,
  paymentMethods: ['PayPal', 'Vorkasse'],
  prepaymentOnly: false,
  delivery: null,
  inStock: null,
  ...patch,
})

describe('which offers qualify', () => {
  test('the entry defaults: rating 4, 20 ratings, no prepayment, drop 5 %', () => {
    expect(entry()).toMatchObject({ minRating: 4, minRatings: 20, allowPrepayment: false, dropPercent: 5 })
  })

  test('a rating or count under the floor, a missing rating and an unavailable offer do not qualify', () => {
    const e = entry()
    expect(qualifyingOffer(e, 'idealo', offer(), 'u')).toMatchObject({
      totalEur: 590,
      source: 'idealo',
      shop: 'shop.example',
    })
    expect(qualifyingOffer(e, 'idealo', offer({ rating: 3.9 }), 'u')).toBeNull()
    expect(qualifyingOffer(e, 'idealo', offer({ ratingCount: 19 }), 'u')).toBeNull()
    expect(qualifyingOffer(e, 'idealo', offer({ rating: null }), 'u')).toBeNull()
    expect(qualifyingOffer(e, 'idealo', offer({ ratingCount: null }), 'u')).toBeNull()
    expect(qualifyingOffer(e, 'geizhals', offer({ inStock: false }), 'u')).toBeNull()
    expect(qualifyingOffer(e, 'geizhals', offer({ totalEur: null, totalEurNoPrepayment: null }), 'u')).toBeNull()
  })

  test('prepayment: the total that needs no prepayment, unless the entry allows it', () => {
    const cheapOnPrepayment = offer({ totalEur: 560, totalEurNoPrepayment: 575 })
    expect(qualifyingOffer(entry(), 'idealo', cheapOnPrepayment, 'u')?.totalEur).toBe(575)
    expect(qualifyingOffer(entry({ allowPrepayment: true }), 'idealo', cheapOnPrepayment, 'u')?.totalEur).toBe(560)
    const only = offer({
      totalEur: 560,
      totalEurNoPrepayment: null,
      paymentMethods: ['Vorkasse'],
      prepaymentOnly: true,
    })
    expect(qualifyingOffer(entry(), 'idealo', only, 'u')).toBeNull()
    expect(qualifyingOffer(entry({ allowPrepayment: true }), 'idealo', only, 'u')?.totalEur).toBe(560)
  })

  test('the cheapest candidate wins; on a tie the first source does', () => {
    const c = (source: 'idealo' | 'geizhals', totalEur: number) => ({
      source,
      shop: null,
      rating: null,
      ratingCount: null,
      totalEur,
      url: 'u',
    })
    expect(cheapest([c('idealo', 600), c('geizhals', 590)])?.source).toBe('geizhals')
    expect(cheapest([c('idealo', 590), c('geizhals', 590)])?.source).toBe('idealo')
    expect(cheapest([])).toBeNull()
  })
})

describe('when a price is worth a message', () => {
  const e = entry()
  /** Runs a price sequence through `decide`, delivering every message; returns the reasons, null where none was sent. */
  const run = (prices: (number | null)[], start: WatchState = emptyState(), entryUsed = e) => {
    let state = start
    return prices.map((price) => {
      const d = decide(entryUsed, state, price)
      state = d.next
      return d.alert?.reason ?? null
    })
  }

  test('into the ceiling once; the same price again is silent', () => {
    expect(run([640, 600, 600, 600])).toEqual([null, 'ceiling', null, null])
  })

  test('a fall of the drop percentage below the last alerted price is a new message; a smaller one is not', () => {
    // 600 alerted (ceiling); 580 is 3.3 % below, 570 is exactly 5 % below.
    expect(run([600, 580, 570, 570, 560])).toEqual(['ceiling', null, 'drop', null, null])
  })

  test('over the ceiling and back under is a new change of state', () => {
    expect(run([590, 630, 590])).toEqual(['ceiling', null, 'ceiling'])
  })

  test('no qualifying offer resets the ceiling state, so the return alerts again', () => {
    expect(run([590, null, 590])).toEqual(['ceiling', null, 'ceiling'])
  })

  test('above the ceiling, a fall against the last runs is a message once; then the new price is the baseline', () => {
    // Median of the first three is 700; 660 is 5.7 % below it.
    expect(run([700, 700, 700, 660, 660])).toEqual([null, null, null, 'drop', null])
    // The price climbed after the alert (re-armed) and falls again by 5 %.
    expect(run([700, 700, 700, 660, 750, 750, 750, 700])).toEqual([null, null, null, 'drop', null, null, null, 'drop'])
  })

  test('a message that was not delivered leaves the state armed: the next run sends it again', () => {
    const first = decide(e, emptyState(), 590)
    expect(first.alert?.reason).toBe('ceiling')
    const second = decide(e, first.undelivered, 590)
    expect(second.alert?.reason).toBe('ceiling')
    expect(decide(e, first.next, 590).alert).toBeNull()
  })
})

// ---- the capability -------------------------------------------------------------------------------------------------

const AMAZON = 'https://www.amazon.de/dp/B0GGJ9YH2D'
const WATCH = {
  products: [
    { mpn: 'CMK48GX5M2B5600C40', label: 'Corsair 2x24 5600', ceilingEur: 600 },
    { mpn: 'PVV532G600C30K', label: 'Patriot 2x16 6000', ceilingEur: 400 },
    { mpn: 'CMG64GX5M2D6000Z40', label: 'Corsair 2x32 6000', ceilingEur: 850, asin: 'B0GGJ9YH2D' },
  ],
}
const NTFY = { NTFY_URL: 'https://ntfy.example.com/', NTFY_TOKEN: 'token-1' }

async function watchRig(options: { ntfyStatus?: number[]; env?: Record<string, string>; walled?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'shop-watch-'))
  writeFileSync(join(dir, 'watch.json'), JSON.stringify(WATCH))
  const sent: { url: string; headers: Record<string, string>; body: string }[] = []
  const statuses = options.ntfyStatus ?? [200]
  const notifyFetch = (async (url: string, init: RequestInit) => {
    sent.push({ url, headers: init.headers as Record<string, string>, body: String(init.body) })
    return new Response('', { status: statuses[Math.min(sent.length - 1, statuses.length - 1)] })
  }) as unknown as typeof fetch
  const cmkList = await fixture('idealo-search-cmk')
  const fuzzy = await fixture('geizhals-search-fuzzy')
  const pages: Record<string, Served> = options.walled
    ? { [idealoSearchUrl('')]: { challenge: true }, 'https://': { challenge: true } }
    : {
        [idealoSearchUrl('CMK48GX5M2B5600C40')]: { html: cmkList, finalUrl: IDEALO_CATEGORY },
        [idealoSearchUrl('PVV532G600C30K')]: { html: await fixture('idealo-search-pvv'), finalUrl: IDEALO_CATEGORY },
        [idealoSearchUrl('CMG64GX5M2D6000Z40')]: { html: cmkList, finalUrl: IDEALO_CATEGORY },
        [IDEALO_CMK]: { html: await fixture('idealo-product-cmk') },
        [IDEALO_PVV]: { html: await fixture('idealo-product-pvv') },
        [geizhalsSearchUrl('CMK48GX5M2B5600C40')]: { html: await fixture('geizhals-search-cmk') },
        [geizhalsSearchUrl('PVV532G600C30K')]: { html: fuzzy },
        [geizhalsSearchUrl('CMG64GX5M2D6000Z40')]: { html: fuzzy },
        [GEIZHALS_CMK]: { html: await fixture('geizhals-product-cmk') },
      }
  const amazonHtml = await fixture('item-sold-by-amazon')
  const r = rig({
    pages,
    env: options.env ?? NTFY,
    watch: { dir, notifyFetch },
    directFetch: async () =>
      options.walled
        ? new Response('', { status: 429 })
        : new Response(amazonHtml, { status: 200, headers: { 'content-type': 'text/html' } }),
  })
  const records = () =>
    readFileSync(join(dir, 'record.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  return { ...r, dir, sent, records }
}

describe('shop.watch', () => {
  test('a three-product file writes three rows and sends exactly one message, for the product under its ceiling; the next unchanged run sends none', async () => {
    const r = await watchRig()
    const first = await r.watch.call({}, r.options)
    expect(first.rows).toHaveLength(3)
    expect(first.sent).toBe(1)
    expect(r.records()).toHaveLength(3)
    expect(r.sent).toHaveLength(1)
    // The message: the host's ntfy server and token, the shared topic, an ASCII title, the offer's page to open.
    expect(r.sent[0]!.url).toBe('https://ntfy.example.com/updates')
    expect(r.sent[0]!.headers).toMatchObject({
      Authorization: 'Bearer token-1',
      Title: 'Price: Corsair 2x24 5600',
      Click: IDEALO_CMK,
    })
    expect(r.sent[0]!.body).toContain('564.85 EUR')
    expect(r.sent[0]!.body).toContain('it-veith.de via idealo')

    const [cmk, pvv, cmg] = first.rows
    // Idealo's 564,85 € shop qualifies; geizhals' cheaper-looking 770 € offer has one rating and does not count.
    expect(cmk).toMatchObject({
      mpn: 'CMK48GX5M2B5600C40',
      lowestTotalEur: 564.85,
      source: 'idealo',
      shop: 'it-veith.de',
      alert: 'ceiling',
      notified: 'sent',
      errors: [],
    })
    expect(cmk!.offers).toEqual({ idealo: 11, geizhals: 9 })
    // The Patriot kit is on idealo (above its ceiling); geizhals has no such part number and that is a field of the row.
    expect(pvv).toMatchObject({ source: 'idealo', alert: null, notified: null })
    expect(pvv!.lowestTotalEur).toBeGreaterThan(400)
    expect(pvv!.errors).toEqual([
      expect.objectContaining({
        source: 'geizhals',
        message: expect.stringContaining('no product with part number PVV532G600C30K'),
      }),
    ])
    // The third is on neither comparison site: the amazon.de item answers, sold by Amazon.
    expect(cmg).toMatchObject({ lowestTotalEur: 929.99, source: 'amazon', shop: 'Amazon', alert: null })
    expect(cmg!.offers).toEqual({ amazon: 1 })

    const readsAfterFirst = r.chrome.reads.length
    const second = await r.watch.call({}, r.options)
    expect(second.sent).toBe(0)
    expect(r.sent).toHaveLength(1)
    expect(second.rows.every((row) => row.alert === null)).toBe(true)
    expect(r.records()).toHaveLength(6)
    // Known products are read at their stored page: no search for them again.
    const second_reads = r.chrome.reads.slice(readsAfterFirst)
    expect(second_reads).toContain(IDEALO_CMK)
    expect(second_reads).toContain(GEIZHALS_CMK)
    expect(second_reads).not.toContain(idealoSearchUrl('CMK48GX5M2B5600C40'))
    expect(second_reads).not.toContain(geizhalsSearchUrl('CMK48GX5M2B5600C40'))
  })

  test('a message the server refused is not counted: the state stays armed and the next run sends it', async () => {
    const r = await watchRig({ ntfyStatus: [500, 200] })
    const first = await r.watch.call({}, r.options)
    expect(first.sent).toBe(0)
    expect(first.rows[0]).toMatchObject({ alert: 'ceiling', notified: 'failed' })
    const second = await r.watch.call({}, r.options)
    expect(second.sent).toBe(1)
    expect(second.rows[0]).toMatchObject({ alert: 'ceiling', notified: 'sent' })
    const third = await r.watch.call({}, r.options)
    expect(third.sent).toBe(0)
  })

  test('no ntfy settings: the row says the message is off', async () => {
    const r = await watchRig({ env: {} })
    const out = await r.watch.call({}, r.options)
    expect(out.rows[0]).toMatchObject({ alert: 'ceiling', notified: 'off' })
    expect(r.sent).toHaveLength(0)
  })

  test('--dry-run reads and reports, writes no record or state, sends nothing', async () => {
    const r = await watchRig()
    const out = await r.watch.call({ dryRun: true }, r.options)
    expect(out.rows).toHaveLength(3)
    expect(out.rows[0]).toMatchObject({ alert: 'ceiling', notified: null })
    expect(out.text).toContain('dry run')
    expect(r.sent).toHaveLength(0)
    expect(() => readFileSync(join(r.dir, 'record.jsonl'))).toThrow()
    expect(() => readFileSync(join(r.dir, 'state.json'))).toThrow()
  })

  test('a stored product page the site no longer has is searched for again on the next run', async () => {
    const first = await watchRig()
    await first.watch.call({}, first.options)
    const stored = () => JSON.parse(readFileSync(join(first.dir, 'state.json'), 'utf8')).CMK48GX5M2B5600C40
    expect(stored().idealoUrl).toBe(IDEALO_CMK)
    // The stored idealo page answers 404 now (geizhals still answers): the run records it and forgets the URL.
    const next = rig({
      pages: {
        [IDEALO_CMK]: { fail: 'the page answered HTTP 404' },
        [GEIZHALS_CMK]: { html: await fixture('geizhals-product-cmk') },
      },
      env: NTFY,
      watch: { dir: first.dir },
    })
    const out = await next.watch.call({}, next.options)
    expect(out.rows[0]!.errors[0]!.message).toContain('not found (HTTP 404)')
    expect(stored().idealoUrl).toBeNull()
    expect(stored().geizhalsUrl).toBe(GEIZHALS_CMK)
  })

  test('the scheduled call and the make target pass --commit: a mutating command is refused off a TTY without it', () => {
    const root = new URL('../../../../', import.meta.url)
    const plist = readFileSync(new URL('deploy/com.jkrumm.agent-workflows-shop-watch.plist.template', root), 'utf8')
    expect(plist).toMatch(/<string>watch<\/string>\s*(?:<!--[\s\S]*?-->\s*)?<string>--commit<\/string>/)
    expect(readFileSync(new URL('Makefile', root), 'utf8')).toContain('shop watch --commit')
  })

  test('a missing or invalid watch list is INVALID_INPUT, naming the file', async () => {
    const r = await watchRig()
    writeFileSync(join(r.dir, 'watch.json'), JSON.stringify({ products: [{ mpn: 'X', label: 'x', ceilingEur: -1 }] }))
    const invalid = await failure(r.watch.call({}, r.options))
    expect(invalid.code).toBe('INVALID_INPUT')
    expect(invalid.message).toContain('watch.json')
    const empty = mkdtempSync(join(tmpdir(), 'shop-watch-empty-'))
    const none = rig({ watch: { dir: empty } })
    const missing = await failure(none.watch.call({}, none.options))
    expect(missing.message).toContain('does not exist')
  })

  test('every source walled: the rows are still recorded and the run fails as blocked (<reason>)', async () => {
    const r = await watchRig({ walled: true })
    const error = await failure(r.watch.call({}, r.options))
    expect(error.message).toContain('blocked (bot-protection)')
    expect(r.records().length).toBe(3)
    expect(r.records()[0].errors.length).toBeGreaterThan(0)
  })
})
