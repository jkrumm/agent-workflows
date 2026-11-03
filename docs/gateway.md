# Inference gateway

**For the owner (2026-11-01).** Every LLM call from the mini goes through one local gateway. It forwards native requests
byte for byte. Claude calls are paid first from the monthly API credit of each Claude subscription, then from IU, and
every request becomes one usage row. Spending the credit is the point: ~$400 a month expires unspent today, while agw's
IU spend runs over the personal key's $500 cap and lands on the Athena team key. Plan: `docs/waves/PLAN.md` Waves 1–4.

Owner decisions (2026-11-01): build it, don't adopt one; agw's seats move to Claude to spend the credit; EU endpoints
don't matter (the `-eu` model ids go); the Athena team key belongs to Athena Teamchat only.

## What the credit is

Research run `01a1980b-d977-7796-a377-14349c813714` (2026-11-01).

| Fact | Consequence |
|-|-|
| Ultra $200 (`iu`), Max $100 (`me`, `me2`) a month, granted to one linked Console organization per subscription | three credit pools, one API key each |
| Expires at the end of each subscription's billing cycle, no rollover; the three cycles differ | spend the soonest-expiring pool first |
| Pays for API keys of the linked org only (Messages, Batches, Agent SDK); never interactive Claude Code | Claude Code stays on the subscriptions, outside the gateway |
| No API returns the remaining balance; `analytics/cost` (beta) returns spend at list price **before credits**, in cents, hourly snapshots typically hours late (docs: up to 24 h); legacy `cost_report` has no row for the current UTC day and cannot group by key (Wave 1 spike) | the gateway meters itself and reconciles against `cost_report` (§Meter); `analytics/cost` feeds `usage.platform_cost` |
| Prompt caches are isolated per organization | a session that changes org loses its cache |
| With no payment method on file, a drained org refuses: HTTP 400 "Your credit balance is too low…" | overspend is impossible; the headroom only avoids a mid-session refusal |
| A **funded** credit org answers a Claude-Code-shaped request with the same 400 (the `claude-code-20250219` beta, the "You are Claude Code" system prefix, a `claude-cli` user-agent; Wave 1 spike) | such a request never goes to a credit pool, and its refusal never marks a pool drained |
| Linked orgs sit at least at the Start tier (4,000 RPM on Opus) | rate limits are not a concern |

## Shape

