# Lead handoff — Wave 2 (Gateway): CLOSE-OUT

Lead `agent-workflows-w1-r5` (pane t4g), 2026-11-01 ~22:50 → 2026-11-02 ~01:50 local, from lead r3's PRs #81/#82 and its
review round 1 (r3 stood down ~23:00, handoff taken). Briefs on the mini (not in git): `~/.local/state/agent-workflows/briefs/gw2/`
(routes, pools, cycleday, usage, server, deploy).

## Live state

agent-workflows release `b25aac5` (host, audio, gateway), gateway build `c2e8699905d1d1fc` on `127.0.0.1:7794`,
`make deploy` OK, `make verify` PASS (smoke `01a199b6-8f2b-…`, cap `01a199b6-93ad-…`, audio `01a199b6-96cd-…`, gateway
requests `01a199b6-991e-…`, `01a199b6-9d03-…`, `01a199b6-a06b-…`). usage-tracker master `7d35470`, migration 0014 applied
live 2026-11-01 23:05. dotfiles master has #56 (iu `cycleDay` 21, me 27, me2 null/disabled). Every fan worktree and branch
of this wave reclaimed; workers closed. Not ours, left alone: `feat-shop-amazon*`, `factory-classify` worktrees.

## Per-step verdicts

| Step | Verdict | PRs / commits | Review |
|-|-|-|-|
| `packages/gateway` | **PASS.** Byte-exact passthrough with the usage tee, aliases from `@agent-workflows/routes/pricing`, pools with the meter, session binding, expiry-first order, step 0, IU fallback and `x-agw-fallback: none` (402), door-token callers, one span per request, SQLite ledger → `usage.records`/`gateway_picks` | #81 routes, #82 pools, #85 server, `b25aac5` (cache columns) | #81, #82: r3's round 1 (agw review + `/code-review high`) + r5's round 2 (agw review, `/code-review high`), fixes landed. #85: `agw review --deep` (13 blocking, 7 taken), `/code-review high` (10, 6 taken), round-2 agw review (10, 6 taken). `b25aac5`: lead diff read, make check (found live, below) |
| usage-tracker migration | **PASS.** 0014: `api_credit` billing (+ guard: account set, no IU key), `credit_cycles`, `gateway_picks` keyed `(request_id, picked)` | usage-tracker #16 | r3 round 1; r5 agw review + `/code-review high`, the picks key fixed (a drained-retry's two picks could share a ms) |
| Deploy | **PASS.** Third LaunchAgent from a content-addressed build dir `~/.agent-workflows/gateway/<build>`, restarted only when the build changes, rolled back with the other two; fail-closed launcher holding only the personal IU key (never `iu.env`); `make verify` makes three Haiku calls and checks rows incl. cache columns | #84, `693ad62` (port 7794), `f724300` (portable mktemp) | agw review (5 blocking, 3 taken). Port and mktemp: mechanical, lead diff read + make check |
| README, AGENTS.md | **PASS.** `packages/gateway/README.md`, AGENTS.md three processes, deploy/verify rows, rotation and kickstart gotchas, `docs/gateway.md` §Shape departures paragraph and §Meter rule | #84, #85 | with their PRs |
| Registry cycle days | **PASS** | dotfiles #56 | diff read (config + doc) |

## Gate evidence

- `make check` in the train after every rebase: #81 3137 pass, #82 3202, #85 3355, #84 3386, 0 fail each; CI green on each
  merged head; `b25aac5` 0 fail (3452 tests).
- `make deploy` + `make verify` PASS at `b25aac5` (ids above). Rows: call 1 `api_credit`/iu, 1983 cache-write 5m tokens,
  $0.000251175 = 13·0.10 + 4·0.50 + 1983·0.125 per MTok; call 2 `bound` on iu, 1983 cache-read tokens, $0.00002313; call 3
  Claude-Code-shaped → `iu-api`, `api_key` personal, `fallback: claude-code`. `gateway_picks` reasons `soonest-expiry`,
  `bound`, `claude-code`. Ledger unsynced 0, quarantined 0.
