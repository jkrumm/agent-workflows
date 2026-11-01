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
| No API returns the remaining balance; `analytics/cost` and `cost_report` return spend **before credits**, 5 min to 24 h late | the gateway meters itself and reconciles against the cost API |
| Prompt caches are isolated per organization | a session that changes org loses its cache |
| With no payment method on file, a drained org refuses: "Your credit balance is too low…" | overspend is impossible; the headroom only avoids a mid-session refusal |
| Linked orgs sit at least at the Start tier (4,000 RPM on Opus) | rate limits are not a concern |

## Shape

A third agw process, `packages/gateway`, its own LaunchAgent on `127.0.0.1:7793`, booted through `bootProcess` like
the audio process. In this repo because it reuses the route table (model ids stay in one place), the usage outbox,
OTel, the door tokens, the balance classifier and deploy with rollback. A deploy restarts it only when its release
changed, so streams are not cut by unrelated deploys.

**It mirrors IU's path layout**, so a caller switches by base URL and token alone:

| Path | Upstream |
|-|-|
| `/anthropic/v1/messages` (+ `count_tokens`) | a credit org, else IU `/anthropic` (same protocol, same models) |
| `/openai/v1/*`, `/gemini/v1beta/*`, `/decisions/v1/*`, `/replicate/v1/*` | IU, with the `personal` key |

**Passthrough is byte-exact.** Request bytes and headers (`anthropic-beta`, `anthropic-version`) go upstream unchanged;
only the auth header is swapped. The response streams through unbuffered while a tee parses the `usage` block of
`message_start` / `message_delta` (or the OpenAI final chunk). No body rewriting, no format translation: the cache
traps CLIProxyAPI falls into (`system` reshaped, `cache_control` injected, JSON re-marshalled) cannot happen.

**Model aliases.** `sonnet`, `haiku`, `opus` resolve to the current concrete id from `packages/routes`, the one place
model ids live. This is the only body edit, made on the `model` field of a parsed copy only when the id is an alias;
a concrete id passes untouched. agw routes keep owning roles (which family a seat uses).

## Picking a pool

Registry: `dotfiles/config/claude-accounts.json`, the picker's single source, gets a `platform` block per account:

```json
"platform": { "creditUsd": 200, "cycleDay": 14, "headroomUsd": 2, "enabled": true,
              "apiKeyRef": "op://common/claude-platform/API_KEY_IU",
              "adminKeyRef": "op://common/claude-platform/ADMIN_KEY_IU" }
```

`cycleDay` is the subscription's billing day (owner fills it from claude.ai Settings → Billing). Keys resolve through
`secrets-run` at start. A ref that does not resolve disables that pool and logs why; the gateway still starts.

Per request, in order:

1. **Session binding.** The session id is the first of `x-agw-session` (agw sends its run id), `x-claude-code-session-id`,
   `metadata.user_id`, a hash of the first user message. A bound session stays on its pool while that pool is eligible.
   Bindings are written only when a request is served, TTL 1 h refreshed per request, in memory.
2. **New session.** The eligible pool whose cycle ends soonest. Eligible: enabled, key resolved, and
   `meter + headroom < credit`.
3. **No pool eligible.** IU `/anthropic`, unless the caller sent `x-agw-fallback: none`. Then the gateway answers 402
   with the balance marker, and the caller's own route fallback (agw: GPT on IU) takes over.
4. **Refused for balance anyway** (meter drift): `isBalanceFailure` learns Anthropic's "credit balance is too low"; the
   pool is marked drained for the cycle and the request runs once on the next step. One cache miss, accepted.

**Meter.** Per pool and cycle: at boot the sum of the gateway's own rows since the cycle start, then the running sum
from each response priced with the route rates. Each hour the reconciled figure (below) replaces it if higher.

## Callers and attribution

Callers authenticate with a door token (`data/door-tokens`, one line per caller: `agw`, `hermes`, `oc`, `modelpick`, …);
a door token never opens the API. Optional headers: `x-agw-run-id`, `x-agw-workflow`, `x-agw-step`, `x-agw-purpose`,
`traceparent`.

**The gateway is the only writer of inference usage rows.** agw keeps tokens and cost in its run record and spans, but
stops writing `usage.records` for calls that go through the gateway, so nothing is counted twice. Whether OpenCode can
carry per-session headers decides how OpenCode steps are attributed (Wave 1 spike); without them the join is by
`opencode.session.id` on the step span.

## Usage and telemetry

Schema changes in usage-tracker (`migrations/pg`, it owns the `usage` schema):

- `records.billing` gains `api_credit`; `account` (`iu|me|me2`) is set on those rows. Gateway rows: `source='gateway'`,
  `lane_detail {caller, session, run_id, workflow, step, pool, fallback}`.
- `usage.credit_cycles` (account, cycle start/end, grant, metered, reconciled, unspent at close).
- `usage.gateway_picks` (ts, caller, session, picked pool or `iu`, reason), modelled on `account_picks`.
- `usage.platform_cost` (account, day, model, api_key_id, cost_usd), filled by a usage-tracker pass from
  `GET /v1/organizations/analytics/cost` (or `cost_report`) with each org's admin key, like `iu_portal_cost`. A missing
  admin key skips that org.

One span per request (`gen_ai.*` attributes, pool, cache read/write tokens, TTFT), parented by `traceparent`.

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

- Admin API on a one-person org is undocumented; the reconciler is optional per org until it is proven.
- Whether the personal IU key's $500 is enforced by IU or only a portal figure. While credit lasts it barely matters.
