# Review v3: review on the Claude Code subscriptions

**For the owner (2026-11-03).** Verdict: review moves into **interactive Claude Code sessions on the Max
subscriptions**. Anthropic's own `/code-review` does the finding and our verify vote decides what counts. `agw
review` stays the one interface. A Claude Code caller reviews **in its own session** through a `reviewer` subagent
pinned to Sonnet; every other caller gets **one factory-spawned session per review**. No `claude -p`, no Agent SDK,
no entrypoint relabel. Prepare, assemble, ledger, dispositions and the eval stay agw code. Today's API pipeline (v1)
is the fallback until Wave 11 measures it. The native finder is the **candidate**: adopted for the build, confirmed
or replaced on ground truth in Wave 11 (six PRs here are a direction, not a measurement). Evidence:
`docs/spikes/review-v3/` (S0 policy, S1 transport, S2 cost and quality, S3 concurrency, S4 crash and timeout, S5 verify).
Supersedes `docs/review-v2.md` where they differ (§What of v2 survives).

## Decisions

| # | Decision | Why (spike) |
|-|-|-|
| R1 | The finder is Anthropic's native `/code-review` | Maintained by the team whose practice we follow; found PR #119's real bug, which v1 had called clean (S2); forks itself, so a caller pays ~4.6k tokens of context for the call and its findings (S1) |
| R2 | Levels: `quick` = `low`, `standard` = `high`, `deep` = `xhigh`. **Never `max`** | `max`: 10 finder agents, 21 min, $22 API-eq, then hung waiting on its own finders (S4). `high` $0.29-0.46, `xhigh` $0.86 (S2) |
| R3 | **We add the verify vote**, a severity gate | `high`/`xhigh` run "dedup (no verify)" with a floor of 5 findings (the skill's recipe). Of `high`'s 20 `important` tags, a judge found 2 real, 18 minor, 0 false (S2, one judge); our verifiers kept #118's real one and demoted the 4 minor ones, matching the judge (S5) |
| R4 | One agent, `reviewer` (Sonnet), runs find + verify on both paths | Inside a Sonnet subagent the skill fork and the verifiers all ran on Sonnet, spawn depth ≤ 2, from an Opus caller (S1, S5) |
| R5 | Claude Code callers review **in-session** at `quick`/`standard`; `deep` and every other caller use a **per-job factory spawn** | Per-job spawn and a standing desk cost the same; the desk needs `/clear` and a `cd` it cannot keep, and a crash loses its queue (S1, S4). An in-session review cannot be killed by its caller (Esc does not stop it, S4), so the long level runs where a kill is possible |
| R6 | Every subscription session is the unmodified interactive binary (`entrypoint: cli`, checked per run) | S0: `claude -p`/SDK are the owner's ban, and users measure them at 1.3-3.0x on the 5-hour window (#97074, no Anthropic confirmation); a relabel reports a client that is not the one running, which is how we read the 2026-11-12 clause on misrepresenting the client |
| R7 | The factory decides account and admission; agw adds a review ceiling and a two-session cap | S3: the factory spreads spawns and keeps the owner's reserve; review yields to dev sessions first |
| R8 | API credit only as fallback: v1, adapted to v3 with `degraded: api_fallback` | Credit orgs refuse Claude-Code-shaped requests (`docs/gateway.md`), so the native skill cannot run on credit; v1 can |
| R9 | `deep` adds the native `/security-review` as a second finder and one cross-vendor voter on every `important` finding | v2 had a security finder and a cross-vendor voter at `deep`; today's `/review --deep` runs the security review. The GPT voter is one single call through the gateway in agw's assemble step (credit, cents); at `standard` it is a Wave 11 arm |

## Shape

```
in-session:  /review ─ agw review prepare ─ Agent(reviewer) ─ agw review submit --stdin ─┐
desk:        agw review ─ prepare ─ factory spawn (role reviewer, cwd = job worktree) ──┤─ assemble (code) ─ ledger
api:         agw review --where api ─ v1 ─ adapter ─────────────────────────────────────┘   └ REVIEW_OUTPUT v3
reviewer = native /code-review <level> (forked finder) [+ /security-review at deep] → review-verifier ×K → JSON reply
```

| Stage | Where | What |
|-|-|-|
| prepare | agw code (`git.ts` kept) | Thread and round from the ledger. A throwaway worktree at the head on a local branch **whose upstream is a branch at the base** (the skill diffs `@{upstream}...HEAD`, S1 finding 4). Round ≥ 2: the base is the last reviewed head if it is an ancestor of the new head, else (rebase, amend, force-push) the full round-1 base and the ledger dedupes. `uncommitted` and path scopes: the working-tree diff is committed onto a snapshot branch in the throwaway worktree, never in the caller's tree. `REVIEW.md` is read from the **base**, never from the change. The job: `jobId`, `attempt`, `thread`, `round`, `level`, `worktree`, `base`, `head`, `diffStat` (computed here), `intent` (`--context`, commit messages, PR body), `reviewMd`, `openFindings` |
| find | `reviewer` | `Skill(code-review, "<level> (checked out at <worktree>; git -C <worktree>; diff @{upstream}...HEAD; never check out)")` with `REVIEW.md` and the intent appended (the native skill does not read `REVIEW.md`); at `deep` also `Skill(security-review, …)` |
| verify | `reviewer` | Candidates grouped by file and line (±3); each group to `review-verifier` subagents with **only the claim and absolute paths** (no finder reasoning): `real` (a wrong result, crash, data loss or broken contract in a reachable path; true but harmless = `nit`), tag, a cited `file:line`, one sentence. K = 1 at `quick` and `standard`, 3 at `deep`. Open ledger findings are re-checked (fixed or still present) |
| submit | `agw review submit <jobId> --attempt <n> --stdin` | The reviewer **returns JSON in its reply**; the caller (the `/review` skill, or the desk session's main thread) pipes it here, so the reviewer needs no Write tool. Schema-checked; the reviewer's echoed file list must match the job's `diffStat` (empty-diff guard); idempotent per `(jobId, attempt)`; refused once the job is terminal. Malformed: desk = one repair note to the still-open session; in-session = one re-dispatch of the reviewer; then the attempt fails |
| assemble | agw code | Keep groups with a majority `real` whose cited line exists; at `deep` the cross-vendor voter's verdict counts as one vote; tag `important`/`nit`/`pre-existing`; cap nits (3, `REVIEW.md` overrides); drop what the ledger holds; stable ids per thread; `outcome` and `stepBack` computed |
| ledger | agw journal | The round, findings, run id, engine; dispositions land here. Worktree and snapshot branch removed on submit, failure or timeout; a sweeper removes jobs older than 24 h |

### The agents (dotfiles `agents/`, global, checked in)

- `reviewer`: `model: sonnet`, tools `Read, Grep, Glob, Skill, Agent`. The prompt is the procedure above (draft:
  `docs/spikes/review-v3/data/reviewer-draft.md`): never edit, stage, commit, push or check out; reply with the JSON.
- `review-verifier`: `model: sonnet` (Wave 11 may move it to Haiku), tools `Read, Grep, Glob`, a five-line prompt.
- The native skill's fork runs with its own general-purpose tools (Bash included): the one place a hostile diff could
  try to make a reviewer act. In-session, that is the caller's own trust (the owner's repos). Diffs from outside the
  owner (fork PRs) go to the desk only, where the `reviewer` role runs with a settings deny list (no `Edit`/`Write`
  outside the job dir, no `git push`, no `gh` writes), proven against a planted-injection fixture before cutover.

## Interfaces

| Interface | Shape |
|-|-|
| `agw review [--cwd] [--scope\|--pr\|--branch] [--level quick\|standard\|deep] [--context <intent>] [--where auto\|desk\|api] [--admission-wait <s>] [--format json]` | The entry for every non-Claude-Code caller. `auto`: desk, or api when admission refuses past `--admission-wait` (default 600 s; `make verify` 0). Separate from the CLI's own wait budget (`AGW_WAIT_BUDGET_S`, 110 s): past that the CLI returns exit 10 and `agw run wait <runId>` resumes, as today |
| `agw review prepare [target flags] --level quick\|standard` | The in-session start. Checks the **caller's** account (`CLAUDE_CONFIG_DIR` → `claude-account usage`) against the review ceiling; above it answers `use: --where desk` (another account may have room) or `api`. Prints the job |
| `agw review submit <jobId> --attempt <n> (--stdin\|--file)` | Assembles; prints REVIEW_OUTPUT v3 |
| `agw review dispose <runId> <findingId> fixed\|wrong\|intentional\|irrelevant [--reason]` | From v2, unchanged |
| `/review [--deep] [scope]` (dotfiles skill) | `prepare` → `Agent(reviewer, job)` → `submit` → the fix loop with dispositions and `stepBack`; `--deep` calls `agw review --level deep` (desk). The in-session wait is bounded (10 min); past it the skill abandons the job (`submit` then refuses its late attempt) |
| Factory role `reviewer` (software-factory role table) | Sonnet, effort `high`, hidden, the review ceiling as its admission rule, the settings deny list; the session runs the `reviewer` agent (`--agent reviewer` if the factory passes agent flags, else the prompt delegates to it: one extra turn). Spawn key `review-<jobId>-a<attempt>` |

### How agw drives a desk session

The `review` workflow's `desk` step, journaled like every step: it calls the factory over its socket (`spawn create`,
`spawn get`, `session get`; the token path from the host), records the spawn key, attempt and `startedAt` in the step,
and polls every 2 s for the session state and the submit. A restarted host re-attaches by the recorded key. The
admission wait counts from `queued`, the wall cap from `started`. On submit, cap or death, agw runs `hc kill` + `hc rm`
on the terminal (bounded, like `rd`). A port (`ReviewDesk`) with a fake keeps the tests off the factory and off Max.

### REVIEW_OUTPUT v3

v2's contract plus who ran it. A hard cut: every caller moves in the build wave, no v2 shim.

```ts
{ schemaVersion: 3, runId, thread, round, level: 'quick' | 'standard' | 'deep',
  outcome: 'clean' | 'actionable' | 'needs-human',
  summary,             // starts with the count: "2 important, 1 nit." or "Nothing needs fixing."
  findings: { id, tag: 'important' | 'nit' | 'pre-existing', file, line, endLine?, bugClass,
              message, failureScenario, fix?, votes /* "3/3" */ }[],
  stepBack?, escalationCategory?, degraded?: 'api_fallback' | 'partial',
  engine: { where: 'session' | 'desk' | 'api', model, nativeLevel?, claudeCode? /* version */, account?,
            wallS, apiEqUsd? /* from the transcripts */ } }
