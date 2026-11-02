# Lead handoff — Wave 5 (Eval foundations): CLOSE-OUT

Lead `agent-workflows-w1-r8` (pane t73), 2026-11-02 ~10:50 → ~15:20 local. Briefs on the mini (not in git):
`~/.local/state/agent-workflows/briefs/gw5/` (eval-children, agent-json, json-schema-wire, model-route-ids, run-arms).
Branch prefix `gw5/`. Wave 4's close-out is in git history (`509c79e`).

## Live state

agent-workflows release `bf76dc4` (host, audio), gateway build `bc72a6c0ddbc2802` (restarted once, at the digest deploy
`f02f351`: it bundles the route table, which gained the `digest` group and moved `PROVIDER_ECHO`). `make deploy` OK,
`make verify` PASS (smoke `01a19c5d-0fc4-…`, cap `01a19c5d-160a-…`, audio `01a19c5d-1a0c-…`, gateway requests
`01a19c5d-1b6a-…`, `-1fd2-…`, `-29cb-…`, agw-opencode `01a19c5d-3383-…`, smoke review `01a19c5d-7714-…` $0.0819).
`make live-routes` PASS 33 routes ($0.0054). Journal migrations 0013–0015 applied. No `~/.config/agw/routes.json` on the
mini, `AGW_ROUTES` absent from the host's environment. Every fan worktree of the wave cleaned (`rd fan --clean`).

## Per-step verdicts

Two batches, not one: the five steps share `model-call.ts`, runtime `scope.ts`, opencode-host `host.ts` and routes, so
batch 1 owned named functions in those files and run-arms (which needs child case runs) went second.

| Step | Verdict | PRs | Review |
|-|-|-|-|
| Eval cost rolls up | **PASS.** Case replays start with `parentId` = the eval run and stay their own root (`root_id` = own id: own lease, recovery, redelivery to the process that serves the workflow); "drivable on its own" is `id = root_id` (claim, slots, drift, `recentCost`, `driveRoot`, admit; migration 0014 re-keys the partial indexes, equivalent for every old row). A run's `cost`/`unpriced_calls` sum the step rows of the run and all descendants (recursive CTE), never children's `runs.cost`, so a late child record still counts. Regression judge calls run under the eval run. Cancel reaches parented children. `eval.run` output has per-case and total `costUsd`. Live: 2-case `factory-classify` eval `01a19c0f-0a41-…` $0.000640 = two case runs $0.000320 each, gateway rows `api_credit` iu at the same figures | #102 | agw review ×2 (clean, 10 improvements) + `/code-review high` (no lease/rollup/migration defect, 5 nits); design change by the worker (own-root children) approved; two fix rounds |
| Structured agent output | **PASS.** OpenCode 2.0.32's v2 prompt route drops `format` (probed), so a JSON step's location gets a generated plugin tool `submit_result` whose input schema is the step's JSON Schema; OpenCode validates every call and hands a bad one back; the output is the last completed call's input; a turn without one fails `invalid_output`; `parseStructured` deleted. Review angles, synthesis (moved too), check and retrospective use it; handles carry a marker so a pre-deploy JSON session fails by name. Live: smoke reviews at `ca6181c` and `bf76dc4` done with real findings | #101 | agw review (clean, 5 improvements); all fixed; the train hit the known flaky `platform.test.ts` "concurrent runs" once (CI rerun green) |
| Schema output on the wire | **PASS.** `completeJson` sends the zod schema as JSON Schema (`toJsonSchema`, one converter: closed objects, unsupported bounds folded into descriptions, `null` → JSON syntax only): `anthropic` `output_config.format` json_schema beside the effort; `iu-openai` strict `json_schema` for `gpt-*` when every property is required, else `json_object` (DeepSeek refuses json_schema). Every production `completeJson` schema is tested to convert. Sonnet at effort `none` fails table import and overrides. Probes: 14 gateway calls $0.00066. Live: the factory-classify evals above (json_schema on Haiku and Sonnet, all cases valid) | #99 | agw review (clean, 5 improvements); 5 fixed |
| One model id, route id on steps | **PASS.** `canonicalModel` collapses an echo only onto a table model (prefix, `-YYYY-MM-DD` of any family, Claude snapshot, `[1m]`, alias), else the raw id; journal model ids canonical; `steps.route` (migration 0013): the one route the step's calls name, else null. No backfill (cut-over stated in the runtime README). Live: review steps `review.router`/`review.angle`/`review.synthesis` with canonical models | #100 | agw review (clean, 5 improvements); 3 fixed |
| Run-scoped arms | **PASS.** `agw eval run <wf> --arm <file>` (a JSON flag that is not JSON but names a file sends its content); the arm `{routes?, params?}` is validated at admission (table models only on every wire, served models and provider efforts on opencode, Sonnet `none`), stored on `runs.arm` (migration 0015), inherited by every descendant, in the fingerprint; each step gets one `callContext` (signal, usage, attribution, arm) and a guard test fails a hand-built one; the judge always grades on the plain table (`unarmed`); `ctx.param(name, default)`; the OpenCode config registers every valid effort per model. `AGW_ROUTES`, `routes.json` and the launch.sh block deleted, no shim. Live: armed eval `01a19c5d-e4d7-…` ran `factory.classify` on Sonnet low (table: Haiku): case fingerprints `6faa6a…` vs unarmed `299881…`, gateway rows Sonnet `api_credit` $0.006294/$0.006450, eval cost $0.012744 = their sum; a concurrent unarmed `cap.llm.title` stayed on Haiku | #104 | agw review (clean, 5 improvements) + `/code-review high` (2 verified important: review adversary/router and smoke calls dropped the arm; judge inherited it; plus model/effort admission gaps); all fixed in one round |

