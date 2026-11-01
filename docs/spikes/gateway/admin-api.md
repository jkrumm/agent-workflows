# Spike: Admin API cost probe (`iu`, `me`)

Wave 1 of `docs/waves/PLAN.md`, step "Admin API probe". Feeds `usage.platform_cost` and the meter reconcile in
`docs/gateway.md` §Usage and telemetry. Run 2026-11-01, read-only: `GET /v1/organizations/*` only, no Messages API call.
Probe: `docs/spikes/gateway/admin-api/probe.ts` (`bun run probe.ts`, `bun run probe.ts --watch <minutes>`). Output is
redacted: no ids, no keys, dollar amounts as bands. `me2` is a placeholder and was not touched.

## Verdict

Both one-person orgs get the full Admin API. Use `GET /v1/organizations/analytics/cost` (beta) for `platform_cost`: it
is the only cost endpoint that groups by API key. Its `amount` is **cents**, as a decimal string, at list price, before
credits. No endpoint returns a balance.

## Docs read (2026-11-01)

| Endpoint | Status | Notes |
|-|-|-|
| `GET /v1/organizations/analytics/cost` | beta, header `anthropic-beta: analytics-usage-cost-2026-08-24` | recommended by Anthropic for new integrations; `time_bucket_width` 1m/1h/1d, optional (none = one row for the range); `group_by[]` up to 5 of `model api_key_id workspace_id actor service_tier context_window inference_geo speed …` plus `cost_type`, `token_type` (not counted); rows ranked, `limit` 1–1000 rows (default 20) |
| `GET /v1/organizations/analytics/usage` | beta, same header | same dimensions, token counts and `requests` |
| `GET /v1/organizations/cost_report` | legacy, supported | daily only; `group_by[]` is `workspace_id` and `description` only; `limit` counts buckets (max 31) |
| `GET /v1/organizations/usage_report/messages` | legacy, supported | `bucket_width` 1m/1h/1d, `group_by[]` includes `api_key_id`, `model`; `limit` counts buckets (1d ≤ 31, 1h ≤ 168, 1m ≤ 1440) |

Both families: `x-api-key: <admin key>`, `anthropic-version: 2023-06-01`, pagination by `has_more` / `next_page` →
`page=`. `starting_at` ≥ 2026-01-01 and ≤ 365 days back; at most 31 days per request. Docs say the Admin API is
"unavailable for individual accounts"; a one-person Console org is an org and works (below).

## Per org

| | `iu` | `me` |
|-|-|-|
| Access (admin key → 200) | `organizations/me`, `api_keys`, `workspaces`, `cost_report`, `usage_report/messages`, `analytics/cost`, `analytics/usage`: all 200 | same, all 200 |
| Data in the window | 30-day lookback: 2 days with usage (last on 2026-10-31, 07:00–12:00 UTC), 2 models (Haiku 5.5, Sonnet 5.5), ~3k requests, ~260M tokens, tens of USD. **Nothing yet on 2026-11-01** | none in 30 days, zero rows on every endpoint |
| Units | `amount` is a string with 6 decimals, **cents** (`"1234.567890"` = $12.35). Proof: `amount / 100 / MTok` per model, context window and token type reproduces the public price list exactly (Haiku 5.5 0.10 / 0.50 / 0.125 / 0.01 $/MTok ≤100k and ×5 above, Sonnet 5.5 2 / 10 / 2.50 / 0.10) | not verifiable, no spend; same code path |
| Before / after credits | **Before.** `cost.amount` equals `cost.list_amount` on every row and equals list price; there is no credit, balance, grant or discount field in any response. Docs: "after discounts and before any credits" | not verifiable, same endpoint |
| Grouping by API key | `analytics/cost` and `analytics/usage` (`group_by[]=api_key_id`): works, 1 distinct key; `usage_report` too. `cost_report` (legacy): **400** `Invalid group_by[]: "api_key_id". Valid options are "description", "workspace_id"` | not verifiable (1 key listed, no usage) |
| Other row shape | analytics rows: `starting_at`, `ending_at`, `group.{model, api_key_id, workspace_id, context_window, service_tier, inference_geo, speed, actor, …}`, `cost.{amount, list_amount, currency, requests}`; legacy cost rows carry `description` ("Claude Haiku 5.5 - Input Tokens, Cache Hit") and `workspace_id: null` for the default workspace | n/a |
| Token fields | `uncached_input_tokens`, `cache_read_input_tokens`, `cache_creation.ephemeral_5m_input_tokens`, `cache_creation.ephemeral_1h_input_tokens`, `output_tokens`, `server_tool_use.web_search_requests`; analytics adds `total_tokens`, `requests`. Legacy and analytics token sums are identical over the same window | n/a |
| Lag | `analytics/*`: `data_refreshed_at` hourly, 6–50 min behind now; legacy cost: previous UTC day at best; fresh-request lag not measured (no new traffic) | same endpoints and snapshots; no traffic to time |
| Balance | none (below) | none |

### Lag

The sibling passthrough spike's Haiku calls **never showed up**: the `iu` org has no usage on 2026-11-01 at all (1m
buckets of the last 6 h, 1h buckets for the month, `analytics/usage` and legacy `usage_report`, last checked 17:46 UTC),
and a 15-minute watch (`probe.ts --watch 15`, one poll a minute per endpoint, 17:31–17:46 UTC) saw no new bucket on
either org. Either the spike had not called yet or its usage is later than the ~75 minutes covered, so **the lag of a
fresh request is not measured**. What was measured:

