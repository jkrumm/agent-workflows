# Lead handoff — Wave 12 (Central tiers): CLOSE-OUT

Lead, 2026-11-03, Opus, account `me2`. Wave 19's close-out is in git at `9a90ffe`.
Deployed and verified: agw `d781796` (`make verify` PASS incl. hidden smoke review `rv_wekwho24i6ftqubt4lk4`, light, me2;
gateway build `181f23c8608bfc67`). modelpick pushed at `341571a`.

## What landed

| Repo | Commits | What |
|-|-|-|
| agw | `639e2cd` | The tier owns the output ceiling: `FAST.call` 16k, `EASY.call` and `HARD.call` 32k (the default an effort call already got), `DEEPSEEK_FLASH` 16k. `.agent` unchanged (a ceiling there would become an OpenCode `limit.output`). Overrides gone: `digest.items` (16k, now FAST's), `prose.write` (32k, HARD's), `prose.review` (16k, the constant's), `image.enhance` (FAST raised to high and 32k: now plain `EASY`, same model and effort; drained-credit fallback Terra low, was Luna high). Guards in `guard.test.ts`: a Claude route equals its tier step except `wire` (`EFFORT_OVERRIDES` deleted), a route on a cross-lab constant equals the constant, no `opencode` route runs Haiku at `low` or `max` (primary or fallback). README and tier doc comments updated (review routes no longer named) |
| agw | `d781796` | Flaky Wave 19 test (`eval-recall.test.ts`, "a job the factory gave up on…"): the fake handed out job ids in request order while cases run concurrently, so b1 sometimes got `rv_2`. The fake now records the cancelled job's clone. Failed 1 of 3 standalone before, 0 of 6 after. Test-only |
| modelpick | `341571a` | `docs/decisions/agw-text-seats.md`: verdict rewritten for Wave 12 (tiers with ceilings, the guards, review off the routes, `review.*` seats now history) and a 2026-11-03 section with the research golden result |

Already done before this wave, checked and ticked: the four tiers and their fallbacks (Waves 3/6), the model-literal
guard (Wave 15), DeepSeek only on `prose.review` (owner: prose stays DeepSeek), `research.agent` and `otel.agent` on `EASY`
(owner, 2026-11-02/03), no agent `maxOutputTokens` left in the table.

## Gate

- `make check`: 4091/0 on the final tree. The first full run failed only the flaky recall test above.
- `agw check` (the implementer's run): 4087/2, both in `packages/host/test/check-real.test.ts` ("a directory that is not
  a git work tree is refused", "credentials of the host never reach make check…"). They pass 7/7 outside `agw check`
  with the Makefile's test env: they fail only when nested inside the agw check host. Not this change; see Small gaps.
- `make deploy` OK, `make verify` PASS.
- **Live calls per tier and changed route** (`make live-routes`, purpose verify, all on the `iu` credit pool except
  DeepSeek on the personal key): FAST `cheap.classify`, `digest.items`; EASY `cheap.summarize`, `image.enhance`,
  `research.agent`; HARD `prose.write`; `prose.review` DeepSeek. PASS 7/7. DECIDE: `agw decide` answered from
  `microsoft-decision-1` (315 ms).
- **Research golden check:** `agw eval run research`, all 28 cases on Haiku high (fingerprint `7e28fbdb…`), run
  `01a1a176-75b0`: golden 28/28, valid 1.00, complete 0.93, grounded 0.95, `supported` 0.78 (Wave 6: 0.79 on 20), $0.52.
  The 8 cases never run before (5 live registry versions, German retail prices, a German spec sheet, a multi-fact case,
  two not-found) all pass. The lookup set does not separate arms on golden; `supported` stays the metric that moves.
- **Reviews, v4 in-session on Max:**

| Repo, range | Rounds |
|-|-|
| agw `84a668b..d781796` | `rv_wfjeawrveuthqu7pzj3i` standard clean; `covered` true |
| modelpick `c519aaa..341571a` | `rv_so4qvdzj3skneqdlcmiq` light (docs only) clean; `covered` true. The reviewer could not see agw's code from modelpick's tree; the lead checked those claims against `639e2cd` |

## Decisions made here

- **The PLAN's provisional table was not applied.** It puts HARD on Terra medium with a Sonnet low fallback; the
  wave's own header says HARD/EASY keep Wave 6's measured seats, and the owner's research/otel decisions confirm it.
  The table is now history in the plan; the mother may delete it.
- **Ceilings on `.call` only.** An `.agent` ceiling would bound every OpenCode call through `limit.output`; no agent
  needed one.
- **FAST's ceiling is 16k** (the largest FAST user, `digest.items`, needed it); classify/title/prep move from the 8k default
  to 16k. A ceiling, not spend: Haiku without thinking writes what it writes.
- **`image.enhance` fallback Terra low**, not Luna high: the cost of having no override. Only runs on a drained credit.
- Fixed a flaky test in Wave 19's code (untouched otherwise) because it made the gate red; the cause was the fake.

## For Wave 11 (the mother edits PLAN.md)

- The research suite has no arm-separating golden case: if research moves back to Sonnet, it is decided on `supported`
  (0.78 Haiku high vs 0.88 Sonnet medium in Wave 6).
- `model-call.ts`'s 8k/32k defaults are now reached only by an arm that patches `maxOutputTokens: null`; nothing tests
  that path any more.

## Small gaps found

- `check-real.test.ts` fails 2 tests when the agw repo's own gate runs as `agw check` (the host's env and git context leak
  into the test, or the nested make sees the host's tree). Plain `make check` is green. The wave gate and `/check` both
  use `agw check`, so this shows as red there. Not investigated.
- `agw review prepare` takes the scope only as `--scope a..b`; the `/review` skill text says a bare positional range.
  The skill and the CLI disagree (dotfiles skill text).
- `agw check --cwd .` is refused ("cwd must be an absolute path"); the check skill's own example passes `<repo root>`.

## Spend

Max only (`me2`): the lead, 1 implementer run, 2 in-session reviewer runs (standard, light). API: the research eval
$0.52 (Claude credit + web tools + `decide` judge on IU), `make live-routes` and `make verify` cents, `agw decide` $0.000001.

## Left behind

- Wave 12 `done` in PLAN.md with `**Repos:** modelpick`; no wave flipped `active` (Wave 11 waits for 2026-11-17, the
  mother picks). Nothing spawned (orchestrated).
