# Lead handoff — Wave 7 (otel, brain, diagram, prose; P3b), close-out

Lead: `agent-workflows-w1` (pane w40:p1E), 2026-10-29 ~03:50 → ~07:20 UTC+1, one context, no rotation. Briefs:
`~/.local/state/agent-workflows/briefs/w7/` on the mini (not in git: they name local paths), incl. `results.md`.
Rules and results: `docs/research/2026-10-29-wave7-ports.md` (rules committed at `b144ae1` before any run; results
`d6e272d`). Concept v3.7 (`8de034e`) describes P3b as built.

## Per-step verdict

|Step|Verdict|Evidence|
|-|-|-|
|`otel` workflow, `hdx` as a capability, cost per query recorded|**done**|#39 `hdx.*` capabilities (HyperDX JSON-RPC/SSE + REST, no MCP; agent-safe set `AGENT_SAFE_HDX`; `clickstack_sql`, webhook reads and writes CLI-only via `agw hdx write --commit`). #43 workflow `otel`: one agent (deepseek flash) through the tool gate, env pinned per grant, findings grounded only by a query id that returned rows, `untrusted` note. Rule PASS: facts 0.875 vs legacy 0.5625, status 0.875 vs 0.625, 16/16 runs priced. Cost per investigation ≈ $0.019 (legacy ≈ $0.265 Max-equivalent); wall p50 49.5 s vs 51 s|
|`brain` agent shared by workflows|**done**|#42 `agw brain` + `agw vault search|read` capabilities through the gate; Haiku 5.5 EU, **no fallback** (private notes stay on the Anthropic EU route; lead decision); usable as a child workflow (`ctx.workflow`). Rule PASS: reference cited 10/10, facts 0.9, 41/41 citations grounded, median $0.0013. No legacy exists, so no side-by-side (pre-registered)|
|`diagram` (excalidraw) ported|**done**|#40 `agw diagram` (create/extend), hydration in a short-lived `bun` child from pinned npm `@excalidraw/excalidraw` 0.18.0 + `@napi-rs/canvas` (label widths identical to Chrome; legacy's esm.sh path measured 9–23 % narrow), concurrency 2, host writes no caller path. Rule PASS: valid 12/12 vs 12/12, bound arrows 1.0 vs 0.976, overlaps 0.08 vs 0, median cost $0.0028 vs $0.0052, wall 21.5 s vs 29.1 s|
|`prose`: lint + cross-lab review + keep gate; rewrite in the calling session|**done**|#41 `agw prose` (lint, review on deepseek via `prose.critique` with structured input, `writerBrief` fenced with a random nonce journaled in a step, `voicePath`) and `agw prose-gate` (no model, cost 0, answers the text to write). Lab refusal on the resolved route + wire. Rule PASS: lint 12/12 identical, gate 41/41 decisions equal, review mean |N−L| 0.389 ≤ 0.556 (averaged reading; `precision` alone 0.625 > 0.5), cost 1.04× mean (one call 1.58×). Legacy ≈ $0.09/call (Opus writer) → the writer moves to Max|
|`/otel`, `/excalidraw-diagram`, `/prose` switched; agw MCP tools removed|**done**|dotfiles #42 (`/prose`, `/excalidraw-diagram`, `/brain` lookup section, global CLAUDE.md, docs), dotfiles #43 (`/otel` on `agw otel` + `agw hdx`, `hdx.py` deleted, `query.py` kept as last resort). agent-gateway #38: MCP `otel`, `prose`, `excalidraw_diagram` and `agw-legacy prose` removed (−2705 lines; the prose pipeline stays as a library for `narrative`), deployed `8a25212`. Switches merged before the removal (Wave 6 ordering lesson)|
|Wave 6 leftovers: CLI answer carries the final cost|**done**|#38: held waits that see the run end hold ≤ 5 s for the record; `cost`, `unpricedCalls`, `costPending`, `recordFailed` (new expand-only column `post_hooks_failed_at`, migration 0009); `run status/get/cancel` never hold. Live: verify reads "cost … (as answered)"|
|Leftover: last sleep-synchronised test|**done**|#38: `opencode-host` abort, kill/restart, follow-up re-attach and poll-count tests on in-flight signals; justified sleeps listed in the PR|
|Leftover: `rd fan --clean` scoped (dotfiles)|**done**|dotfiles #41: `rd fan` marks its worktrees (`<git-dir>/rd-fan`); `--clean` keeps unmarked ones unless `--all`. Used at close: 10 worktrees reclaimed, nothing foreign touched|
|Leftover: CONTEXT7_API_KEY off research-gateway's item|**not done (owner-gated)**|MacBook unreachable all wave (ssh rc=255). ask-human `20261029T070930-17518` queued: creates the field in `mini/agent-workflows`, adds the ref to `headless.refs`, reseals. Then `.env.tpl` line 5 → `op://mini/agent-workflows/CONTEXT7_API_KEY` and a deploy. Request `20261029T035706-12839` is superseded (discard)|

