import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import type { Ctx } from '../context.ts'
import { CapabilityError, fail } from '../errors.ts'
import { defineCapability } from '../procedure.ts'
import type { Env } from '../transports/config.ts'
import { keyOf, type ResolvedWebDeps } from '../web/deps.ts'
import { ITEM_TTL_MS, isBlockedError, type ShopFetch } from './shop-fetch.ts'
import { isMissingPage, readSource } from './shop-offers.ts'
import type { AnySource } from './shop-offers-parse.ts'
import { filterItems, readListing, requireShopifyHost } from './shop-shopify.ts'
import { isShopifySource, type ListingItem } from './shop-shopify-parse.ts'
import { itemUrl, parseItem } from './shop-parse.ts'
import {
  type AlertReason,
  type FeedEntry,
  isOwnPageSource,
  type WatchCandidate,
  cheapest,
  decide,
  emptyState,
  qualifyingOffer,
  type WatchEntry,
  type WatchState,
  watchFileSchema,
} from './shop-watch-rules.ts'

// `shop.watch`: one run of the price watch. For each product of the owner's list it reads the idealo and geizhals offers,
// those of the tech shops Alternate, Mindfactory and Caseking (their own pages), the Shopify stores a product names and the amazon.de item where an ASIN is given, appends one row to the record, and sends one ntfy message when the
// lowest qualifying offer changed state (shop-watch-rules.ts). The feeds of the list (a Shopify collection or search with a
// filter) report matching products not seen before, one message per feed. Files live in one directory on the host.

const NTFY_TOPIC = 'updates'
const NTFY_TIMEOUT_MS = 15_000

/** What a test (or the host) may replace. Every field defaults to production. */
export interface WatchDeps {
  /** The directory of `watch.json`, `state.json` and `record.jsonl`; default `AGW_SHOP_DIR`, else `~/.agent-workflows/data/shop`. */
  dir?: string
  /** The ntfy request (the server is on the tailnet, so not the SSRF-guarded shop fetch). */
  notifyFetch?: typeof fetch
}

const watchInput = z.object({
  dryRun: z
    .boolean()
    .default(false)
    .describe('Read the pages and report what would be recorded and sent; write nothing, send nothing'),
})

const sourceErrorSchema = z.object({ source: z.string(), message: z.string() })

const recordRowSchema = z.object({
  ts: z.string(),
  mpn: z.string(),
  label: z.string(),
  ceilingEur: z.number(),
  lowestTotalEur: z.number().nullable().describe('The cheapest total among the qualifying offers'),
  source: z.string().nullable(),
  shop: z.string().nullable(),
  rating: z.number().nullable(),
  ratingCount: z.int().nullable(),
  offers: z.record(z.string(), z.int()).describe('Offers read per source'),
  qualifying: z.int().describe("Offers that met the entry's rating, count, stock and prepayment rules"),
  alert: z.enum(['ceiling', 'drop']).nullable(),
  notified: z
    .enum(['sent', 'failed', 'off'])
    .nullable()
    .describe('What happened to the message; null when none was due'),
  errors: z.array(sourceErrorSchema),
})
type RecordRow = z.infer<typeof recordRowSchema>

const feedItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  url: z.string(),
  priceEur: z.number().nullable(),
  pricePerGbEur: z.number().nullable(),
  available: z.boolean().nullable(),
  tags: z.array(z.string()),
})

const feedRowSchema = z.object({
  ts: z.string(),
  label: z.string(),
  source: z.string(),
  mode: z.enum(['collection', 'query']),
  read: z.int().describe('Products read before the filter'),
  matched: z.int().describe('Products that pass the filter now'),
  seeded: z.boolean().describe('The first run of the feed: the matches are remembered, nothing is reported as new'),
  newItems: z.array(feedItemSchema).describe('Matching products not seen at an earlier run'),
  notified: z.enum(['sent', 'failed', 'off']).nullable(),
  error: z.string().nullable().describe('Why the feed could not be read (a wall, a layout); null when it was'),
})
type FeedRow = z.infer<typeof feedRowSchema>

const watchOutput = z.object({
  rows: z.array(recordRowSchema),
  feeds: z.array(feedRowSchema),
  sent: z.int().describe('ntfy messages delivered'),
  dryRun: z.boolean(),
  text: z.string(),
})

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** The ntfy settings of the host's environment, or null when the message is off (`NTFY_URL` or `NTFY_TOKEN` unset). */
function ntfyConfig(env: Env): { url: string; token: string } | null {
  const url = (env.NTFY_URL ?? '').trim().replace(/\/+$/, '')
  const token = env.NTFY_TOKEN ?? ''
  return url && token ? { url, token } : null
}

