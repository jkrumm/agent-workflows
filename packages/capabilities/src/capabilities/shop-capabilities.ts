import type { LlmDeps } from '../llm/model-call.ts'
import { resolveWebDeps, type WebDeps } from '../web/deps.ts'
import { createImageRead } from './image-read.ts'
import { createShopFetch, type ShopPace } from './shop-fetch.ts'
import { createShopFind } from './shop-find.ts'
import { createShopItem } from './shop-item.ts'
import { createShopSearch } from './shop-search.ts'

/** What the shop doors and `image.read` are built from beyond the model and web deps. Every field defaults to production. */
export interface ShopDeps {
  /** The clock, the 2-5 s pause and its jitter; tests replace them. */
  pace?: ShopPace
}

/**
 * `image.read` (vision, generic) and the three amazon.de doors: `shop.search`, `shop.item` and `shop.find`. The doors share
 * one fetcher, so one cache and one request at a time cover all three; `shop.find` calls the other capabilities in
 * process, `image.read` for its `--images`.
 */
export function createShopCapabilities(llm: LlmDeps, web: WebDeps = {}, shop: ShopDeps = {}) {
  const resolved = resolveWebDeps(web)
  const fetcher = createShopFetch(resolved, shop.pace)
  const imageRead = createImageRead(llm, resolved)
  const search = createShopSearch(fetcher)
  const item = createShopItem(llm, fetcher)
  return [imageRead, search, item, createShopFind(llm, { search, item, imageRead })] as const
}
