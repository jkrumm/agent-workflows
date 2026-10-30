import { type BrainDeps, createBrainCapabilities } from '../brain/index.ts'
import { createHdxCapabilities, type HdxDeps } from '../hdx/index.ts'
import { createImageCapabilities, type ImageDeps } from '../image/index.ts'
import type { LlmDeps } from '../llm/model-call.ts'
import { iuTransports } from '../transports/index.ts'
import { createWebCapabilities, type WebDeps } from '../web/index.ts'
import { createLlmCapabilities } from './llm.ts'
import { createWebRead } from './web-read.ts'

/**
 * The model-backed capabilities, the research tools, the HyperDX API, the vault tools and the image tools: one line per group, each
 * group in its own file. `deps`, `web`, `hdx`, `brain` and `image` default to production on `process.env`. Not discovered from
 * a directory: the returned tuple is what types `Registry<ReturnType<typeof createCapabilities>>` (every caller's
 * `registry.call(id, input)` is checked against it), and a runtime scan has no static type to give it.
 */
export function createCapabilities(
  deps: LlmDeps = { transports: iuTransports() },
  web: WebDeps = {},
  hdx: HdxDeps = {},
  brain: BrainDeps = {},
  image: ImageDeps = {},
) {
  const webCapabilities = createWebCapabilities(web)
  return [
    ...createLlmCapabilities(deps),
    ...webCapabilities,
    // The page extraction shares the fetch capability, and so its read cache, with `web.fetch`.
    createWebRead(deps, webCapabilities[1]),
    ...createHdxCapabilities(hdx),
    ...createBrainCapabilities(brain),
    ...createImageCapabilities(image, deps),
  ] as const
}
