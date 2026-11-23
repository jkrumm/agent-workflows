import type { RouteEntry } from '../schema.ts'
import { EASY, HARD } from './_shared.ts'

const routes = {
  // The factory's judges read the case file (factory-case.ts) and move to HARD, the tier that judges (owner direction
  // 2026-11-21: "those agw flows should be very enabled and have all at hand to do good decisions"). Volumes are production
  // runs of the 7 days to 2026-11-21 (agw.runs, purpose not eval); a HARD call costs about 20 times an EASY one before the
  // case file adds its input.
  // Software-factory's Judge on a lead's `factory issue ask`: an agent step with read, glob and grep over the repo's checkout
  // (agents/factory-ask), on HARD since the 2026-11-11 eval (docs/evals/2026-11-11-factory-ask-judge.md). 58 calls a week;
  // as one call it cost about $0.01, as an agent that reads the repo a few times that.
  'factory.ask': { wire: 'opencode', ...HARD.agent },
  // Software-factory's steward: what a stalled Issue needs when the factory's own rules do not say (wake, requeue, or a
  // Decision). 81 calls a week (EASY: $0.001 a call). Eval: `factory-steward`, 14 cases (docs/evals/2026-11-16-steward-wording.md).
  'factory.steward': { wire: 'anthropic', ...HARD.call },
  // Software-factory's queue loop: `after` edges and a tie-break order for a repo's queued Issues; the owner's `prio` stands.
  // 529 calls a week (EASY: $0.0007 a call). Eval: `factory-queue`, 10 cases (docs/evals/2026-11-16-factory-decision-suites.md).
  'factory.queue': { wire: 'anthropic', ...HARD.call },
  // Software-factory's triage: amend-or-new when the deterministic match is unsure, and the `after` edges of a new Issue.
  // The busiest judge: 2,006 calls a week (EASY: $0.0007 a call, so about $28 a week on HARD before the case file). Eval:
  // `factory-triage`, 16 cases.
  'factory.triage': { wire: 'anthropic', ...HARD.call },
  // Software-factory's Judge screening of held signals: promote, dismiss or leave (on a last look promote or dismiss).
  // 2 calls a week. Eval: `factory-screen`, 14 cases.
  'factory.screen': { wire: 'anthropic', ...HARD.call },
  // Software-factory's screening of an Errand (a lead's "I need the owner's hands") before the owner is paged: pass or
  // turn_away. 101 calls a week (EASY: $0.0005 a call). Eval: `factory-errand`, 14 cases.
  'factory.errand': { wire: 'anthropic', ...HARD.call },
  // Software-factory's daily look at an open request with no `check` command: still needed, not needed (closed only with a reason)
  // or unsure. Evidence is the same source's other requests of 14 days; the guard turns a not_needed without evidence into unsure.
  // Stays EASY: the guard makes the cheap direction the safe one. 1 call a week. Eval: `factory-errand-needed`, 14 cases.
  'factory.errandneeded': { wire: 'anthropic', ...EASY.call },
  // Software-factory's look at a gate's Spec before the owner is paged: ready, or back to its lead with what to sharpen. An agent
  // step with read, glob and grep over the repo's checkout (agents/factory-spec-look), the Judge's own seat. Once per gate Spec.
  // Eval: `factory-spec-look`.
  'factory.speclook': { wire: 'opencode', ...HARD.agent },
  // Software-factory's hygiene loop: an agent step with read-only tools (read, glob, grep) over a checkout; it reads several
  // files and judges text, so the default agent tier. Eval: `factory-hygiene`, 3 cases (docs/evals/2026-11-16-factory-decision-suites.md); the guard bounds what it can say.
  'factory.hygiene': { wire: 'opencode', ...EASY.agent },
} satisfies Record<string, RouteEntry>

export default routes

declare module '../schema.ts' {
  interface RouteTable extends Record<keyof typeof routes, true> {}
}
