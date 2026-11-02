# Lead handoff — Wave 4 (Reconcile and Argo): CLOSE-OUT

Lead `agent-workflows-w1-r7` (pane t6q), 2026-11-02 ~09:45 → ~10:50 local. Briefs on the mini (not in git):
`~/.local/state/agent-workflows/briefs/gw4/` (usage, argo, agw, hermes, dotfiles, brain). Branch prefix `gw4/` (old `w4/*`
heads exist on agent-workflows' origin from an earlier plan).

## Live state

agent-workflows release `2e7d5f2` (host, audio), gateway build `6123d4041b283b0e` unchanged and not restarted, `make deploy`
OK, `make verify` PASS (smoke `01a19ba5-2d4d-…`, cap `01a19ba5-3282-…`, audio `01a19ba5-3675-…`, gateway requests
`01a19ba5-37c3-…`, `-3d7f-…`, `-4257-…`, agw-opencode `01a19ba5-49c0-…`, smoke review `01a19ba5-916d-…` $0.0543, 22 s).
usage-tracker master `a14f452`, migration 0015 applied, LaunchAgent reinstalled. argo master `614b5972` deployed (`make
verify` PASS). hermes-agent master `27c79af` (liveness and verify scripts run from the main checkout, so the pull is the
deploy). dotfiles #59 merged at `7eaf164` (checkout pulled; global CLAUDE.md live), brain master `f7f81eb`. Every fan worktree and worker of
this wave closed. `me2` keys still a `REPLACE` placeholder at close: the pool stays disabled (not enabled, no owner input).

## Per-step verdicts

| Step | Verdict | PRs / commits | Review |
|-|-|-|-|
| usage-tracker pass | **PASS.** Migration 0015 `usage.platform_cost` (account, day, model, api_key_id, cost_usd, refreshed_at; unique on the coalesced key); a credit pass in `ingest` (hourly throttle in `collector_state` row `credit`, 120 s deadline per org, `credit` CLI unthrottled) reads `analytics/cost` per org with its admin key (placeholder/missing skips the org), all-or-nothing per org, strict parsing, `redirect: error`; `credit_cycles` current + previous per account with `metered` from gateway `api_credit` rows (estimates included), closed when the provider snapshot passes the cycle end (reconciled, unspent, `grant_usd` frozen once closed). usage-tracker is the only writer of `credit_cycles`. `stats --by account` splits `iu (max)` / `iu (api_credit)` / `iu (<billing>)`. Live: 6 `platform_cost` rows (iu $56.11 on 10-31 outside the gateway, 11-01/02 lagging), 4 cycles (previous iu/me closed at $0 reconciled, $200/$100 unspent; current open, iu metered $11.44). The gateway's meter already took the reconciled figure (Wave 2 build): iu `meterUsd` $67.58 = $56.12 reported + $11.44 gateway rows; hourly reconcile live (09:29Z) | usage-tracker #17 | agw review (clean, 5 improvements) + `/code-review high` (8 findings); all fixed in two rounds |
| Argo | **PASS.** Payers `iu-credit`/`me-credit`/`me2-credit` (no `api_credit` row falls to `unknown`), `iu` is Ultra ($200, "IU Ultra"), DESIGN.md and `BillingEnum` follow; Credits tab with per-pool burn-down (metered beside reported, balance from cycle start, awaiting-reconcile for an expired open cycle), projected unspent, previous cycle's reconciled/unspent, picks × reason with fallbacks, cache-hit per caller; `GET /usage/credits/{pools,picks,cache}`, tables guarded. Live: pools iu open cycle, picks 377 (6 fallbacks = `claude-code`), cache agw-opencode 0.65, agw 0.01, hermes 0.12; `/usage/split` shows `iu-credit` | argo #211 | agw review (clean, 5 improvements); all fixed; 97 integration tests on the real migration, CI green |
| Docs | **PASS.** dotfiles `architecture.md` (gateway row, Secrets flow, monitoring), `agent-platform.md` (where API tokens are spent), `claude-accounts.md` (platform block, pool states, the `me2` enable steps incl. the gateway kickstart), `global.CLAUDE.md` (the gateway holds IU and Claude API tokens for agw/OpenCode/Hermes/`oc`/modelpick; the Codex lane keeps IU in its launcher). brain `wiki/engineering/model-routing.md` rewritten (three billing lanes, seats, gateway pick order, launchers, usage lanes, Hermes; agent-gateway, `ca`/`cap` gone) | dotfiles #59, brain #3 | lead read (docs only); two fact fixes sent back on #59 (Codex lane holds IU; Hermes liveness now watches the gateway), escaped pipes on #3 |
| `make verify` smoke review | **PASS.** A throwaway repo from `scripts/fixtures/smoke-review` (unkeyed `.tsx` list + an off-by-one `.ts`), `agw review --depth light`, bounded 300 s (a run past it is cancelled with `--commit`); passes only with react-doctor/angle/synthesis steps done, ≥ 1 react-doctor diagnostic, a schema-v2 non-degraded verdict with a real reviewer's finding, a priced run row. $0.04–0.07, 22–30 s. Its usage: 9 `api_credit` + 1 `api_key` gateway rows ($0.0542), no `agent-workflows` row | agent-workflows #98 | agw review (clean); 4 fixes; the train then caught a `$0` path bug and CI caught non-hermetic live-routes tests (both fixed) |
| live-routes alias map | **PASS.** `CLAUDE_ALIASES` read from the deployed release's `claude.ts` (`bun -e`), loud failure on a missing/malformed map; tests run on a stub release. Live: `ROUTES='cheap.title'` PASS (`api_credit` on iu) | #98 | as above |
| Hermes liveness + verify | **PASS.** `scripts/inference-gateway-check.sh` (gateway `/health` ok, then the `hermes` token on `GET /anthropic/v1/models`: 2xx/429/5xx accept, 401/403/other 4xx/no answer fail; token from the file via curl `-K -`, never in argv; malformed line refused); liveness withholds the heartbeat after 3 attempts 8 s apart; `make verify` and `make status` share it. Live: `make verify` all ✓, a liveness tick pinged, a wrong tokens file fails by name | hermes-agent #15 | agw review ×2 (clean); fixes in two rounds |

## Gate evidence

- `make check` in each repo's train after rebase; agent-workflows 3607 pass / 0 fail and CI green on `0134268f`; usage-tracker
  482 pass / 0 skip; argo CI green, `bun test:api src/routes/usage*` 97/0/0.
- dotfiles' train ran the check minus `architecture-check` and `herdr-core-guard-test`: both red on master for reasons outside
  this wave (below). brain's train ran `vault-lint` accepting only the dangling-symlink errors (below); master lints 0 errors.
- `make deploy` + `make verify` PASS at `2e7d5f2` (ids above); argo `make verify` PASS at `614b5972`; Hermes `make verify` PASS.
- Rows read from both writers: the review smoke run has gateway rows only; `usage.platform_cost` (provider) against gateway
  `api_credit` rows (ours) against the gateway's `/health` meter agree ($56.12 + $11.44 ≈ $67.58).
- Gateway `/health`: ledger unsynced 0, quarantined 0; iu $69.66 at 09:45Z, me $0, me2 disabled.

## Departures and lead decisions (for the mother)

- **The gateway part of step 1 was already built in Wave 2** (reconcile from legacy `cost_report` + today's ledger, high-water
  mark, the meter keeps the higher). Wave 4 verified it live and did not change the gateway (build unchanged).
- **The credit pass runs inside usage-tracker's ingest**, hourly-throttled, not as its own LaunchAgent: no new launchd row.
- **Credit left in Argo = grant − max(metered, reported) from the cycle start**; a cycle whose end is unknown draws 31 days
  labelled "cycle unknown" with no projection.
- **Fallbacks in Argo** = picks leaving the pools for any reason other than `forced`; today all 6 are `claude-code`
  (Claude-Code-shaped requests, by design), so the count reads as fallbacks though no pool was short.
- `stats --by account` labels changed (`iu` → `iu (max)` / `iu (api_credit)`): asked for by Wave 2's left-behind.

## Left behind

- `me2`: keys still placeholders at close; enabling stays out (registry `cycleDay` from the owner, a live call). Steps in
  dotfiles `docs/claude-accounts.md` §Platform.
- Not ours, untouched: 34 duplicate `source='agent-workflows'` rows and `~/.config/agw/iu.env` / `athena-iu.env` (owner's call,
  Wave 3 close-out has the query).
- dotfiles `make check` red on master outside the fleet: `architecture-check` (`com.jkrumm.homebridge` loaded but unmapped) and
  `herdr-core-guard-test` (core 0.1.15 here, 0.1.16 on the other machine; the daily update converges them).
- brain: `wiki/engineering/agent-platform.md` and `dotfiles-architecture.md` are tracked relative symlinks that dangle in any
  worktree under `.claude/worktrees/`, so `vault-lint` there reports ~25 dead links; a fan worker or train in brain must
  filter them (or the links become absolute/the notes real files).
- The gateway's reconcile lags a complete UTC day the cost report has not yet caught up on: spend made outside the gateway on a
  day the report still misses is not in the meter until the report shows it (today nothing is spent outside it).
- Argo `credits/cache`: modelpick's 251 zero-token catalog rows from Wave 3 drag its hit rate to 0 in a 7-day range.
- `agw routes --format json` carries no alias map; live-routes imports it from the release source (couples the script to
  `packages/routes` layout; a `claudeAliases` field in `agw routes` would be cleaner).
- Codex lane (`cx`/`cxa`/`astra`) still holds the personal IU key outside the gateway (now documented, not moved).
- Hermes `scripts/model-release-watch.py` (untracked, not ours) still in its checkout.
- Stale from Wave 3, unchanged: Hermes `SOUL.md`/README/skill text, modelpick rationale rows, triage reasoning tokens 0 on the
  `anthropic` wire, flaky hook timeouts under load (none seen this wave).

## Retro notes for the mother

- **"workers done" fired early three times** while every worker was mid-turn on a `rd say` fix (the factory reads a worker
  at a prompt between tool calls as idle). Re-declaring and a bounded foreground poll on the PR head or the train's exit
  line was what worked; never merge on the note.
- **A worker's targeted test run hid two whole-suite failures**: the train's `make check` caught a `$0`-relative fixture path
  the verify.sh tests exercise, and CI (not the mini) caught tests reading the real `~/.agent-workflows/current`. The mini
  is not hermetic: briefs that touch scripts reading deployed paths should ask for a run with `HOME` at an empty temp dir.
- `rd say` to an idle worker answered "held while it works" and was delivered at its next prompt in every case this wave.
- Two delegated reviews again found disjoint things on #17: agw review the throttle, redirect and malformed-page deletion;
  `/code-review high` the billing label, the per-row upsert and the frozen grant.
- Cross-repo schema in flight: giving both briefs the exact DDL let Argo build against `platform_cost` in parallel with a
  test-setup fallback, removed once usage-tracker merged.
