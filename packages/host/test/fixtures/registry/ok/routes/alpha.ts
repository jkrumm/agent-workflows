import type { RouteEntry } from '../../../../../../routes/src/schema.ts'

export default {
  'alpha.agent': { wire: 'opencode', model: 'fixture-model' },
} satisfies Record<string, RouteEntry>