## Gate evidence

- `make check` in the train after each rebase (last: 3724 pass / 0 fail at #104), CI green on every merge.
- `make deploy` + `make verify` PASS at `ca6181c` (batch 1), `f02f351` (digest) and `bf76dc4` (final); ids above.
- A live call per changed route: `digest.items` (the one new route) PASS, and `make live-routes` PASS on all 33 routes at
  `bf76dc4`, since every resolver's signature changed.
- Usage from stored rows: each live proof matched `agw.runs`/`agw.steps` against `usage.records` (`source='gateway'`).
- Wave API spend: five agw reviews $4.00 (#104's $1.77 was the large diff), three verify smoke reviews ~$0.21, evals
  $0.0134, probes < $0.01, live-routes $0.0054. No eval sweep.

## Departures and lead decisions (for the mother)

- **Case runs are parented but their own root** (worker's finding: the runtime only drove `parent_id is null` runs and
  leased by root): `id = root_id` is now the drivability predicate. Readers meaning "a run the user started" (friction,
  retrospective sample, overview latest, podcast history) stay on `parent_id is null`, so eval case runs drop out of them.
- **`runs.cost` now means the tree** (own steps plus every descendant's) from `ca6181c` on; before it, own steps only.
  Mixed-era comparisons of fan-out workflows' run costs are not comparable (README says so).
- **Agent JSON goes through a tool, not a structured final turn**: the pinned OpenCode has no output format on its v2
  route. The review synthesis moved too (it was the free-text step the 2026-10-31 eval lost).
- **Arms take table models only**: a new model enters the table first. On the opencode wire an arm cannot patch `rate`,
  `maxOutputTokens` or `price` (the server prices and limits per model).
- **Judge runs are unarmed children** of the eval run: their cost rolls up, their grading never moves with the arm.
- **No launch.sh warning for a leftover `routes.json`** (clean migration as instructed; none exists on the mini).
- **FV digest (`#103`, software-factory track) went through this train** at the factory lead's request: lead read the
  diff, merged, deployed, `agw digest` live (run `01a19c44-9fa8-…`), factory lead told.

## Left behind

- A resumed eval that adopts a case run started before `ca6181c` has no `parent_id`: its cost is in the output summary,
  not in the eval run's `cost` (eval README §Cost).
- A rollback past migration 0015 ignores `runs.arm`: drain armed eval runs first (migration comment). A rollback past
  0014 does not claim parented case runs (they wait for a redeploy).
- Known flaky `packages/middleware/test/platform.test.ts` "concurrent runs" failed CI once more (Wave 2 left-behind).
- `docs/review-v2.md:175` and `scripts/launch-gateway.sh:7` still name `AGW_ROUTES`/`routes.json` (a design record and
  a comment asserting the gateway never reads them); `packages/host/test/launch-gateway.test.ts` asserts the absence.
- Historic journal ids `claude-*-eu` and `bedrock/eu.anthropic.*` stay raw (pre-Wave-3, no backfill).
- The synthesis salvage now keeps only the first 160 characters of a failed synthesis's text (the `invalid_output`
  message), not the whole text.
- Review v2's "Docs to fix" list (Wave 8) untouched; `AGENTS.md` status line still stops at Wave 3.
- Carried from Wave 4, unchanged: `me2` placeholder keys, dotfiles `make check` red outside the fleet, brain worktree
  symlinks, Argo cache-hit drag, `agw routes` without the alias map, Codex lane IU key.

## Retro notes for the mother

- **"Disjoint changes, one batch" was not true at the file level.** Naming the owned functions inside shared files let
  four workers run at once with zero merge conflicts; the one real dependency (arms need child runs) became batch 2.
- **A worker stopping to ask beat one routing around the brief**: eval-children found the brief's `root_id` rule would
  strand case runs and asked before writing code; the approved alternative was the right design.
- **Two reviewers again found disjoint things.** On #104 agw review saw audio and the dead parameter; the native review
  found the two call sites that silently dropped the arm (the one defect that would have corrupted Wave 9's numbers).
  On #102 agw review saw spend loss on scorer errors; the native review saw cancel not reaching children.
- **agw review cost scales with the diff**: $1.77 for #104 (+1449 −892) against $0.39–0.81 for the others.
- **The factory's "workers done" fired a dozen times while one worker was mid-turn**; reading the PR head and the
  worker's pane was the reliable signal. A worker ended a turn on a background shell once and had to be told to collect.
- **A CI flake blocks the train on the same sha**: rerunning the train reuses the failed CI run; `gh run rerun --failed`
  first, then the train.