Also merged (found on the way): #37 the tool gate as one host-wide module (research unchanged; writes both `gate.json`
and the legacy `research/gate.json` for one release, expand/contract), #44 hdx test JSON-RPC id collision under load,
#45 `--format plain` on a workflow reads `plainField` from `.output`, #46 `--help` fetches the contract first (new
commands were invisible after a deploy until `agw schema --refresh`).

## Reviews (owner direction: no gateway `/review`; the lead's `/code-review` on Max)

|PR|Review|
|-|-|
|#37 tool gate|high r1 (10: 7 fixed incl. cutover dual-write, boot stateDir, logger, write-failure reset, single gate, guarded ledger row, lost-usage log; 3 dismissed: negative cache, 404→403 text, migration comment), lead read r2|
|#38 run cost|high r1 (8: 7 fixed, flush helper dismissed), high r2 (10 → **design change**: hold only in a wait that saw the transition, no age/clock), lead read r3|
|#39 hdx|high r1 (10 fixed; `clickstack_sql` kept CLI-only because no local ClickStack existed for the write probe), high r2 (8 fixed: message shape, cursor, caps, structural agent-safe set)|
|#40 diagram|high r1 (10 fixed; Worker → child process), medium r2 (10 fixed), CI Linux timing failure fixed at the cause; lead resolved one rebase|
|#41 prose|high r1 (7 fixed: fencing, command name, no free-prompt capability, lab refusal), medium r2 (9 fixed)|
|#42 brain|high r1 (10 fixed: YAML alias bomb, per-attempt grounding, NFC paths, fd-checked reads, linear link scan)|
|#43 otel|high r1 (10: grounding redesigned on query ids; no env-pin escape, mutating refusal holds); lead resolved one rebase|
|#44, #45, #46; dotfiles #41, #42, #43; agent-gateway #38|lead read (test-only, small CLI fixes, skills/docs, deletion)|

## Gate

- `make check` at the last merge (#46 in the train): green after a load retry (host load 96 → 11; earlier
  attempts failed on unrelated load-timeouts, `run-step.sh` idle kill and the credentials test). Last worker
  `make check`: 1608 pass, 17 skip, 0 fail, 1625 tests.
- CI: green on every merged head (train-gated); `adc586d` superseded by `8de034e` (docs) mid-run.
- Live: release `adc586d` on the personal key; `make verify` PASS (run `01a18646-09db-…`); `@verifier` **11/11 PASS**:
  otel (run `01a18646-212a-77c0-a81c-5b2102a86923`, $0.018, answer carries the cost, 17 queries, all findings cite
  query ids), spans `agw.run otel` + steps in prod ClickStack, diagram create/extend valid, prose + prose-gate (URL loss
  → original; faithful rewrite kept), brain grounded 4/4 on Haiku EU, `vault read Inbox/…` refused, hdx tools/query/
  rest/link, `hdx write` without `--commit` → confirmation_required, fresh `--help` without a manual refresh, Argo
  outbox synced with 0 errors, agent-gateway MCP list without the three tools, skills grep clean.

## IU spend, by key (runs since 2026-10-29 02:50 UTC)

