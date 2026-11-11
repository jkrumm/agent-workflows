import type { RouteEntry } from '../schema.ts'
import { EASY, FAST, HARD } from './_shared.ts'

const routes = {
  // Software-factory's Classify station: project, kind, class, size, tier and effort of one Issue in one tool-free call.
  // The cheapest tier that passes the `factory-classify` eval (README §Route); the model is chosen once, in the tier.
  'factory.classify': { wire: 'anthropic', ...FAST.call },
  // Software-factory's check on a lead's `factory issue ask`: the owner's, or answerable from the plan or the declared
  // default. Sonnet medium, the HARD tier: measured on the `factory-ask` eval (docs/evals/2026-11-11-factory-ask-judge.md), it keeps
  // more of the owner's questions with the owner than Haiku (none or high); lead-raised Decisions are rare, so the cost is small.
  'factory.ask': { wire: 'anthropic', ...HARD.call },
  // Software-factory's steward: what a stalled Issue needs when the factory's own rules do not say (wake, requeue, or a
  // Decision). Haiku high, as the architecture names for the factory's judging loops; no eval set (owner decision).
  'factory.steward': { wire: 'anthropic', ...EASY.call },
  // Software-factory's queue loop: `after` edges and a tie-break order for a repo's queued Issues; the owner's `prio` stands.
  'factory.queue': { wire: 'anthropic', ...EASY.call },
  // Software-factory's triage: amend-or-new when the deterministic match is unsure, and the `after` edges of a new Issue.
  'factory.triage': { wire: 'anthropic', ...EASY.call },
  // Software-factory's Judge screening of held signals: promote, dismiss or leave; an unclear signal waits for the owner.
  'factory.screen': { wire: 'anthropic', ...EASY.call },
  // Software-factory's screening of an Errand (a lead's "I need the owner's hands") before the owner is paged: pass or turn_away.
  'factory.errand': { wire: 'anthropic', ...EASY.call },
  // Software-factory's Improve screen: fix commits whose scope and subject do not settle the class, sorted into the classes the
  // caller sends, up to 40 per call. No eval set; the answer is checked against the request in the schema.
  'factory.fixclasses': { wire: 'anthropic', ...EASY.call },
  // Software-factory's hygiene loop: an agent step with read-only tools (read, glob, grep) over a checkout; it reads several
  // files and judges text, so the default agent tier. No eval set (owner decision); the guard bounds what it can say.
  'factory.hygiene': { wire: 'opencode', ...EASY.agent },
} satisfies Record<string, RouteEntry>

export default routes

declare module '../schema.ts' {
  interface RouteTable extends Record<keyof typeof routes, true> {}
}