const REASON_TEXT: Record<AlertReason, string> = { ceiling: 'at or under your ceiling', drop: 'a new low' }

/** One message: ASCII title (it travels as a header), the facts a buyer needs, the offer's page as the click target. */
function noticeFor(entry: WatchEntry, best: WatchCandidate, reason: AlertReason, baseline: number | null) {
  const eur = (n: number) => n.toFixed(2)
  const lines = [
    `${entry.label}: ${eur(best.totalEur!)} EUR with shipping, ${REASON_TEXT[reason]} (ceiling ${eur(entry.ceilingEur)} EUR)`,
    `${best.shop ?? best.source}${isOwnPageSource(best.source) ? "'s own page" : ` via ${best.source}`}${best.rating === null ? '' : `, rating ${best.rating} from ${best.ratingCount ?? '?'}`}`,
    ...(baseline === null ? [] : [`was ${eur(baseline)} EUR`]),
  ]
  return { title: `Price: ${entry.label}`.replace(/[^\x20-\x7e]/g, '?'), body: lines.join('\n'), click: best.url }
}

async function send(
  config: { url: string; token: string },
  notice: { title: string; body: string; click: string },
  fetchImpl: typeof fetch,
  signal: AbortSignal,
): Promise<boolean> {
  try {
    const res = await fetchImpl(`${config.url}/${NTFY_TOPIC}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.token}`,
        Title: notice.title,
        Tags: 'chart_with_downwards_trend',
        Click: notice.click,
      },
      body: notice.body,
      signal: AbortSignal.any([signal, AbortSignal.timeout(NTFY_TIMEOUT_MS)]),
    })
    await res.body?.cancel().catch(() => undefined)
    return res.ok
  } catch {
    return false
  }
}

const isMissing = (error: unknown) => (error as { code?: string } | null)?.code === 'ENOENT'

async function readJson(path: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if (isMissing(error)) return undefined
    throw error
  }
}

/** The state file; a file written before the tech shops (`idealoUrl`, `geizhalsUrl`) reads as `pageUrls`. */
const stateFileSchema = z.record(
  z.string(),
  z
    .object({
      pageUrls: z.record(z.string(), z.string().nullable()).optional(),
      idealoUrl: z.string().nullable().optional(),
      geizhalsUrl: z.string().nullable().optional(),
      underCeiling: z.boolean(),
      lastAlertedEur: z.number().nullable(),
      recent: z.array(z.number()),
    })
    .transform(({ idealoUrl, geizhalsUrl, pageUrls, ...rest }) => ({
      ...rest,
      pageUrls: {
        ...(idealoUrl ? { idealo: idealoUrl } : {}),
        ...(geizhalsUrl ? { geizhals: geizhalsUrl } : {}),
        ...pageUrls,
      },
    })),
)

const renderRows = (rows: RecordRow[], feeds: FeedRow[], sent: number, dryRun: boolean) =>
  [
    ...rows.map((r) =>
      [
        r.label.padEnd(24),
        r.lowestTotalEur === null ? 'no qualifying offer'.padEnd(20) : `${r.lowestTotalEur.toFixed(2)} EUR`.padEnd(20),
        r.shop ? `${r.shop} (${r.source})` : '-',
        `ceiling ${r.ceilingEur.toFixed(2)}`,
        r.alert ? `ALERT ${r.alert} ${r.notified ?? ''}`.trim() : '',
        ...r.errors.map((e) => `[${e.source}: ${e.message}]`),
      ]
        .filter(Boolean)
        .join('  '),
    ),
    ...feeds.map((f) =>
      [
        f.label.padEnd(24),
        f.error
          ? `[${f.source}: ${f.error}]`
          : `${f.matched} of ${f.read} match, ${f.seeded ? 'first run, remembered' : `${f.newItems.length} new`}`,
        f.notified ? `ALERT ${f.notified}` : '',
      ]
        .filter(Boolean)
        .join('  '),
    ),
    `${rows.length} products, ${feeds.length} feeds, ${sent} messages${dryRun ? ' (dry run: nothing written, nothing sent)' : ''}`,
  ].join('\n')

type PageCtx = Pick<Ctx, 'signal' | 'addUsage'>