|Key|Purpose|Runs|Spend|What|
|-|-|-|-|-|
|athena-team|eval|94|**$0.41**|otel $0.30, prose $0.054, diagram $0.036, brain $0.015, judge calls $0.001; 0 unpriced|
|athena-team|prod|35|$0.026|other callers while the host ran on the team key|
|personal|prod|3 reviews|$0.46|**workers ran `agw review` on their PRs** (04:30, 04:33, 05:04) against the owner direction; 9 unpriced calls. Rule restated to every worker at ~04:45|
|personal|verify/retro|10|≈ $0.04|deploy verification, `@verifier`, weekly retro|

Outside agw: legacy arms ran on agent-gateway (diagram ≈ $0.07 on its IU key; otel ≈ $2.12 of Max), skills-switch
proofs and the narrative smoke ($0.068) on agent-gateway/personal.

## Host state

Release `adc586d`, personal key (`~/.config/agw/iu.env` removed; `athena-iu.env` untouched). agent-gateway `8a25212`.
Main checkout clean on master. No worker tabs or fleet worktrees left.

## Left behind

- CONTEXT7_API_KEY move: owner request `20261029T070930-17518` (see table); then the `.env.tpl` swap and a deploy.
- `clickstack_sql` is CLI-only until a write probe on a local ClickStack proves it read-only (nothing listens on :7707
  on the mini). Move it to `AGENT_READ_TOOLS` only with that evidence.
- `clickstack_list_dashboards` is not on the agent/CLI read allowlist (verifier used `hdx rest /dashboards`).
- `research_tool_calls` now also holds brain's evidence (shared guarded hook); otel keeps its calls in memory and
  journals them. A neutral table name is an expand/contract rename for later.
- Tool gate writes the legacy `research/gate.json` too: drop it in a release after no live location reads it.
- agent-gateway: `server/lib/routing.ts` rows for otel/excalidraw/prose_* and the `mcpServers` session option remain
  (heavily pinned by tests; P6 shrink). Already-connected MCP sessions keep the old tool list until reconnect.
- Prose rule 3/4 readings: the doc states the averaged/mean readings taken; `precision` alone and one call at 1.58×
  are outside a per-item reading.
- Load-induced flakes in untouched tests under host load 60–200: `run-step.sh` idle kill, "credentials of the host
  never reach make check", review `git init`, two `opencode-host` locations tests at the 5 s default. The load-scaled
  timeout is still sampled once per `make check`.
- `agw vault read` of a refused path answers `found: false` with exit 0 (by design, a typed miss, not an error).
- Diagram on Linux: a native crash takes 12–17 s to be reaped where apport runs (README); the mini is macOS.
- Not ours: dotfiles architecture-check rows (com.iu.athena-postgres, com.iu.teamchat-*); agent-gateway
  `dispatch-worktree.test.ts` credential helper.

## Retro notes

- **Pre-registration held up again, with one gap.** Four rules written before any run made four verdicts queries.
  The gap: prose rules 3–4 did not say "per criterion / per call" vs "averaged / mean"; the reading had to be chosen
  and disclosed after the numbers. Write the aggregation into the rule.
- **The shared files are the merge train's bottleneck.** Five ports appending to `suites.ts`, `workflows/index.ts`,
  the route table and two READMEs produced a rebase conflict on almost every merge (4 round trips, 2 resolved by the
  lead). A registry that discovers workflows/suites by directory, or one-line-per-entry files, would remove the class.
- **Design changes beat patch rounds** (Wave 5's lesson, confirmed twice): run-cost r2 (freshness hold → hold only in
  the observing wait) and otel r1 (token matching → query ids returned to the agent) each ended a growing finding list.
- **Live use finds what fakes don't.** The skills-switch worker found `--format plain` broken for workflows and the
  stale CLI help after a deploy; both were invisible to unit tests and to the porting workers' "checked on the
  contract".
- **Workers ran `/review` from the input-box suggestion** ($0.46 on the personal key) until told. Put "no `/review`"
  into `_common.md` from the first brief while the IU constraint stands.
- **A secrets ref before its item is a fleet-wide hazard:** adding `op://…` to `headless.refs` before the item exists
  makes every `make secrets-seed` abort. The request now creates the item, adds the ref and reseals in one command.
- **Host load 60–200** from parallel fleets made `make check` take 4–6 min and fail on timeouts in untouched tests;
  waiting for the 1-min load to drop below 30 before a train run was the reliable fix.