```

`outcome` is code: `clean` = no `important`; `needs-human` = a voter-confirmed escalation category or a failed
pipeline. The v1 adapter (fallback only) maps `blocking` to `important` and `improvements` to `nit`, `message` into
`failureScenario`, `votes: "unverified"`, and sets `degraded: api_fallback`.

## Quota guards beside the dev sessions

Measured on `me2` (Max 5x), S2: about **$1.7 API-eq per 1 % of the 5-hour window** (a window's whole account spend,
other sessions included) and **$13 (10.9-18.1) per 1 % of the week**; every request `cli`.

| Level | API-eq per review (find + verify) | 5-hour window, Max 5x | Week |
|-|-|-|-|
| `quick` | ~$0.15 + verify | ~0.1-0.2 % | < 0.02 % |
| `standard` | ~$0.29-0.46 + ~$0.10 per candidate ≈ $0.5-0.9 | ~0.3-0.5 % | ~0.04-0.07 % |
| `deep` (+ security finder, K = 3) | ~$0.86 + ~$0.30 per candidate ≈ $2-4 | ~1-2 % | ~0.15-0.3 % |
| `max` (not offered) | ≥ $22, unfinished | ≥ 12 % | ≥ 1.7 % |

200 standard reviews a week ≈ 10 % of one Max 5x week. The accounts are the fleet's bottleneck (tonight `iu` 87 %,
`me` 95 % of their weeks), so review yields:

1. **Factory admission** for every desk spawn (owner's reserve, `drain`/`pace`, never spill); no second picker.
2. **Review ceiling**, a starting value to tune in Waves 10-11: no new review on an account above 70 % of its 5-hour
   window or 90 % of its week. An account without a 5-hour reading (Ultra) is judged on its week alone. Tonight that
   admits `me2` and `iu`, not `me`. `prepare` applies the same ceiling to an in-session caller's own account.
3. **Two desk sessions at once, host-wide** (agw's semaphore, S3). In-session reviews start no session and count only
   in the per-account record.
4. **Wall cap, enforced by kill:** 5 min `quick`, 10 min `standard`, 25 min `deep` (S4: `high` ≤ 2 min, `xhigh`
   5.4 min); one retry on a fresh key, then `needs-human` with the reason.
5. **Recorded per run:** account, wall, API-eq from the transcripts (the factory's `session get` gives the path), so
   Argo shows review's share of each account's week next to the dev lanes.

## Failure modes

| Failure | Seen | Handling |
|-|-|-|
| No account clears the ceiling | design | wait ≤ `--admission-wait`, then v1, `degraded: api_fallback` |
| Spawn fails or is held (`queued: drain`) | S3 (documented) | counts as admission wait |
| Session dies (crash, core restart) | S4: `dead` in 3 s | attempt failed; one retry on a new key; never resumed |
| Review hangs | S4 (`max`) | wall cap → kill; `max` not offered |
| Cancel | S4: Esc does not stop the background skill | desk: kill; in-session: the bounded wait abandons the job, which is why `deep` never runs in-session |
| Empty or wrong diff | S1 (a `low` run reviewed nothing) | prepare sets the upstream; submit checks the echoed file list against `diffStat` |
| Rebase or force-push between rounds | design | ancestry check → full base, ledger dedupes |
| Malformed or missing reply | design | one repair (note or re-dispatch), then failed attempt |
| Late or duplicate submit | design | idempotent per `(jobId, attempt)`; terminal jobs refuse |
| Leaked worktree | design | removed on every terminal state; 24 h sweeper |
| Finder variance (a `high` run misses what another finds) | S5 | `deep` for risky changes; Wave 9 measures recall with repeats |
| Finder severity inflation | S2, S5 | the verify vote |
| The native skill changes under us | design | `engine.claudeCode` recorded; a new Claude Code version re-runs the `dev` slice; a drop beyond the CI pins the previous version for review sessions |
| A hostile diff | design | read-only `reviewer`/verifier tools; outside diffs desk-only with the deny list (§The agents) |
| Policy moves (meter weighting, terms) | S0 | interactive only; a non-`cli` entrypoint in a review transcript fails the run loudly |

## What of review-v2 survives

| v2 | v3 |
|-|-|
| REVIEW_OUTPUT v3, thread, round, ledger, stable ids, diff-only re-review from round 2, `stepBack` from round 3, dispositions, `REVIEW.md` (template, five busiest repos) | **kept**, with the ancestry rule for rounds |
| Verify vote per finding, context-isolated, cited line, majority | **kept**, as Claude subagents on the subscription; it is now the severity gate |
| Cross-vendor voter on every review | **kept at `deep`** (one gateway call per `important` finding); at `standard` an arm. Research `r3`: cross-model verification is plausible, unproven |
| Security finder at `deep` | **kept**: the native `/security-review` |
| Our own finders (correctness, blast radius, intent lenses) | **gone**: the native skill's angles replace them; intent is passed as context |
| Levels `quick\|standard\|deep` | kept, mapped to native `low\|high\|xhigh` |
| "Eval first, then pick" | kept: the native finder is the build candidate; Wave 11's sweep confirms or replaces it on ground truth |
| The native arm only once, outside routine rescoring | superseded: native is the candidate, so it is a routine arm, paced by the ceiling |
| Ground truth, scorer v3, `agw eval import`, the decision rule, clean controls | **kept** |
| v1 (angles, router, synthesis, adversary, OCR, react-doctor in review) | deleted at cutover, except v1 itself as the API fallback. It stays only if its recall is inside the pick's CI; otherwise the fallback is "wait for quota" and v1 goes |

## Migration of every caller

The inventory (2026-11-03) found one CLI caller outside agent-workflows and no HTTP caller.

| Caller | Today | v3 |
|-|-|-|
| `/review` skill (dotfiles) | `agw review`, reads v2 fields, `--deep` adds native `/code-review high` + security review, degrades to `/code-review` on provider balance | in-session `prepare` → `Agent(reviewer)` → `submit`; `--deep` → `agw review --level deep`; v3 fields; the fix loop with dispositions; the degrade branch goes |
| `/ship`, `/implement`, `/secrets`, wave roles, global CLAUDE.md, repo AGENTS.md lines | "run `/review`" | unchanged wording; `lead.md` loses its separate `/code-review high` step |
| Fleet leads | `/review` per worker diff + `/code-review high` on core PRs | `/review` (in-session, ~5k context each); `/review --deep` on core and security-adjacent PRs |
| `scripts/verify.sh` smoke review | `agw review --depth light`, asserts schema 2 and angle findings | `agw review --where desk --level quick --admission-wait 0` on the fixture (a refusal by the ceiling prints `SKIP: review ceiling` and does not fail verify; anything else does) and `--where api`; both assert schema 3 |
| Eval harness adapter and `review.imported` | v2 schema | v3 schema; the native arm is `agw eval run review --arm '{"params":{"where":"desk"}}'` once v3 exists |
| Hermes | no caller (its `/review` is its own engine) | none needed; it may call `agw review` |
| software-factory | no caller | gains role `reviewer`; a lead's evidence stays the review's run id |

## Open for the build wave

- Whether the factory passes `--agent reviewer` (else the prompt delegates; S1 ran the prompt form).
- The deny list, proven against a planted injection before cutover.
- Verifier seat (Sonnet vs Haiku), K, the cross-vendor voter at `standard`: Wave 11 arms.
- The ceiling values: tuned on Wave 9's real load.
