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

A third agw process, `packages/gateway`, its own LaunchAgent on `127.0.0.1:7793`. **It is a lean process, not a
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

Per request, in order:

0. **Claude-Code-shaped requests go to IU.** A request carrying any of the signals above (read-only check, no body edit)
   skips the credit pools.
1. **Session binding.** The key is `(caller, session)`, the caller from the door token. The session id is the first of
   `x-agw-session` (agw sends its run id; OpenCode steps through the host's plugin; Hermes through
   `session_affinity_header`), `x-claude-code-session-id`, `x-session-affinity` (OpenCode's root session, so sub-agents
   share their parent's pool), `metadata.user_id`, a hash of the first user message. A bound session stays on its pool while that pool is eligible.
   Bindings are written only when a request is served, TTL 1 h refreshed per request, in memory.
2. **New session.** The eligible pool whose cycle ends soonest. Eligible: enabled, key resolved, and
   `meter + headroom < credit`.
3. **No pool eligible.** IU `/anthropic`, unless the caller sent `x-agw-fallback: none`. Then the gateway answers 402
   with the balance marker, and the caller's own route fallback (agw: GPT on IU) takes over.
4. **Refused for balance anyway** (meter drift): `isBalanceFailure` knows Anthropic's 400 "credit balance is too low";
   the pool is marked drained for the cycle and the request runs once more on a fresh pick (the next pool, else IU, else
   the 402). A second refusal is answered as it came. One cache miss, accepted. Step 0 keeps a funded pool from being
   drain-marked by a Claude Code refusal.

**Meter.** Per pool and cycle: at boot the ledger's rows since the cycle start, then each response priced with the route
rates. A model with no rate is charged at the most expensive Claude rate, and its row says `costEstimated: true`.

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

## Callers and attribution

Callers authenticate with a door token (`data/door-tokens`, one line per caller: `agw`, `hermes`, `oc`, `modelpick`, …)
as `authorization: Bearer <t>` or `x-api-key: <t>` (the Anthropic SDK sends the latter). The caller name comes from the
credential, never a header; a door token never opens the API. Optional headers: `x-agw-run-id`, `x-agw-workflow`, `x-agw-step`, `x-agw-purpose`,
`traceparent`.

**The gateway is the only writer of inference usage rows.** agw keeps tokens and cost in its run record and spans, but
stops writing `usage.records` for calls that go through the gateway, so nothing is counted twice.

**OpenCode** (pinned build) sends the session id on every request with no configuration (`x-opencode-session-id`, and
`x-session-affinity` with the root session's id). The host adds `x-agw-session` (the run id), `x-agw-run-id` and
`x-agw-step` through a small plugin on the `model.request` hook, reading `runId` / `stepId` from the session's
`metadata.agw`; the plugin is a directory in the server config's `plugins`. The join by `opencode.session.id` on the step
span stays as the fallback. **Hermes** sets `session_affinity_header: x-agw-session` on its gateway provider entry (an
`anthropic_messages` entry); static `extra_headers` are not relied on (auxiliary calls drop them). Neither uses
`metadata.user_id`. Evidence: `docs/spikes/gateway/headers.md`.

## Usage and telemetry

Schema changes in usage-tracker (`migrations/pg`, it owns the `usage` schema):

- `records.billing` gains `api_credit`; `account` (`iu|me|me2`) is set on those rows. Gateway rows: `source='gateway'`,
  `lane_detail {caller, session, run_id, workflow, step, pool, fallback}`.
- `usage.credit_cycles` (account, cycle start/end, grant, metered, reconciled, unspent at close).
- `usage.gateway_picks` (ts, caller, session, picked, reason, machine, request_id), modelled on `account_picks`, one row
  per routing decision: `picked` is a pool id, `iu-api` (the IU passthrough, because a pool is itself named `iu`) or
  `refused`. A drained retry writes two rows; `count_tokens` writes none.
- `usage.platform_cost` (account, day, model, api_key_id, cost_usd), filled by a usage-tracker pass from
  `GET /v1/organizations/analytics/cost` (beta header `analytics-usage-cost-2026-08-24`, `group_by[]=api_key_id` and
  `model`, `cost_usd = amount / 100`; request shapes in `docs/spikes/gateway/admin-api.md`) with each org's admin key, like
  `iu_portal_cost`. Not legacy `cost_report`: it cannot group by key. A missing
  admin key skips that org.

One span per request, service `agw-gateway` (`gen_ai.*` attributes, pool, cache read/write tokens, time to the first
body byte), parented by `traceparent`. Every response carries `x-agw-request-id`, the row's `source_id`, and `x-agw-pool`.

Argo: payers `iu-credit`, `me-credit`, `me2-credit` beside `iu-api`; a Credits tab with burn-down per pool against its
cycle, projected unspent credit, picks and fallbacks, and cache-hit rate per caller.

## Callers that move

| Caller | Today | Change |
|-|-|-|
| agw transports (`iu-*`, the direct `anthropic` wire) | IU, `athena-team` key on the mini | base URL to the gateway, door token; Athena's key leaves agw |
| agw OpenCode providers | IU; `anthropic-direct` unused | all providers on the gateway |
| Hermes | IU via `OPENAI_BASE_URL` / `ANTHROPIC_BASE_URL` | the gateway; vision moves to `anthropic_messages`, approvals off `-eu` |
| dotfiles `oc`, modelpick | IU | the gateway |
| email-gateway (VPS), Karakeep (homelab) | IU | later, over Tailscale, once the gateway has run clean for two weeks |
| Claude Code, Athena Teamchat | subscription, Athena relay | never |

## Open

- The Admin API works on a one-person org (Wave 1, `iu` and `me`); units and credit basis are proven on `iu` only, `me`
  had no spend yet.
- Whether the personal IU key's $500 is enforced by IU or only a portal figure. While credit lasts it barely matters.
