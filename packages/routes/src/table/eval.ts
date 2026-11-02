import type { RouteEntry } from '../schema.ts'
import { JUDGE, LABELER_CLAUDE, LABELER_GPT } from './_shared.ts'

const routes = {
  // The review eval's ground truth (docs/review-v2.md §The eval): two labellers on different vendors confirm each mined
  // bug, one judge grades every finding against it. Pinned seats with no fallback (`_shared.ts` §Eval seats).
  'eval.label.a': { wire: 'anthropic', ...LABELER_CLAUDE.call },
  'eval.label.b': { wire: 'iu-openai', ...LABELER_GPT.call },
  'eval.judge': { wire: 'anthropic', ...JUDGE.call },
} satisfies Record<string, RouteEntry>

export default routes

declare module '../schema.ts' {
  interface RouteTable extends Record<keyof typeof routes, true> {}
}
