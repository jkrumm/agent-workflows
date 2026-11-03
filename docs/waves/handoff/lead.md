# Lead handoff — Wave 9 (Review v4, agw side): CLOSE-OUT

Lead `agent-workflows-w1-r17`, 2026-11-03, Opus, account `me2`. Wave 18's close-out is in git at `3427f69`.
Deployed: `bde7659` (host and audio healthy; gateway unchanged). CI green on `11b6279` and `bde7659`.

## What landed

| Commit | What |
|-|-|
| `68d58b1` | Host command rule: a command may sit below a shorter one only when the shorter declares no positionals (`agw review` takes none, so `agw review prepare` is legal). `--help` lists subcommands. Concept v3.16 |
| `19362c4` | `REVIEW.md` for this repo (routing globs, failure classes; "one fake per port") |
| `7949532` | `packages/host/src/review/route.ts`: TS port of `route.py`, REVIEW.md frontmatter, `--min` raises only, classifier seam. Parity with the spike: 80 of 80 commits (40 here, 40 dotfiles) |
| `11b6279` | Migration 0017 (`review_jobs`, `review_findings`); `agw review prepare\|submit\|dispose\|status\|route\|covered` as host operations (no journal run, no LLM); REVIEW_OUTPUT v4; ceiling (70 % 5 h / 90 % week) and the deep cap (15/account/UTC day, `AGW_REVIEW_DEEP_CAP`); 16 tests on real Postgres and git through a fake reviewer. Doc: `packages/host/src/review/README.md` |
| `bde7659` | Round-1 fixes: convergence by disposition (settled findings drop, open stay open, `fixed` reopens); REVIEW.md for routing read at the thread base in every round |

REVIEW.md seeded and pushed in the other four repos: dotfiles `54e3f46` (adds "admission belongs to the factory"),
software-factory `682ed27`, usage-tracker `5e558df`, iris `e6689cb` (through a worktree; an iris agent was working).
Routing mix over each repo's last 30 commits (none/light/standard/deep): dotfiles 0/21/6/2, software-factory 6/6/8/10,
usage-tracker 6/6/6/12 (migrations and the credit pass), iris 21/1/3/5 (mostly plan commits).

## Gate

- `make check` (`agw check` run `01a1a080-92e5`): format, lint, typecheck pass; tests fail 4 in files this wave did not
  touch (`check-real.test.ts` ×3, the same as Wave 18; `research-opencode.test.ts` ×1, a 12.7 s timing), all 12 pass
  alone. Load average 15-50 during the run. CI green on the head.
- **Live in-session review on Max, end to end** (the wave's gate, and its own review): thread `90771556bcd3`, range
  `26f58d3..bde7659`.
  - Round 1 `rv_ddx2xwgrsnyz7mh4rrwy`: routed **deep** (2080 prod lines; REVIEW.md did not exist at the base), seat
    Sonnet high with the three-verifier vote. 1 important (3/3: a `fixed` finding re-reported was dropped as a repeat),
    1 nit (route read REVIEW.md at diffBase; its other half, "four repos not seeded", was wrong: they are seeded in
    their own repos). Both disposed `fixed` after `bde7659`.
  - Round 2 `rv_iino4jn4zvqr32gswrpq`: diff-only from the round-1 head, routed **standard**, prior.json carried both
    dispositions; "Nothing needs fixing." Same-attempt resubmit returned the stored output; attempt 2 was refused.
  - `agw review covered --range 26f58d3..HEAD`: true, five commits, each at its required tier.
- `make verify` **not run**: its step 10 is a paid v1 API smoke review (owner: no API review spend). Proof instead: the
  deploy's health checks plus every new command exercised against the live host above.

## For Wave 10 (the mother edits PLAN.md)

- **Callers must pass** `--cwd` (the CLI fills no cwd, as with v1), `--commit` on prepare/submit/dispose (they change
  state), and `--account "$(claude-account account)"`: the host cannot see the caller's account. Without it the ceiling
  is `unjudged` and deep reviews count in a null-account bucket.
- **No `reviewer`/`review-verifier` agent types exist yet.** The live run gave general-purpose agents the spike prompts
  (`docs/spikes/review-v4/{reviewer,review-verifier}.md`) on the seat's model and effort. Wave 10 ships them with
  read-only tools.
- **`covered` ignores outcome**: a submitted review with open `important` findings counts as coverage. Decide whether
  the wave gate and the factory's `ship` also require no open important (I lean yes, via `status`).
- **Names until cutover:** the route operation is HTTP `/review/route-range` (`reviewRouteRange`): v1's capability holds
  `/review/route`. `agw review-route` (v1, LLM) and `agw review route` (v4) coexist. v1's `exec.ts`/`git.ts` must
  move, not die: v4 and `fleet/factory.ts` import them.
- **Deep cap has no allow override** yet (the factory's one-click allow). A held deep review in-session can only wait.
- **Classifier:** the seam only (`decidedBy: 'default'` marks the one case no rule decides); no LLM, no route. Haiku
  for light is a Wave 11 arm; the seat table is `SEATS` in `route.ts`.
- **Edges, documented:** uncommitted changes become an unreferenced snapshot commit in the caller's object store
  (never its index, HEAD or refs); a binary- or mode-only change routes `none`; a repo's first REVIEW.md does not route
  the change that adds it (read at the base, by design); `--pr`/`--branch` reuse v1's `cloneForRef` and have no test
  (needs a fake origin).

## Retro notes (for the mother's log)

- The deep reviewer lingered after replying on `sleep` timers it set to wait for its verifiers (the Wave 18 pattern);
  the round-2 prompt forbade background work and it did not linger. Wave 10's agent definition should say so.
- Round 2 at standard took 4 tool calls and 22 s on a 140-line fix diff. Probably right for that diff; Wave 11 should
  check whether standard reads deep enough on fix rounds.
- I shortened round 1's `checked` list in the copy I submitted, so the ledger holds a stub for it. Wave 10's skill must
  pipe the agent's reply verbatim.
- The model-discipline hook wants `[opus: <reason>]` in an Opus worker's description.
- fallow's complexity audit (advisory, not in `make check`) flags the new `globToRegex`.

## Spend

Max only (`me2`, 5 h ~38 %, week ~68 % at the start): the lead, four implementers (one on Opus for the ledger), two
reviewer runs with three verifiers, one Explore. API: none (`agw check` calls no model; `make verify` not run).

## Left behind

- Wave 10 is `active` in PLAN.md; nothing spawned (orchestrated).
- Wave 15's eval-credit steps and the paused mining job are unchanged from Wave 18.