/** What one product's sources gave this run. */
interface Gathered {
  state: WatchState
  candidates: WatchCandidate[]
  offers: Record<string, number>
  errors: RecordRow['errors']
  failures: unknown[]
  /** Sources that answered. */
  reads: number
}

async function gatherSite(
  shop: ShopFetch,
  entry: WatchEntry,
  source: AnySource,
  g: Gathered,
  ctx: PageCtx,
): Promise<void> {
  // A Shopify store is searched by part number each run (one request); its product page `.js` is not the way in.
  const stored = isShopifySource(source) ? null : (g.state.pageUrls[source] ?? null)
  try {
    const read = await readSource(shop, { source, ref: stored ?? entry.mpn, expectMpn: entry.mpn, fresh: true }, ctx)
    g.reads++
    g.state = { ...g.state, pageUrls: { ...g.state.pageUrls, [source]: read.product.url } }
    g.offers[source] = read.offers.length
    for (const offer of read.offers) {
      const candidate = qualifyingOffer(entry, source, offer, read.product.url)
      if (candidate) g.candidates.push(candidate)
    }
  } catch (error) {
    if (ctx.signal.aborted) throw fail('CANCELLED', 'cancelled')
    const notListed = error instanceof CapabilityError && error.code === 'NOT_FOUND'
    // A tech shop that does not list the part number answered: no offer, no error (it is searched again next run).
    if (isOwnPageSource(source) && notListed) {
      g.reads++
      g.offers[source] = 0
    } else {
      g.failures.push(error)
      g.errors.push({ source, message: errorMessage(error) })
    }
    // A stored product page that is gone or no longer names this part number is searched for again next run.
    if (stored && (isMissingPage(error) || notListed))
      g.state = { ...g.state, pageUrls: { ...g.state.pageUrls, [source]: null } }
  }
}

async function gatherAmazon(shop: ShopFetch, asin: string, g: Gathered, ctx: PageCtx): Promise<void> {
  try {
    const page = await shop.page(
      {
        url: itemUrl(asin),
        ttlMs: ITEM_TTL_MS,
        fresh: true,
        label: `the product page ${asin}`,
        parse: (html) => parseItem(html, asin),
      },
      ctx,
    )
    g.reads++
    const item = page.value
    g.offers.amazon = item.priceEur === null ? 0 : 1
    const available = !/nicht verfügbar|derzeit nicht/i.test(item.availability ?? '')
    if (item.soldByAmazon && item.priceEur !== null && available)
      g.candidates.push({
        source: 'amazon',
        shop: 'Amazon',
        rating: null,
        ratingCount: null,
        totalEur: item.priceEur,
        url: item.url,
      })
  } catch (error) {
    if (ctx.signal.aborted) throw fail('CANCELLED', 'cancelled')
    g.failures.push(error)
    g.errors.push({ source: 'amazon', message: errorMessage(error) })
  }
}

async function gather(shop: ShopFetch, entry: WatchEntry, state: WatchState, ctx: PageCtx): Promise<Gathered> {
  const g: Gathered = { state, candidates: [], offers: {}, errors: [], failures: [], reads: 0 }
  await gatherSite(shop, entry, 'idealo', g, ctx)
  await gatherSite(shop, entry, 'geizhals', g, ctx)
  for (const direct of entry.shops) await gatherSite(shop, entry, direct, g, ctx)
  for (const store of entry.shopify) await gatherSite(shop, entry, store as AnySource, g, ctx)
  if (entry.asin) await gatherAmazon(shop, entry.asin, g, ctx)
  return g
}

/** Decides and, when due, sends the message. A message that was not delivered leaves the state armed, so the next run sends it again. */
async function alertFor(
  entry: WatchEntry,
  g: Gathered,
  best: WatchCandidate | null,
  notify: { config: { url: string; token: string } | null; fetch: typeof fetch; dryRun: boolean; signal: AbortSignal },
): Promise<{ alert: AlertReason | null; notified: RecordRow['notified']; state: WatchState }> {
  const decision = decide(entry, g.state, best?.totalEur ?? null)
  if (!decision.alert || !best) return { alert: null, notified: null, state: decision.next }
  const { reason, baselineEur } = decision.alert
  if (notify.dryRun) return { alert: reason, notified: notify.config ? null : 'off', state: decision.next }
  if (!notify.config) return { alert: reason, notified: 'off', state: decision.undelivered }
  const ok = await send(notify.config, noticeFor(entry, best, reason, baselineEur), notify.fetch, notify.signal)
  return ok
    ? { alert: reason, notified: 'sent', state: decision.next }
    : { alert: reason, notified: 'failed', state: decision.undelivered }
}

