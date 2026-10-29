import type { RouteEntry } from '../../../../../routes/src/schema.ts'

export default {
  'same.route': { wire: 'opencode', model: 'fixture-model' },
} satisfies Record<string, RouteEntry>
