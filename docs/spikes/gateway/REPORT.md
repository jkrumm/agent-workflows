# Wave 1 report: gateway spike and registry

Verdicts for Wave 1 of `docs/waves/PLAN.md` (2026-11-01). Detail and evidence per step in the files linked below.
**The design in `docs/gateway.md` holds**; the spike corrected it in six places (§Corrections), all applied there.

## Verdicts

| Step | Verdict | Evidence |
|-|-|-|
| Passthrough spike | **PASS** on every check, Haiku 5.5 on the `iu` org, 28 upstream calls. Inbound and upstream bytes hash equal; the second identical call reads the 1h cache (7,680 tokens written, then read); the tee's usage equals the raw response's on streamed and non-streamed calls; TTFT through the proxy is within jitter of direct (median −12 ms, sd 72 ms); errors, `request-id` and the 12 `anthropic-ratelimit-*` headers pass through | [passthrough.md](passthrough.md) |
| Header probes | **OpenCode: yes.** The pinned build sends `x-opencode-session-id` and `x-session-affinity` on every request unasked; a `model.request` plugin hook adds `x-agw-*` headers per request with the session's `metadata` in scope. **Hermes: yes.** `session_affinity_header: <name>` puts the conversation id on every request, auxiliary calls included; static `extra_headers` are dropped on auxiliary calls. Zero LLM calls (loopback capture server) | [headers.md](headers.md) |
| Admin API probe | **Works on a one-person org** (`iu` and `me`, every endpoint 200). `analytics/cost` (beta) is the reconciler's endpoint: it groups by API key, `amount` is cents at list price, before credits. Legacy `cost_report` cannot group by key and has no row for the current UTC day. No endpoint returns a balance. fresh-request usage appears after 20 to 70 minutes (below) | [admin-api.md](admin-api.md) |
| Registry | `platform` block per account in dotfiles `config/claude-accounts.json`, refs under `op://mini/claude-platform/`: `iu` and `me` enabled, `me2` disabled (its keys are a `REPLACE` placeholder until about 2026-11-02), `cycleDay` null on all three until the owner gives the billing days. Documented in dotfiles `docs/claude-accounts.md` | dotfiles PR #55 |
| `isBalanceFailure` | Knows Anthropic's drained-org refusal: HTTP **400** `invalid_request_error`, "Your credit balance is too low to access the Anthropic API…" (not 402), on a 400 and without a status; a 400 carrying the transports' marker stays balance after truncation | PR #77 |
| `secrets-seed` and missing refs | Moot: the owner seeded every `op://mini/claude-platform/*` ref on 2026-11-01. For the record, a ref whose item does not exist aborts the whole reseal (dotfiles `scripts/secrets-seed.sh`, `dead_refs`), so a ref goes into `headless.refs` only after its item exists | — |

## Corrections applied to `docs/gateway.md`

1. **A funded credit org refuses Claude-Code-shaped requests with the drained-org 400.** The `claude-code-20250219` beta,
   the "You are Claude Code" system prefix or a `claude-cli` user-agent each draw the same 400 "credit balance is too
   low" from the `iu` org that a plain request is served on. New step 0 in §Picking a pool: such requests skip the
   credit pools, so their refusal never drain-marks a funded pool. OpenCode and Hermes send none of these signals
   (captured).
2. **Passthrough details:** `content-length` recomputed and hop-by-hop headers dropped; Bun's `fetch` needs
   `decompress: false` (by default it decodes the body and keeps `content-encoding: gzip`, and Anthropic compresses);
   upstream timeouts follow the 30-minute hang-guard rule, not the spike's 60 s.
3. **Session binding:** keyed by `(caller, session)`; `x-session-affinity` joins the chain so OpenCode sub-agents share
   their parent's pool; OpenCode steps send the run id as `x-agw-session` through a host plugin, Hermes through
   `session_affinity_header`.
4. **Callers and attribution:** the open question is closed with the header-probe result (OpenCode plugin, Hermes
   affinity header, `opencode.session.id` join as the fallback).
5. **Reconciler:** `analytics/cost` with its beta header, `cost_usd = amount / 100`; not `cost_report`. The §Open line on
   the Admin API is resolved.
6. **`cycleDay: null`** means unknown: the meter sums the pool's rows over a rolling 31 days, which never under-counts
   the real cycle, and the pool stays usable.

Smaller facts for Wave 2: the 1h cache TTL needs no beta header (GA; the old `extended-cache-ttl` value is still
accepted); Haiku 5.5 caches from 512 tokens; the Anthropic SDK sends the key as `x-api-key` and the OpenAI legs as
`authorization: Bearer`, so the door-token check reads whichever the caller's wire uses.

## Open findings

- **Usage lag of a fresh request: 20 to 70 minutes.** The passthrough spike's Haiku calls (about 17:25–17:42 UTC) were
  absent from the `iu` org's `usage_report/messages` and `analytics/usage` at 18:02 UTC and present (the 17:00 hourly
  bucket) at 18:32 UTC, against Anthropic's "about 5 minutes" for the legacy report. The spike's key is the org's
  active key (matched against the Admin API's key list). Wave 2's `make verify` must not expect the cost API to see a
  call within the run; the reconciler stays hourly.
- **Admin keys sit in the mini's shared secrets cache.** Any agent that can run `secrets-run` holds org-wide Admin
  authority for `iu` and `me` (raised in review of dotfiles PR #55). An owner decision; a least-privilege option is a
  separate reconciler-only cache scope.
- **Payment method and billing days** are still owed by the owner (PLAN context). With a payment method on file,
  overspend past the credit bills instead of being refused, and the headroom is only a buffer.
- `me`'s cost units and grouping follow from the same endpoint but were not observed (no spend yet).
- Owner check (2026-11-01, from the mini): the `iu` and `me` API keys answer `count_tokens` 200 direct, and both admin
  keys answer `cost_report` 200; `me2` is still a placeholder. Through the proxy `count_tokens` stays unexercised.
- Not exercised: OpenCode child sessions (source only), tool-use responses, `count_tokens`, mid-stream upstream errors
  and client disconnects through the proxy.