/** One row of the record: what the run found for one product and what became of the message. */
function recordRow(
  ts: string,
  entry: WatchEntry,
  g: Gathered,
  best: WatchCandidate | null,
  outcome: Pick<RecordRow, 'alert' | 'notified'>,
): RecordRow {
  return {
    ts,
    mpn: entry.mpn,
    label: entry.label,
    ceilingEur: entry.ceilingEur,
    lowestTotalEur: best?.totalEur ?? null,
    source: best?.source ?? null,
    shop: best?.shop ?? null,
    rating: best?.rating ?? null,
    ratingCount: best?.ratingCount ?? null,
    offers: g.offers,
    qualifying: g.candidates.length,
    ...outcome,
    errors: g.errors,
  }
}

const feedStateSchema = z.record(z.string(), z.object({ seen: z.array(z.string()) }))
type FeedState = z.infer<typeof feedStateSchema>

interface Notify {
  config: { url: string; token: string } | null
  fetch: typeof fetch
  dryRun: boolean
  signal: AbortSignal
}

const feedItem = (i: ListingItem) => ({
  id: i.id,
  title: i.title,
  url: i.url,
  priceEur: i.priceEur,
  pricePerGbEur: i.pricePerGbEur,
  available: i.available,
  tags: i.tags,
})

/** One message for a feed: the new products with price and price per GB; the first one's page is the click target. */
function feedNotice(feed: FeedEntry, fresh: ListingItem[]) {
  const line = (i: ListingItem) =>
    `${i.priceEur === null ? '-' : i.priceEur.toFixed(2)} EUR${i.pricePerGbEur === null ? '' : ` (${i.pricePerGbEur.toFixed(3)}/GB)`} ${i.title.slice(0, 90)}`
  const shown = fresh.slice(0, 5).map(line)
  if (fresh.length > shown.length) shown.push(`+${fresh.length - shown.length} more`)
  return { title: `New: ${feed.label}`.replace(/[^\x20-\x7e]/g, '?'), body: shown.join('\n'), click: fresh[0]!.url }
}

/**
 * One feed: the products that match its filter now, the ones not remembered from an earlier run reported as new (one
 * message). The first run of a feed only remembers. A feed that cannot be read is a field of its row and keeps its state;
 * a message that was not delivered keeps the products new for the next run.
 */
async function runFeed(
  shop: ShopFetch,
  feed: FeedEntry,
  state: FeedState,
  notify: Notify,
  ts: string,
  ctx: PageCtx,
): Promise<{ row: FeedRow; seen: string[] | undefined; read: boolean; failure?: unknown }> {
  const seen = state[feed.label]?.seen
  const mode = feed.collection === undefined ? ('query' as const) : ('collection' as const)
  const row = { ts, label: feed.label, source: feed.source, mode }
  try {
    const host = requireShopifyHost(feed.source, 'shop.watch')
    const listing = await readListing(
      shop,
      { host, collection: feed.collection, query: feed.query, pages: feed.pages, limit: 250, fresh: true },
      ctx,
    )
    const matched = filterItems(listing.items, {
      contains: feed.contains,
      maxPriceEur: feed.maxPrice,
      maxPricePerGbEur: feed.maxPricePerGb,
      availableOnly: feed.availableOnly,
    })
    const known = new Set(seen ?? [])
    const fresh = seen === undefined ? [] : matched.filter((i) => !known.has(i.id))
    const ids = matched.map((i) => i.id)
    const base = {
      ...row,
      read: listing.items.length,
      matched: matched.length,
      seeded: seen === undefined,
      newItems: fresh.map(feedItem),
      error: null,
    }
    if (fresh.length === 0) return { row: { ...base, notified: null }, seen: ids, read: true }
    if (notify.dryRun) return { row: { ...base, notified: notify.config ? null : 'off' }, seen: ids, read: true }
    if (!notify.config) return { row: { ...base, notified: 'off' }, seen, read: true }
    const ok = await send(notify.config, feedNotice(feed, fresh), notify.fetch, notify.signal)
    return { row: { ...base, notified: ok ? 'sent' : 'failed' }, seen: ok ? ids : seen, read: true }
  } catch (error) {
    if (ctx.signal.aborted) throw fail('CANCELLED', 'cancelled')
    const failed = {
      ...row,
      read: 0,
      matched: 0,
      seeded: false,
      newItems: [],
      notified: null,
      error: errorMessage(error),
    }
    return { row: failed, seen, read: false, failure: error }
  }
}

