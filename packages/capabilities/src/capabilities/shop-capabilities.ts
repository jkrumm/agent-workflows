import type { LlmDeps } from '../llm/model-call.ts'
import { resolveWebDeps, type WebDeps } from '../web/deps.ts'
import { createImageRead } from './image-read.ts'
import { createShopFetch, type ShopPace } from './shop-fetch.ts'
import { createShopFind } from './shop-find.ts'
import { createShopItem } from './shop-item.ts'
import { createShopOffers } from './shop-offers.ts'
import { createShopSearch } from './shop-search.ts'
import { createShopWatch, type WatchDeps } from './shop-watch.ts'

/** What the shop doors and `image.read` are built from beyond the model and web deps. Every field defaults to production. */
export interface ShopDeps {
  /** The clock, the 2-5 s pause and its jitter; tests replace them. */
  pace?: ShopPace
  /** The watch's directory and ntfy request; tests replace them. */
  watch?: WatchDeps
}

/**
 * `image.read` (vision, generic), the three amazon.de doors (`shop.search`, `shop.item`, `shop.find`), `shop.offers`
 * (idealo.de and geizhals.de offers by part number) and `shop.watch` (one run of the price watch). The doors share one
 * fetcher, so one cache, one pause and one request at a time cover all of them; `shop.find` calls the other capabilities in
 * process, `image.read` for its `--images`.
 */
export function createShopCapabilities(llm: LlmDeps, web: WebDeps = {}, shop: ShopDeps = {}) {
  const resolved = resolveWebDeps(web)
  const fetcher = createShopFetch(resolved, shop.pace)
  const imageRead = createImageRead(llm, resolved)
  const search = createShopSearch(fetcher)
  const item = createShopItem(llm, fetcher)
  return [
    imageRead,
    search,
    item,
    createShopFind(llm, { search, item, imageRead }),
    createShopOffers(fetcher),
    createShopWatch(fetcher, resolved, shop.pace?.now ?? Date.now, shop.watch),
  ] as const
}