- Meter seed: iu boots at $56.11 from `cost_report` since 10-21 (the owner's 10-31 outside spend), me $0, me2 disabled;
  verify never waits on the cost API.
- Restart rule live: a redeploy of `693ad62` logged `gateway unchanged (build b3d398bc…), not restarted`, gateway pid
  unchanged; a changed build restarted it (`b25aac5`).
- Spans: `@verifier` found the three `agw-gateway` spans in ClickStack prod with request ids, pool, pick reason, TTFT,
  cost (at `693ad62`). No key material in the gateway logs (0 matches for `sk-ant-`, `x-api-key`, `Bearer `).
- Rollback live: the first deploy hit `EADDRINUSE` on 7793 (the software-factory server's port) and rolled back cleanly to
  `767f643`, gateway plist removed.

## Departures from `docs/gateway.md` as first written (for concept v3.14)

Owner-accepted (via r2/mother): a **lean process, not `bootProcess`** (no journal Postgres, runtime or OpenCode on the hot
path; bundle 691 KB, 204 modules, workspace closure `host/{auth,door-tokens}` + `routes/{balance,cost,price,pricing,table/claude}`);
a **local SQLite ledger as the outbox** (at-least-once, idempotent upsert on `(source, source_id)`, quarantine of rejected
rows with a requeue at each start, no loss across a Postgres outage, WAL `synchronous=NORMAL`); **build-hash restart**.
Settled in the build: port **7794**; drain marks last **1 h** (capped at the cycle end) so a missed Claude-Code refusal never
benches a funded pool for a month; reconcile is **higher-only on known cycles** and its high-water mark is **persisted** and
applied before listening; a balance refusal re-picks until no pool is left; a credit request without complete usage charges
the meter a **conservative estimate** that never enters `cost_reported_usd`; web search priced per use ($10/1k).

## Left behind

- The host's `ANTHROPIC_API_KEY` (`.env.tpl`) is the iu credit org's key: the host's OpenCode direct wire spends iu credit
  outside the gateway until Wave 3 moves it; the hourly reconcile (20–70 min lag) and the $2 headroom absorb it.
- agw's own capabilities/OpenCode usage passes only the cache-write total, so 1 h writes price as 5 m there (Wave 3).
- Gateway, accepted: a SIGKILL mid-request or a failed ledger write loses that request's row (the reconcile catches the
  spend); OpenAI streams without `include_usage` record zero tokens (`usageReported: false`); an SSE event over 1 MiB
  (an OpenAI Responses reply that large) loses its usage on IU; same-millisecond resync may over-count.
- usage-tracker review findings not taken: `account` not constrained to registry ids (they are open, #13); `stats --by
  account` mixes Max and `api_credit` under one account key (Wave 4 Argo shows credit on its own).
- Flaky: `packages/middleware/test/platform.test.ts` "concurrent runs: run record, fingerprint, purpose and span tree" failed
  once on CI (#84), green on re-run.
- Still from Wave 1: `docs/concept.md:337` and `docs/factory-input.md:17` say balance is "402/503" (mother's call).
- No caller uses the gateway yet besides `make verify` (Wave 3). me2 waits for its keys; me's cost units still unobserved.
- A registry edit needs `launchctl kickstart -k gui/$(id -u)/com.jkrumm.agent-workflows-gateway` (a deploy with an unchanged
  build leaves the gateway running).

## Retro notes for the mother

- Two leads were resumed side by side (r3 and r5). r3 believed its trains were running; `pgrep` showed only r5's. The
  process table, not an agent's report, is the truth; a factory that refuses a second lead on a wave would prevent it.
- The live check paid off again: every test and four review rounds passed a gateway whose rows held 0 cache tokens,
  because Claude 5.5 usage now carries `output_tokens_details` and the tee read it as OpenAI. Fixtures from a real response
  beat hand-written ones; `make verify` now checks the stored row, not only the response.
- A design doc picked port 7793 without checking the mini's listeners; the software-factory server held it. A brief that
  names a port should run `lsof` first. The rollback path proved itself on that failure.
- Two defects showed only on Linux CI (SQLite deletes `-wal` on close; GNU `mktemp` needs X's): each cost a train round.
  Shell and SQLite tests want a Linux run before the train.
- `agw review --deep` and `/code-review high` found largely disjoint issues on the spend path (credential carriers and the
  multi-pool retry came only from the latter); both are worth it there. Round 2 still found real items (rollover race,
  unbounded session ids).
- `rd fan` ignores `RD_WAVE_MODEL`; `--role lead` gives an Opus worker. Idle worker prompts show prompt suggestions
  ("merge it", "/review the PR") that were never submitted: read `rd read` with that in mind.