/** The record and the state, written atomically enough: the state through a rename. */
async function persist(
  dir: string,
  rows: RecordRow[],
  states: Record<string, WatchState>,
  feeds: { rows: FeedRow[]; state: FeedState },
): Promise<void> {
  await mkdir(dir, { recursive: true })
  await appendFile(join(dir, 'record.jsonl'), rows.map((r) => `${JSON.stringify(r)}\n`).join(''))
  if (feeds.rows.length > 0) {
    await appendFile(join(dir, 'feeds.jsonl'), feeds.rows.map((r) => `${JSON.stringify(r)}\n`).join(''))
    await writeAtomically(join(dir, 'feeds.json'), feeds.state)
  }
  await writeAtomically(join(dir, 'state.json'), states)
}

async function writeAtomically(path: string, value: unknown): Promise<void> {
  const tmp = `${path}.${process.pid}.tmp`
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`)
  await rename(tmp, path)
}

async function readWatchList(dir: string) {
  const listPath = join(dir, 'watch.json')
  const raw = await readJson(listPath)
  if (raw === undefined) throw fail('INVALID_INPUT', `shop.watch: the watch list ${listPath} does not exist`)
  const list = watchFileSchema.safeParse(raw)
  if (!list.success)
    throw fail('INVALID_INPUT', `shop.watch: ${listPath} is not a valid watch list: ${z.prettifyError(list.error)}`)
  return list.data
}

export const createShopWatch = (shop: ShopFetch, web: ResolvedWebDeps, now: () => number, deps: WatchDeps = {}) =>
  defineCapability({
    id: 'shop.watch',
    summary:
      'One run of the price watch: read the offers of every product in the watch list (idealo, geizhals, the tech shops Alternate, Mindfactory and Caseking, amazon.de), append a row per product to the record, send one ntfy message per product whose lowest qualifying offer changed state',
    input: watchInput,
    output: watchOutput,
    cli: { defaultFormat: 'plain', plainField: 'text', mutating: true },
    async handler({ dryRun }, ctx) {
      const dir = deps.dir ?? keyOf(web.env(), 'AGW_SHOP_DIR') ?? join(homedir(), '.agent-workflows', 'data', 'shop')
      const { products, feeds } = await readWatchList(dir)
      const states = stateFileSchema.parse((await readJson(join(dir, 'state.json'))) ?? {}) as Record<
        string,
        WatchState
      >
      const feedState = feedStateSchema.parse((await readJson(join(dir, 'feeds.json'))) ?? {})
      const notify: Notify = {
        config: ntfyConfig(web.env()),
        fetch: deps.notifyFetch ?? fetch,
        dryRun,
        signal: ctx.signal,
      }

      const rows: RecordRow[] = []
      const failures: unknown[] = []
      let reads = 0
      for (const entry of products) {
        if (ctx.signal.aborted) throw fail('CANCELLED', 'cancelled')
        const key = entry.mpn.toUpperCase()
        const g = await gather(shop, entry, { ...emptyState(), ...states[key] }, ctx)
        const best = cheapest(g.candidates)
        const { alert, notified, state } = await alertFor(entry, g, best, notify)
        states[key] = state
        reads += g.reads
        failures.push(...g.failures)
        rows.push(recordRow(new Date(now()).toISOString(), entry, g, best, { alert, notified }))
      }
      // The feeds go last: a wall at a store's collection feed starts that host's cooldown, and the products come first.
      const feedRows: FeedRow[] = []
      const nextFeeds: FeedState = { ...feedState }
      for (const feed of feeds) {
        if (ctx.signal.aborted) throw fail('CANCELLED', 'cancelled')
        const run = await runFeed(shop, feed, feedState, notify, new Date(now()).toISOString(), ctx)
        feedRows.push(run.row)
        if (run.seen !== undefined) nextFeeds[feed.label] = { seen: run.seen }
        if (run.read) reads++
        else failures.push(run.failure)
      }
      if (!dryRun) await persist(dir, rows, states, { rows: feedRows, state: nextFeeds })
      // The run fails only when no source of any product could be read: a blocked site is a field of the row.
      if (reads === 0 && failures.length > 0) throw (failures.find(isBlockedError) ?? failures[0]) as Error
      const sent = [...rows, ...feedRows].filter((r) => r.notified === 'sent').length
      return { rows, feeds: feedRows, sent, dryRun, text: renderRows(rows, feedRows, sent, dryRun) }
    },
  })