| Observation | Value |
|-|-|
| Latest day with `iu` usage | 2026-10-31, hours 07–11 UTC (the 12:00 end is the last bucket), visible 5+ hours later |
| `analytics/*` `data_refreshed_at` for ranges touching today | 16:39:11Z at 17:28–17:31, then 17:40:14Z at 17:46: a snapshot about hourly, 6–50 min behind now |
| `analytics/*` `data_refreshed_at` for a 30-day range with 1d buckets | 01:38:40Z, ~16 h behind now; the same endpoint with a 1h bucket or no bucket returned the hourly snapshot. Take the value per response, never assume it |
| Docs | analytics: "typically within 4 hours, up to 24 hours", revisable until ~7 days after month end; legacy usage/cost: "typically within 5 minutes" |
| Legacy `cost_report` | newest bucket is the previous UTC day; any `starting_at` in the current UTC day is a 400 |

Rerun the watch when the passthrough spike is calling: `bun run probe.ts --watch 20 iu` prints, per bucket, how long
after the bucket end it first appeared on each endpoint.

### Balance

Expected and confirmed: no API returns the remaining credit. `GET /v1/organizations/{credit_balance,balance,billing,credits}`
all 404 on both orgs; `spend_limits/effective` answers 400 "not supported for this organization type" (Enterprise
members only). No response from any call contains a field matching `credit|balance|remaining|discount|grant|prepaid`.
The gateway's own meter stays the only source of "credit left".

## Request shapes for the reconciler (Wave 4)

`platform_cost` (account, day, model, api_key_id, cost_usd), per org with `ADMIN_KEY_<ORG>`:

```
GET /v1/organizations/analytics/cost
    ?starting_at=<day>T00:00:00Z&ending_at=<day+1>T00:00:00Z
    &time_bucket_width=1d&group_by[]=api_key_id&group_by[]=model&limit=1000
x-api-key: <admin key>      anthropic-version: 2023-06-01
anthropic-beta: analytics-usage-cost-2026-08-24      user-agent: agent-workflows/<version> (usage-tracker)
```

- `cost_usd = amount / 100`; keep `amount` as a decimal string until it is stored as `numeric`.
- Rows with no usage are absent; fill the gaps. `model` and `api_key_id` can be `null` (non-token cost types such as
  web search, Console playground); key the upsert on `(account, day, model, api_key_id)` with nulls coalesced.
- Per the docs, `cost_type` / `token_type` split a row only when listed in `group_by[]`; without them token,
  web-search and code-execution cost share one row per group (not separately observed: `iu` has no non-token cost).
- Page on `has_more` / `next_page` (`page=`); every page reads one snapshot, `data_refreshed_at` is the same on all.
- Re-query a trailing window, not one day: values are revised until about 7 days after month end. Run hourly at most
  (docs allow once a minute sustained). A cycle is "reconciled" only when `ending_at <= data_refreshed_at`.
- A window is at most 31 days and `starting_at` must be on or after 2026-01-01. A subscription cycle (28–31 days)
  fits one request; split anything longer.
- Drift check on tokens (not money): `GET /v1/organizations/analytics/usage` with `time_bucket_width=1h`,
  `group_by[]=api_key_id&group_by[]=model`, compare `uncached_input_tokens`, `cache_read_input_tokens`,
  `cache_creation.*`, `output_tokens` with the gateway's rows. Tokens are exact; the legacy `usage_report/messages`
  returned the same totals.
- Do not use legacy `cost_report` for `platform_cost`: no api-key grouping and no rows for the current UTC day (below).
- For the gateway's meter: Haiku 5.5 bills $0.10 / $0.50 per MTok (input / output) up to 100k prompt tokens and
  $0.50 / $2.50 above, per the pricing page. The cost report labels those rows context window `0-200k` and `200k-1M`
  and priced them at exactly those two tiers; the 100k vs 200k boundary was not isolated, so test it before trusting it.

## Contradictions with `docs/gateway.md`

| Line in `docs/gateway.md` | What is true |
|-|-|
| "`analytics/cost` and `cost_report` return spend **before credits**, 5 min to 24 h late" (§What the credit is) | Before credits: confirmed. Lag differs by endpoint: `analytics/*` carries a `data_refreshed_at` that was 6–50 min behind now over the session (docs: typically 4 h, up to 24 h; a 30-day 1d query showed ~16 h), and fresh-request lag could not be timed. Legacy `cost_report` also has **no row for the current UTC day**: `starting_at` inside today returns 400 "Invalid date range: ending date must be after starting date" for any `ending_at`, so it lags a full day. |
| "`GET /v1/organizations/analytics/cost` (or `cost_report`) … `usage.platform_cost` (account, day, model, api_key_id, cost_usd)" (§Usage and telemetry) | Not interchangeable. `cost_report` cannot group by `api_key_id` (400). Use `analytics/cost`, a beta endpoint that needs the `anthropic-beta: analytics-usage-cost-2026-08-24` header. `cost_usd` is `amount / 100` (cents). |
| "Admin API on a one-person org is undocumented; the reconciler is optional per org until it is proven." (§Open) | Proven for both orgs: every Admin endpoint answers 200 with an admin key. Grouping, units and credit basis are proven on `iu` only; `me` has no spend yet, so rerun `probe.ts` once `me` has traffic. The docs line "Admin API is unavailable for individual accounts" does not apply to a one-person Console org. |
| "No API returns the remaining balance" | Confirmed, no counter-evidence. |

## Not covered

- `me`: units, grouping and credit basis follow from the same endpoints but were not observed (no spend).
- The probe made no Messages call, so the sibling passthrough spike's traffic was only observed if it landed during the
  watch (Lag).
- `group_by[]=actor` and a multi-page analytics response beyond `limit=2` were not exercised; the paging fields
  (`has_more`, `next_page`) were, and work as documented.
