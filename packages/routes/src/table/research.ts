import type { RouteEntry } from '../schema.ts'
import { DEEPSEEK_FLASH } from './_shared.ts'

const routes = {
  // Research agent (concept P3): research-gateway's lead and worker model, DeepSeek flash, which stays a cross-lab seat
  // until the eval picks move it. Single calls on this model are priced by IU's `usage.cost`; an OpenCode session never
  // sees that field and prices each message with the config's cost rows, so the route carries the rate IU's
  // `usage.cost` was measured at (DEEPSEEK_FLASH_RATE, `_shared.ts`).
  'research.agent': { wire: 'opencode', ...DEEPSEEK_FLASH.agent, maxOutputTokens: 16_000 },
} satisfies Record<string, RouteEntry>

export default routes

declare module '../schema.ts' {
  interface RouteTable extends Record<keyof typeof routes, true> {}
}
