import type { LlmDeps } from '../llm/model-call.ts'
import { resolveWebDeps, type WebDeps } from '../web/deps.ts'
import { createImageRead } from './image-read.ts'
import { createShopFetch, type ShopPace } from './shop-fetch.ts'
import { createReadBudget, parseDailyCaps, shopDataDir } from './shop-budget.ts'
import { createShopFind } from './shop-find.ts'
import { createShopItem } from './shop-item.ts'
import { createShopList } from './shop-list.ts'
import { createShopOffers } from './shop-offers.ts'
import { createShopSearch } from './shop-search.ts'
import { createShopWatch, type WatchDeps } from './shop-watch.ts'

/** What the shop doors and `image.read` are built from beyond the model and web deps. Every field defaults to production. */
export interface ShopDeps {
  /** The clock, the 2-5 s pause and its jitter; tests replace them. */
  pace?: ShopPace
  /** The directory of the shop's files (the read counter; the watch's files too unless `watch.dir` says otherwise); default `AGW_SHOP_DIR`, else `~/.agent-workflows/data/shop`. Tests set it. */
  dir?: string
  /** The watch's directory and ntfy request; tests replace them. */
  watch?: WatchDeps
}

/**
 * `image.read` (vision, generic), the three amazon.de doors (`shop.search`, `shop.item`, `shop.find`), `shop.offers`
 * (idealo.de, geizhals.de and tech-shop offers by part number), `shop.list` (the products of one idealo category page) and `shop.watch` (one run of the price watch). The doors share one
 * fetcher, so one cache, one pause and one request at a time cover all of them; `shop.find` calls the other capabilities in
 * process, `image.read` for its `--images`.
 */
export function createShopCapabilities(llm: LlmDeps, web: WebDeps = {}, shop: ShopDeps = {}) {
  const resolved = resolveWebDeps(web)
  const env = resolved.env()
  const budget = createReadBudget({
    dir: shop.dir ?? shopDataDir(env),
    now: shop.pace?.now ?? Date.now,
    caps: () => parseDailyCaps(resolved.env().AGW_SHOP_DAILY_CAP),
  })
  const fetcher = createShopFetch(resolved, shop.pace, budget)
  const imageRead = createImageRead(llm, resolved)
  const search = createShopSearch(fetcher)
  const item = createShopItem(llm, fetcher)
  return [
    imageRead,
    search,
    item,
    createShopFind(llm, { search, item, imageRead }),
    createShopOffers(fetcher),
    createShopList(fetcher),
    createShopWatch(fetcher, resolved, shop.pace?.now ?? Date.now, { dir: shop.dir, ...shop.watch }),
  ] as const
}
