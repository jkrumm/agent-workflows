import { type BrainDeps, createBrainCapabilities } from '../brain/index.ts'
import { createHdxCapabilities, type HdxDeps } from '../hdx/index.ts'
import type { LlmDeps } from '../llm/model-call.ts'
import { iuTransports } from '../transports/index.ts'
import { createWebCapabilities, type WebDeps } from '../web/index.ts'
import { createLlmCapabilities } from './llm.ts'

/**
 * The model-backed capabilities, the research tools, the HyperDX API and the vault tools: one line per group, each
 * group in its own file. `deps`, `web`, `hdx` and `brain` default to production on `process.env`. Not discovered from
 * a directory: the returned tuple is what types `Registry<ReturnType<typeof createCapabilities>>` (every caller's
 * `registry.call(id, input)` is checked against it), and a runtime scan has no static type to give it.
 */
export function createCapabilities(
  deps: LlmDeps = { transports: iuTransports() },
  web: WebDeps = {},
  hdx: HdxDeps = {},
  brain: BrainDeps = {},
) {
  return [
    ...createLlmCapabilities(deps),
    ...createWebCapabilities(web),
    ...createHdxCapabilities(hdx),
    ...createBrainCapabilities(brain),
  ] as const
}