A third agw process, `packages/gateway`, its own LaunchAgent on `127.0.0.1:7794` (7793 is the software-factory server's). **It is a lean process, not a
`bootProcess` one** (owner, 2026-11-01): every LLM call from the mini goes through it, so it must not depend on the
journal Postgres, the workflow runtime or OpenCode, and its import closure stays small so most releases leave its build
unchanged. It runs as one bundled file. **A local SQLite ledger in its state dir is the outbox:** each served request
writes one row synchronously when the tee has the final usage, and a flush loop upserts unsynced rows into
`usage.records`. A crash or a Postgres outage loses nothing, and the meter reads the ledger, so it survives a restart
without Postgres. In this repo because it reuses the route table (model ids stay in one place), the door tokens, the
balance classifier and deploy with rollback. A deploy restarts it only when its build changed, so unrelated deploys do
not cut streams.

**It mirrors IU's path layout**, so a caller switches by base URL and token alone:

| Path | Upstream |
|-|-|
| `/anthropic/v1/messages` (+ `count_tokens`) | a credit org, else IU `/anthropic` (same protocol, same models) |
| `GET /anthropic/v1/models`, `GET /anthropic/v1/models/<id>` (one segment of model-id characters, else 404) | IU `/anthropic`, with the `personal` key: door auth, no pick, no row, the way modelpick reads the catalog |
| `/openai/v1/*`, `/gemini/v1beta/*`, `/decisions/v1/*`, `/replicate/v1/*` | IU, with the `personal` key |

**Passthrough is byte-exact.** Request bytes and end-to-end headers (`anthropic-beta`, `anthropic-version`) go upstream
unchanged; the auth header is swapped, `content-length` recomputed, hop-by-hop headers (`connection`, `keep-alive`,
`transfer-encoding`, …) dropped. The response streams through unbuffered while a tee parses the `usage` block of
`message_start` / `message_delta` (or the OpenAI final chunk). Bun's `fetch` must run with `decompress: false`: by
default it decodes the body but keeps `content-encoding: gzip`, and Anthropic compresses; only the tee's copy is
decoded. A caller that hangs up cancels the upstream, so nobody pays for the rest of an abandoned stream. The one
upstream timeout is the agent-limits hang guard: 30 minutes of silence, never a cap on a long stream. No body rewriting, no format translation: the cache
traps CLIProxyAPI falls into (`system` reshaped, `cache_control` injected, JSON re-marshalled) cannot happen.

**Model aliases.** `sonnet`, `haiku`, `opus` resolve to the current concrete id from `packages/routes`, the one place
model ids live. This is the only body edit, made on the `model` field of a parsed copy only when the id is an alias;
a concrete id passes untouched. agw routes keep owning roles (which family a seat uses).

## Picking a pool

Registry: `dotfiles/config/claude-accounts.json`, the picker's single source, gets a `platform` block per account:

```json
"platform": { "creditUsd": 200, "cycleDay": 14, "headroomUsd": 2, "enabled": true,
              "apiKeyRef": "op://mini/claude-platform/API_KEY_IU",
              "adminKeyRef": "op://mini/claude-platform/ADMIN_KEY_IU" }
```

`cycleDay` is the day the credit expires and renews, as the Console's Billing page shows it. It is not the
subscription's payment day: `iu` pays on the 18th, its credit turns over on the 21st. `null` means unknown:
the meter then sums the pool's rows over a rolling 31 days, which never under-counts the real cycle, and the pool stays
usable. Keys resolve through `secrets-run` at start. A ref that does not resolve disables that pool and logs why; the gateway still starts.
`platform.evalReserveUsd` (a number ≥ 0, never required) overrides the pool's computed eval reserve (§Credit pacing).

Per request, in order:

0. **A forced request goes to IU.** `x-agw-upstream: iu` on an `/anthropic` path skips the credit pools (read-only check,
   no body edit; an `eval` request is refused instead, §Credit pacing), reason `forced` in `gateway_picks` and `lane_detail.fallback` null, since it is a choice and not a fallback: modelpick's probes measure IU itself, so a probe must not land on a credit org. It
   beats a bound session, leaves the binding as it found it, and `x-agw-fallback: none` does not refuse it, since the
   caller asked for IU.
   **Claude-Code-shaped requests go to IU.** A request carrying any of the signals above (read-only check, no body edit)
   skips the credit pools.
1. **Session binding.** The key is `(caller, session)`, the caller from the door token. The session id is the first of
   `x-agw-session` (agw sends its root run's id; OpenCode steps too, through the host's plugin; Hermes through
   `session_affinity_header`), `x-claude-code-session-id`, `x-session-affinity` (OpenCode's root session, so sub-agents
   share their parent's pool), `metadata.user_id`, a hash of the first user message. A bound session stays on its pool while that pool is eligible.
   Bindings are written only when a request is served, TTL 1 h refreshed per request, in memory.
   A value over 200 characters is replaced by `h:` + its hash before any use, so picks, rows and spans stay bounded.
2. **New session.** The eligible pool whose cycle ends soonest. Eligible: enabled, key resolved, and
   `meter + headroom < credit`. **`x-agw-purpose: eval`** narrows both this step and the binding in step 1 to pools that
   are also above their eval reserve (§Credit pacing): a bound session whose pool is not goes through this step again.
3. **No pool eligible.** IU `/anthropic`, unless the caller sent `x-agw-fallback: none`. Then the gateway answers 402
   with the balance marker, and the caller's own route fallback (agw: GPT on IU) takes over. **An `eval` request never
   gets here:** with no eval-eligible pool it is refused (403, §Credit pacing), whatever `x-agw-fallback` says.
4. **Refused for balance anyway** (meter drift): `isBalanceFailure` knows Anthropic's 400 "credit balance is too low";
   the pool is marked drained and the request is picked again without it, pool by pool, until the pick is no pool: IU,
   or the 402. One cache miss, accepted. Step 0 keeps a funded pool from being drain-marked by a Claude Code refusal, and
   the mark lasts 1 h (never past the credit's expiry) in case a refusal gets past it: a funded pool is out for an hour,
   not a month, and a really drained one costs one refused request an hour, retried on IU.

**The fallback order, in one place.** The first line that applies wins:

1. **An `eval` request that is forced or Claude-Code-shaped:** the 403 refusal, reason `eval-forced` / `eval-claude-code`. An eval request never reaches IU, so this comes first.
2. **Forced** (`x-agw-upstream: iu`): IU, whatever the other purposes; modelpick's probes only.
3. **Claude-Code-shaped:** IU, or the 402 with `x-agw-fallback: none`.
4. **A bound pool**, while it is eligible (for `eval`: and above its reserve).
5. **The soonest-expiry pool** (for `eval`: among the eval-eligible ones).
6. **No pool, production** (`prod`, `verify`, `drift`, no purpose): IU, or the 402 with `x-agw-fallback: none`, after which the agw route falls
   back onto GPT on IU.
7. **No pool, `eval`:** the 403 refusal, reason `eval-reserve`. Never IU, never GPT.

**Meter.** Per pool and cycle: at boot the ledger's charges since the cycle start, then each response priced with the
route rates. A row's `cost_reported_usd` carries only a figure priced from a complete reported usage block. Anything less
on a credit pool is an estimate, which goes to the meter and to `lane_detail.costEstimatedUsd` (`costEstimated: true`),
never to the row's cost:

- **Server tools:** a credit pool's figure, reported or estimated, also carries web searches at $10 per 1,000
  (`usage.server_tool_use`). Web fetch and code execution have no per-use price.
- **No rate for the model:** the usage at the most expensive Claude rate.
- **No complete usage** (a client abort, the hang guard, a fetch error, a 2xx nobody can read): the `message_start`
  input and cache tokens if seen, each at its own rate, else request bytes / 3 as input; output is the larger of the
  tokens seen and response bytes / 3. A non-streamed request cut before any byte takes the smaller of its `max_tokens` and 8192. Priced
  at the model's rate, else the top one.

Off `/anthropic` (IU's OpenAI, Gemini, Replicate and decision paths) nothing is metered, but a row is still priced: the
provider's `usage.cost` if IU states one (DeepSeek), else a complete usage block at the `rate` of the route that names the
requested model (`routeRate`, `@agent-workflows/routes/rates`), the figure agw's own transports wrote before the gateway
(GPT Terra, Gemini flash). A Responses-API block is priced as its chat equivalent, its `input_tokens` holding the cached
reads. No route rate, or a cache count the rate has no price for, leaves the cost null. When IU echoes the requested model
behind a provider prefix (`openai.<id>`, `vertex_ai_eu/<id>`), the row's `model` is the requested id and `model_raw` the
echo.

Spend made outside the gateway counts against the credit (`iu` spent $56.11 on 2026-10-31, before any gateway). No API
returns the grant, the balance or the cycle, so the registry's `creditUsd` and `cycleDay` stay the source. For each pool
with an admin key, at boot (before listening, 30 s at most) and hourly:

- **Reconciled** = legacy `cost_report` over the cycle's complete UTC days + the ledger since the start of the current
  UTC day. The report has no row for today, refuses a start inside it and lags 20–70 min; the ledger covers that gap. A
  cycle that started today skips the call. Amounts are cents as decimal strings.
- **The meter keeps the higher** of itself and the reconciled figure; a lagging report never lowers it. An unknown cycle
  reads the rolling 31 days, and there the reconciled figure replaces the floor.
- **Any failure** (admin key missing, a non-2xx, a 30 s timeout) keeps the ledger meter. It shows as `reconcileError` on
  `/health` and logs once per kind.
- **The high-water mark is stored per pool and cycle in the ledger DB:** the larger of the last mark plus the ledger since
  it and the new figure. Each start applies it first, before listening and before any live call, so a restart during an
  Admin API outage or on a lagging report keeps the outside spend. An unknown cycle stores its latest figure, since its
  window moves.

## Credit pacing

Wave 6 runs eval arms (`x-agw-purpose: eval`) on the Claude credit. Production must keep enough of it to last to each pool's
expiry, so a sweep can never push production off the credit onto the IU key that is over its cap. Each pool's `/health` entry
carries its runway, and an eval request may draw only on what production does not need.

| Field | Meaning |
|-|-|
| `creditLeftUsd` | `max(0, creditUsd − meterUsd − headroomUsd)` |
| `daysLeft` | fractional days to `cycleEnd`; null on an unknown cycle |
| `runwayUsdPerDay` | `creditLeftUsd / daysLeft`; null when `daysLeft` is null or 0 |
| `evalReserveUsd` | what production keeps (below) |
| `evalAvailableUsd` | `max(0, creditLeftUsd − evalReserveUsd)`; 0 for a pool that is not `eligible` (unusable, drained, meter error, spent) |
| `evalEligible` | `evalAvailableUsd > 0` |

**The reserve** is production's pro-rata share of the days left: `creditUsd × daysLeft / cycleLengthDays`, the cycle length
being cycleStart → cycleEnd (31, 30 or 28 days). It starts at the whole credit and falls to nothing at expiry, so a pool
that spends below its straight line has surplus and one above it has none. An **unknown cycle** has no pacing basis: the reserve is
`creditUsd`, and evals never draw from it unless `evalReserveUsd` is set. `platform.evalReserveUsd` (number ≥ 0) replaces the computed figure for that
pool; `0` frees the whole credit to evals. A reserve above `creditUsd` leaves the pool no eval draw; the gateway logs a warning at start.

**The eval rule.** For `eval`, a pool is a candidate only if it is eligible as for any request and `creditLeftUsd −
evalReserveUsd > 0` at the current meter; a request's own cost is not known beforehand. Among candidates the order is the
usual one, soonest expiry first. **An eval request never reaches IU.** With no candidate it is refused, `x-agw-fallback`
or not. So it is when it is Claude-Code-shaped (it could only go to IU) or **forced** (`x-agw-upstream: iu`): eval beats
forced, and a probe that needs IU must not carry `x-agw-purpose: eval`. The refusal is recorded in `gateway_picks` as
`picked = refused`, `reason = eval-reserve`, `eval-claude-code` or `eval-forced`, with no ledger row and no upstream call. Every other
purpose picks, orders and falls back exactly as before.

**The overshoot.** The meter counts a response once it ends, so concurrent eval requests overshoot the reserve by up to their
in-flight cost (eval concurrency × per-call cost). That is accepted: the reserve is a pacing line, not a cap, and production
still has the headroom beneath it.

**Why the refusal is a 403 and not a 402.** `isBalanceFailure` counts a 402 as an empty provider balance, so the agw route would
fall back onto GPT: that spends IU and replaces the arm's model with another, which corrupts the measurement. A
408, 409, 429 or 5xx is retried (the transports' `RETRYABLE_STATUS`, and the Anthropic, OpenAI and AI SDKs, OpenCode's included, which also
retry 409), so the same refusal would be asked again. A 403 is neither: a `permission_error` in Anthropic's body shape, whose message
is fixed text that names the reason (`eval reserve`, or why an eval request is refused) and points at each pool's `evalAvailableUsd` on `/health`; building it reads no pool state, so the refusal path does no ledger read. `x-agw-pick-reason` says which. The body carries no balance wording.

## Callers and attribution

Callers authenticate with a door token (`data/door-tokens`, one line per caller: `hermes`, `agw-opencode` (the OpenCode
server), `oc`, `modelpick`, …; the API secret is `agw`)
as `authorization: Bearer <t>`, `x-api-key`, `x-goog-api-key`, `api-key` or a `key` query parameter (whichever the
caller's SDK sends). None of them goes upstream. The caller name comes from the credential, never a header; a door token never opens the API. Optional headers: `x-agw-run-id`, `x-agw-workflow`, `x-agw-step`, `x-agw-purpose`,
`x-agw-project`, `x-agw-workspace`, `x-agw-origin`, `x-agw-route-fallback`, `x-agw-usage`, `x-agw-upstream`, `traceparent`.

**Who asked, and what a call replaces.** The door caller says which door the call came through (`agw`, `agw-opencode`);
`x-agw-origin` says who asked agw: the root run's caller (`runs.caller`: `claude-code`, `hermes`, `iris`, `cli`, …, or
`eval` / `host` for a run the host started itself), so a child run reports who asked for its tree. It is stored as
`lane_detail.origin` when it matches the caller pattern (`[a-z][a-z0-9-]{0,31}`), else dropped. `x-agw-route-fallback`
marks a call that runs because the route's Claude call was refused for balance (the 402 of `x-agw-fallback: none`) and
agw fell back onto its GPT route: it carries the refused response's `x-agw-request-id`, which is the `request_id` of that
refusal's `refused` row in `usage.gateway_picks`, so the fallback row joins the refusal. A site that cannot see the
response headers (OpenCode's error text) sends `unknown`. It is stored as `lane_detail.routeFallback`
when it is a request id as the gateway mints them (a UUIDv7) or `unknown`, else dropped. Both are attribution only: neither
changes a pick.

The caller sets the lane: `agw` and `agw-opencode` are `agw_workflow`, `hermes` is `hermes`, any other is `other` with the
caller's name in `lane_detail.raw`, the key Argo labels an `other` row from. `x-agw-project` is the row's `project_raw`
and, as a plain slug outside workspace `work`, its `repo`; `x-agw-workspace` is `workspace` when it says `work` or
`private`. The same rule as agw's own rows (`repoOf`, `packages/middleware/src/usage.ts`), copied because the gateway may
not import middleware. A value over 200 characters is dropped.

**The gateway is the only writer of inference usage rows, with one exception (§Usage and telemetry).** agw keeps tokens
and cost in its run record and spans, but stops writing `usage.records` for calls that go through the gateway, so nothing
is counted twice.

**OpenCode** (pinned build) sends the session id on every request with no configuration (`x-opencode-session-id`, and
`x-session-affinity` with the root session's id). The host adds the attribution headers (`x-agw-session`, the root run's
id, from `rootId`; `x-agw-run-id`, `x-agw-step`, `x-agw-workflow`, `x-agw-purpose`, `x-agw-project`, `x-agw-workspace`, `x-agw-origin`; on
the session the host opens when a turn fails on provider balance, also `x-agw-route-fallback: unknown`)
through a small plugin on the `model.request` hook, reading the step's `Attribution` (`runId`, `rootId`, `workflow`, `step`,
`purpose`, `project`, `workspace`, `origin`, and `routeFallback` on a fallback session) from the session's `metadata.agw`; the plugin is a directory in the server config's
`plugins`. `traceparent` is not among them: OpenCode's HTTP client writes its own at send time. The join by
`opencode.session.id` on the step span stays as the fallback. **Hermes** sets `session_affinity_header: x-agw-session` on its gateway provider entry (an
`anthropic_messages` entry); static `extra_headers` are not relied on (auxiliary calls drop them). Neither uses
`metadata.user_id`. Evidence: `docs/spikes/gateway/headers.md`.

## Usage and telemetry

Schema changes in usage-tracker (`migrations/pg`, it owns the `usage` schema):

- `records.billing` gains `api_credit`; `account` (`iu|me|me2`) is set on those rows. Gateway rows: `source='gateway'`,
  `repo`, `project_raw`, `workspace` from the caller's headers, `lane_detail {caller, raw, session, run_id, workflow, step,
  purpose, origin, routeFallback, pool, fallback}` (`raw` on lane `other` only; `origin` and `routeFallback` only when the
  caller sent a valid `x-agw-origin` / `x-agw-route-fallback`).
- `usage.credit_cycles` (account, cycle start/end, grant, metered, reconciled, unspent at close).
- `usage.gateway_picks` (ts, caller, session, picked, reason, machine, request_id), modelled on `account_picks`, one row
  per routing decision: `picked` is a pool id, `iu-api` (the IU passthrough, because a pool is itself named `iu`) or
  `refused`. A drained retry writes two rows; `count_tokens` and a model catalog read write none.
- `usage.platform_cost` (account, day, model, api_key_id, cost_usd), filled by a usage-tracker pass from
  `GET /v1/organizations/analytics/cost` (beta header `analytics-usage-cost-2026-08-24`, `group_by[]=api_key_id` and
  `model`, `cost_usd = amount / 100`; request shapes in `docs/spikes/gateway/admin-api.md`) with each org's admin key, like
  `iu_portal_cost`. Not legacy `cost_report`: it cannot group by key. A missing
  admin key skips that org.

**Rows without a gateway row.** A request from caller `agw` with `x-agw-usage: caller` on `/openai/v1/images/`,
`/openai/v1/audio/`, `/gemini/v1beta/` or `/replicate/v1/` writes no `records` row and no ledger row. These are agw's media
calls, priced per minute, per character or per image: only agw can price them, so agw writes their row itself. From any
other caller or on any other path the header is ignored and the row is written, so a Claude call always hits the meter
and no other token can opt out. The other requests without a row are a `count_tokens`, a model catalog read and a 402.
Every one of them but the 402 still sets the span's response model and usage attributes; `agw.cost.usd` comes only with a
row.

One span per request, service `agw-gateway` (`gen_ai.*` attributes, pool, cache read/write tokens, time to the first
body byte), parented by `traceparent`. Every response carries `x-agw-request-id`, the row's `source_id`, and `x-agw-pool`.

Argo: payers `iu-credit`, `me-credit`, `me2-credit` beside `iu-api`; a Credits tab with burn-down per pool against its
cycle, projected unspent credit, picks and fallbacks, and cache-hit rate per caller.

## Callers that move

| Caller | Today | Change |
|-|-|-|
| agw transports (`iu-*`, the direct `anthropic` wire) | **done:** the gateway (`AGW_GATEWAY_URL`, the API secret as caller `agw`); `.env.tpl` holds no provider key, `iu.env` and `IU_KEY_ID` are gone | — |
| agw OpenCode providers | **done:** the gateway with the `agw-opencode` door token (`AGW_GATEWAY_TOOL_TOKEN`, read by `scripts/launch.sh`) | — |
| Hermes | IU via `OPENAI_BASE_URL` / `ANTHROPIC_BASE_URL` | the gateway; vision moves to `anthropic_messages`, approvals off `-eu` |
| dotfiles `oc`, modelpick | IU | the gateway; their door tokens (`oc`, `modelpick`) are in `data/door-tokens` since the deploy that made agw keyless |
| email-gateway (VPS), Karakeep (homelab) | IU | later, over Tailscale, once the gateway has run clean for two weeks |
| Claude Code, Athena Teamchat | subscription, Athena relay | never |

## Seats

Owner, 2026-11-02 (Wave 6): agw runs on Claude with a deliberate model and effort per seat, measured where an eval
suite exists. The table and its tiers are `packages/routes` (README §Seats); the picks and their evidence are
`modelpick/docs/decisions/agw-text-seats.md`.

- **Claude is primary for every text and agent seat**, on the credit while a pool has it. Each Claude route falls back
  onto GPT on IU, never onto IU's Claude (`x-agw-fallback: none`).
- **A reviewer of Claude-written output stays on another lab:** `prose.review` and `podcast.review.a`/`.b` judge what a Claude writer (a Claude Code session or a Claude seat) produced, and a critic of the
  same lab shares its blind spots. Their capabilities refuse a Claude model.
- **Speech, transcription, image and `decide` stay on IU.** The credit pays only for Anthropic's Messages API; those
  models are not Claude's. `decide` is also the eval judge, on its own pinned route.
- **Opus only where an arm shows it beats Sonnet beyond the CI** on the seat's own suite. Without that evidence the
  seat stays on Sonnet or Haiku.
- **Pick order per seat:** score first, then wall time. Cost counts only past the credit pacing line (§Credit pacing):
  below it the credit is spent anyway.

## Open

- The Admin API works on a one-person org (Wave 1, `iu` and `me`); units and credit basis are proven on `iu` only, `me`
  had no spend yet.
- Whether the personal IU key's $500 is enforced by IU or only a portal figure. While credit lasts it barely matters.
