import type { RouteEntry } from '../schema.ts'
import { EASY, HARD } from './_shared.ts'

const routes = {
  // Software-factory's check on a lead's `factory issue ask`: the owner's, or answerable from the plan or the declared
  // default. Sonnet medium, the HARD tier: measured on the `factory-ask` eval (docs/evals/2026-11-11-factory-ask-judge.md), it keeps
  // more of the owner's questions with the owner than Haiku (none or high); lead-raised Decisions are rare, so the cost is small.
  // It also reads the Decision's class, the Issue as filed and the head of its Spec (a lead's Spec is a Decision now, so this is
  // the one reader in front of the owner); the tier stays, a seat change needs the eval (48 cases, docs/evals/2026-11-21-factory-ask-context.md).
  'factory.ask': { wire: 'anthropic', ...HARD.call },
  // Software-factory's steward: what a stalled Issue needs when the factory's own rules do not say (wake, requeue, or a
  // Decision). Haiku high, as the architecture names for the factory's judging loops. Eval: `factory-steward`, 14 cases (docs/evals/2026-11-16-steward-wording.md).
  'factory.steward': { wire: 'anthropic', ...EASY.call },
  // Software-factory's queue loop: `after` edges and a tie-break order for a repo's queued Issues; the owner's `prio` stands.
  // Eval: `factory-queue`, 10 cases (docs/evals/2026-11-16-factory-decision-suites.md).
  'factory.queue': { wire: 'anthropic', ...EASY.call },
  // Software-factory's triage: amend-or-new when the deterministic match is unsure, and the `after` edges of a new Issue.
  'factory.triage': { wire: 'anthropic', ...EASY.call },
  // Software-factory's Judge screening of held signals: promote, dismiss or leave; an unclear signal waits for the owner.
  // Eval: `factory-screen`, 14 cases committed, no scored run recorded in the journal (2026-11-17).
  'factory.screen': { wire: 'anthropic', ...EASY.call },
  // Software-factory's screening of an Errand (a lead's "I need the owner's hands") before the owner is paged: pass or turn_away.
  // Eval: `factory-errand`, 14 cases committed, no scored run recorded in the journal (2026-11-17).
  'factory.errand': { wire: 'anthropic', ...EASY.call },
  // Software-factory's daily look at an open request with no `check` command: still needed, not needed (closed only with a reason)
  // or unsure. Evidence is the same source's other requests of 14 days; the guard turns a not_needed without evidence into unsure.
  // Eval: `factory-errand-needed`, 14 cases committed, no scored run recorded in the journal (2026-11-17).
  'factory.errandneeded': { wire: 'anthropic', ...EASY.call },
  // Software-factory's screen on a Spec before the owner reads it: his to read (pass) or its lead's (settle, with a reason the lead
  // hears). The owner's marks on earlier Specs come as precedents; the guard turns a settle without a reason into a pass.
  // Eval: `factory-spec-screen`, 21 cases (17 scored in the runs of 2026-11-16, 34 case runs, no hand-written report; the four added on 2026-11-20 are not yet scored).
  'factory.specscreen': { wire: 'anthropic', ...EASY.call },
  // Software-factory's Improve screen: fix commits whose scope and subject do not settle the class, sorted into the classes the
  // caller sends, up to 40 per call. Eval: `factory-fix-classes`, 9 cases (docs/evals/2026-11-16-factory-decision-suites.md); the schema also checks the answer against the request.
  'factory.fixclasses': { wire: 'anthropic', ...EASY.call },
  // Software-factory's hygiene loop: an agent step with read-only tools (read, glob, grep) over a checkout; it reads several
  // files and judges text, so the default agent tier. Eval: `factory-hygiene`, 3 cases (docs/evals/2026-11-16-factory-decision-suites.md); the guard bounds what it can say.
  'factory.hygiene': { wire: 'opencode', ...EASY.agent },
} satisfies Record<string, RouteEntry>

export default routes

declare module '../schema.ts' {
  interface RouteTable extends Record<keyof typeof routes, true> {}
}
