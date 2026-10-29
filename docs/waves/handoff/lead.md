# Lead handoff — Wave 9 (usage; P4b): CLOSE-OUT

Lead: `agent-workflows-w1`, one occupant, closed the wave 2026-10-29 ~16:45 UTC+1. Briefs and review notes:
`~/.local/state/agent-workflows/briefs/w9/` on the mini (not in git); `_common.md` carries the Wave 8 rules plus "port the
env by name", "check JSON shapes against a real run" and live criteria for best-effort steps.

**Final state.** agent-workflows release `f84fa7a` on host + audio (team key in `~/.config/agw/iu.env`), `make verify`
PASS. usage-tracker `9eb35cc` (checkout = live LaunchAgent), hermes-agent `6538876`, dotfiles-private `2ecbe01` (the
bridge commits reverted, files byte-identical to `6eb27ee`). argo and vps unchanged on master. Main checkout clean.

## Per-step verdict

|Step|Verdict|Evidence|
|-|-|-|
|Usage projection into Argo|**done, live (verified, not rebuilt)**|The outbox already existed. Journal vs Argo for `source='agent-workflows'`, before the backfill: tokens identical in every bucket (input 14,932,692 / output 3,477,484 / reasoning 15,585,387 / cache read 167,894,423), cost $47.0479 vs $47.0478, 129 unpriced on both sides, 0 quarantined; `iu_key` split matches (athena-team $45.788, personal $1.260). After the backfill: $60.8723 vs $60.8722, 7 unpriced on both|
|Wave 8 leftovers: runtime CI flakes, fan tabs|**done**|#59: the lease-grace test compares on Postgres' clock from `attempt_started_at`, with no slack (mutation proof: grace 0 → red). The toolPre tests and `agent.test.ts:43` wait on a new `FakeSession.attached` promise (80/80 under 4× parallel load). Four Wave 8 fan tabs closed by hand after a clean+pushed check; `rd reap` would also have messaged an IuRoot tab that isn't ours. The `w8-audio-price-r1` worktree was removed: its r2 change is on master under another sha|
|Route table without region pinning (+ Requesty hops)|**done, live**|#62. No `-eu` id left in `packages/routes/src/table` (guard test over every route). Haiku/Sonnet → `claude-haiku-5-5` / `claude-sonnet-5-5` (the `-eu` ids are gone from IU's `/models`); `decide` → `decision-1` (header "Global Sink Sweden Decisions API"). Requesty hops off: `review.router`, `cheap.classify`, `review.ocr` → Haiku 5.5 (fallback Terra); `review.adversary` → GPT-6.1 Terra medium (keeps a cross-family critic; fallback Haiku, 32K output). Provider header = `x-middleware-forwarded-server`; probe table in #62's body. Long-prompt tier as data (`Rate.longPrompt`: Haiku 5× over 100K per the Anthropic pricing page, Terra 2×/1.5× over 272K); a rate without a tier is flat at any size. OpenCode leg chosen by model family only (r1 blocker: a shared id would have moved every OpenCode Haiku agent onto the chat provider). Live after deploy: classify `bedrock/eu.anthropic.claude-haiku-5-5` $0.0000387; decide `microsoft-decision-1` $0.0000013; review `01a18845-84cd-…` (route Haiku, adversary `openai.gpt-6.1-terra`, angle + synthesis Haiku, all priced, $0.0076). `make verify` PASS ×3 (`3dcfc84`, `f84fa7a`)|
|Usage rows correct|**done, live**|Unpriced rows: the cause was `OpenCodeHost.usage()` voiding a whole step when one message passed 100K, even with an OpenCode-reported cost (115 review steps + 9 research steps). Fixed in #62, then `scripts/backfill-step-cost.ts --all-models --commit` priced 123 steps in 36 runs ($13.56; per call from the live OpenCode sessions) and re-queued 123 Argo rows. 3 steps with no per-call split stay null (estimates are opt-in). Reasoning: counted once on every wire, checked on one real step per wire against its Argo row (opencode 36745/22305 → 14440/22305; iu-openai 8786/4155 → 4631/4155; iu-anthropic 258/0 → 258/0). Caller: #60 (runs `caller`/`project`/`workspace`, migration 0011, expand only, children inherit). Argo `project` = project ?? caller, `raw.caller`. Live rows: `claude-code`/`agent-workflows`/private, `claude-code`/`prometheus-scripts`/work, `iris`/`iris` (iris #42 sends `x-agw-caller`), `host`/`host`. Hermes: podcast skill sets `AGW_CALLER=hermes` (hermes-agent `6538876`; Hermes' terminal has no env marker)|
|argo `/ai` audio proxy on the door|**dropped (owner direction mid-wave)**|Owner: no bridge, argo gets no audio integration; its `/ai` audio routes and dashboard audio calls are deleted when audio-gateway retires (Wave 11). Unwound with no half state: argo PR #206 closed unmerged (branch and worktree deleted), vps branch deleted, dotfiles-private grant + serve row reverted (`dcd5b1d`, `2ecbe01`; never pushed to the tailnet, never applied), the `argo=` door token removed, owner requests `20261029T153628-6456` (1Password) and `20261029T153856-27524` (ACL push) withdrawn, door-only listener reverted (#63 reverts #61; nothing listens on :7793, `f84fa7a` verified). No Caddy row was ever added|
|usage-tracker collectors removed; one week reconciled|**partly done**|usage-tracker #14: the `research-gateway` collector removed (Argo already holds all 2,912 of its local rows, plus 3,588 the local DB lacks; source silent since 10-28 15:30Z). Kept, with evidence (`docs/reconciliation/2026-10-29-agent-workflows.md` in usage-tracker): `agent-gateway-opencode` (live: narrative, an excalidraw-diagram caller, dispatch) and `agent-gateway-iu` (live: legacy triage/narrative until Wave 10's callers move), `agent-gateway-sessions` (feeds lane attribution, out of scope). **One week of overlap does not exist yet:** platform rows start 2026-10-27 23:20Z, so the reconciliation covers about two days (review overlap ~21 h). `make health` green after the trim|

