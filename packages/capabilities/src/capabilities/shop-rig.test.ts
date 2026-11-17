import { fakeTransports } from '@agent-workflows/testing/transports'
import { expect } from 'bun:test'
import type { Usage } from '../context.ts'
import { CapabilityCallError } from '../errors.ts'
import { BrowserFailure, type BrowserRead } from '../web/browser.ts'
import type { WebDeps } from '../web/deps.ts'
import { createShopCapabilities } from './shop-capabilities.ts'
import { idealoSearchUrl } from './shop-offers-parse.ts'

// A fake research Chrome and the shop capabilities built over it, for the offers and watch tests.

export const fixture = (name: string) => Bun.file(new URL(`./fixtures/shop/${name}.html.txt`, import.meta.url)).text()

export const IDEALO_CMK =
  'https://www.idealo.de/preisvergleich/OffersOfProduct/202332264_-vengeance-48gb-kit-ddr5-5600-cl40-cmk48gx5m2b5600c40-corsair.html'
export const IDEALO_PVV =
  'https://www.idealo.de/preisvergleich/OffersOfProduct/204432987_-viper-venom-32gb-kit-ddr5-6000-cl30-pvv532g600c30k-patriot.html'
export const GEIZHALS_CMK =
  'https://geizhals.de/corsair-vengeance-schwarz-dimm-kit-48gb-cmk48gx5m2b5600c40-a2900586.html'
export const IDEALO_CATEGORY = 'https://www.idealo.de/preisvergleich/ProductCategory/4552.html?q=x'

export interface Served {
  html?: string
  finalUrl?: string
  challenge?: boolean
  fail?: string
}

/** A research Chrome that serves `pages` by URL prefix and records every read; it opens no process. */
function fakeChrome(pages: Record<string, Served | (() => Served)>) {
  const reads: string[] = []
  const read: BrowserRead = async (url) => {
    reads.push(url)
    const key = Object.keys(pages).find((k) => url.startsWith(k))
    if (!key) throw new BrowserFailure(`no fake page for ${url}`)
    const page = pages[key]!
    const served = typeof page === 'function' ? page() : page
    if (served.fail) throw new BrowserFailure(served.fail)
    return {
      finalUrl: served.finalUrl ?? url,
      title: served.challenge ? 'Just a moment...' : 'page',
      text: 'text',
      challenge: served.challenge ?? false,
      html: served.html ?? '',
    }
  }
  return { read, reads }
}

const clock = () => {
  let t = 1_000_000
  return {
    now: () => t,
    random: () => 0.5,
    sleep: async (ms: number) => {
      t += ms
    },
    advance: (ms: number) => {
      t += ms
    },
    cooldownMs: 15 * 60_000,
  }
}

export interface Rig {
  pages?: Record<string, Served | (() => Served)>
  env?: Record<string, string>
  directFetch?: WebDeps['fetch']
  watch?: { dir: string; notifyFetch?: typeof fetch }
  /** false: no research Chrome is configured. */
  browser?: boolean
}

export function rig({ pages = {}, env = {}, directFetch, watch, browser = true }: Rig = {}) {
  const chrome = fakeChrome(pages)
  const direct: string[] = []
  const web: WebDeps = {
    retry: { backoffMs: 0 },
    warn: () => {},
    resolve: async () => ['93.184.216.34'],
    ...(browser ? { browser: chrome.read } : {}),
    env,
    fetch:
      directFetch ??
      (async (url) => {
        direct.push(url)
        throw new Error(`unexpected direct request to ${url}`)
      }),
  }
  const time = clock()
  const caps = createShopCapabilities({ transports: fakeTransports({}), env: {}, warn: () => {} }, web, {
    pace: time,
    ...(watch ? { watch } : {}),
  })
  const usage: Usage[] = []
  const options = { addUsage: (u: Usage) => usage.push(u) }
  return { chrome, direct, time, offers: caps[4], watch: caps[5], usage, options }
}

export async function failure(promise: Promise<unknown>) {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  )
  expect(error).toBeInstanceOf(CapabilityCallError)
  return error as CapabilityCallError
}

export const idealoPages = async (): Promise<Record<string, Served>> => ({
  [idealoSearchUrl('CMK48GX5M2B5600C40')]: { html: await fixture('idealo-search-cmk'), finalUrl: IDEALO_CATEGORY },
  [idealoSearchUrl('PVV532G600C30K')]: { html: await fixture('idealo-search-pvv'), finalUrl: IDEALO_CATEGORY },
  [IDEALO_CMK]: { html: await fixture('idealo-product-cmk') },
  [IDEALO_PVV]: { html: await fixture('idealo-product-pvv') },
})