## Reviews

All on Max (`/code-review high` in detached worktrees, "never check out" in the args; no fork touched the main checkout).
- argo #206 r1 (security): bearer replayed on redirect, the whole audio process (host API, `/health`) published by the
  serve row, door 401/connection errors passed through, the cache path blocked by config. Fixed in r1, then dropped by
  the owner direction.
- #60 r1: the `AGW_API_CALLERS` allowlist was never wired in boot (dead code; removed, door tokens stay door-only and
  are tested as such); workspace and project from the common git dir; walk-up stops at `$HOME`; one source for the
  caller pattern. Accepted as contract (in `packages/host/README.md`): the API-secret holder may self-declare a
  sub-caller; an idempotent replay keeps the first attribution; project falls back to the caller.
- #62 r1: the provider blocker; one tier rule; adversary fallback ceiling; backfill hardened (per-run transactions,
  `argo_error` rows untouched, estimates opt-in, throwaway-schema test).
- #59, #61, #63, usage-tracker #14, hermes-agent `6538876`: lead diff read only (test-only, a 60-line listener whose
  security reasoning came from the #206 review, revert, deletion, a 3-line skill prefix).

## Gate

`make check` green at every merge (train). CI green on every merged head: #59 `1b908fc`, #61 `435995a`, #60, #62
`fc69dae`, #63 `9ff400c`. usage-tracker #14: no CI configured, train `make check` 295 pass.

## Live proof

No `@verifier` this wave: every step's proof is a live query or call above, run by the lead (journal + Argo `/query`,
code-path probes after deploy, `make verify` with the door checks).

## Spend

|Key / account|Purpose|What|USD|
|-|-|-|-|
|athena-team (IU)|build|classify, decide, one review route proof|0.0077|
|athena-team (IU)|verify|`make verify` ×2 after the deploys|0.0001|
|athena-team (IU)|build|workers' direct header probes (curl, not journaled; one call per candidate)|< 0.01 (est.)|

By model (journaled): Haiku 5.5 $0.0057, GPT-6.1 Terra $0.0021, decision-1 ≈ $0. The backfill re-priced $13.56 of past
spend; that is a correction, not new spend. Max: lead, five workers, four Max reviews.

## Left behind

- **Requesty hops not moved:** `research.agent`, `otel.agent`, `prose.review` and the podcast route still run
  `deepseek-v4.1-flash` via Requesty-Global (header-proven). Their Terra fallback covers a balance failure; moving them
  changes the model their pre-registered port rules ran on (beyond parity). The only non-Requesty DeepSeek id
  (`deepseek-ai/DeepSeek-V3.2`) answers "model does not exist". Owner/mother call.
- **One week of overlap** for the remaining collectors: re-run the usage-tracker reconciliation after 2026-11-04;
  `agent-gateway-opencode`/`-iu` go when their last callers move (Wave 10) or in P6.
- `agw run status` / the HTTP run view do not return caller/project (psql only; iris told the query).
- Host-internal runs (retrospective, friction, judge) carry a null caller; Argo shows `host`/`eval` by purpose.
- `cost_source` is `reported` for rate-priced rows too (Argo cannot tell vendor-reported from rate-priced).
- Haiku on the chat wire has no cache-write bucket (follow-up in #62).
- 3 backfill steps without a per-call split stay unpriced (`--estimates` would price them from totals, an upper bound).
- The review's `project` is the CLI's cwd repo, not the reviewed tree.
- argo still defaults `AUDIO_GATEWAY_URL` to the VPS audio-gateway (unchanged; deleted in Wave 11 per the owner).
- usage-tracker `src/pricing.ts` names research-gateway in two comments.
- Not ours (carried): dotfiles architecture-check rows; agent-gateway dispatch-worktree credential test.

## Retro notes

- **Verify before building paid off at once:** the Argo projection held to $0.0001 and needed no work; the unpriced rows
  were one host bug, found by a read-only Explore before any brief.
- **A security review changes the design, not just the diff:** the #206 review found the door's port also served the
  host API; the fix (a door-only listener) was the right shape, and the owner direction then removed the need. A
  dropped step unwound cleanly because nothing had been applied live before review: one ordering rule (branches, then
  review, then live apply) kept "no half state" cheap.
- **A shared id is a hidden coupling:** moving Haiku onto a chat-wire route would have moved every OpenCode Haiku agent
  through `providerFor`'s sibling lookup; only a review that reads the untouched caller caught it.
- **`rd say` to a busy worker queues behind its turn:** a brief amendment sent right after the spawn arrived only after
  the worker's first report. Put known facts into the brief before `rd fan`, not after.
- **"One week of overlap" was a calendar criterion the data could not meet yet;** state it as such, never round it.
- Owner/peer messages mid-wave (iris asking for the migration, the owner's no-bridge direction) were each one small
  action with a live check; `rd say` with multi-line SQL needs a file, not inline quoting.
