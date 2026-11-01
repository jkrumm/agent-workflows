# Spike: byte-exact passthrough on the iu credit org

**Verdict: the design holds.** Byte-exact passthrough with a usage tee costs no measurable TTFT, keeps the prompt cache
intact (1h TTL, streamed and non-streamed) and passes errors and rate-limit headers through unchanged. Two things in
`docs/gateway.md` need correcting before Wave 2: a credit org refuses Claude-Code-shaped requests with the *same* error
text as a drained org, and the key's 1Password ref moved. Both are under "Contradictions" below.

Run on 2026-11-01, Haiku only (`claude-haiku-5-5`, confirmed by `GET /v1/models` on the iu key), 28 of the 40 allowed
upstream calls. Code and results: `docs/spikes/gateway/passthrough/`.

## Checks

| # | Check | Result | Numbers |
|-|-|-|-|
| 1 | inbound sha256 == upstream sha256 | **PASS** | 4/4 calls (2 streamed, 2 not): client == proxy inbound == proxy sent, 22,214 and 22,216 bytes. Wire-level proof against a local fake upstream (`selftest.ts`): the hash the upstream receives is the same |
| 2 | second identical call reads the cache | **PASS** | non-streamed: call 1 wrote 7,680 tokens (all `ephemeral_1h`), call 2 read 7,680 and wrote 0. Streamed: 7,681 written, 7,681 read |
| 3 | tee usage == raw response usage | **PASS** | 4/4 calls equal on `input_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, `output_tokens`, e.g. `{88, 0, 7681, 4}` |
| 4 | TTFT within noise | **PASS** | proxy − direct median −12 ms, noise 72 ms (table below) |
| – | malformed request passes through | **PASS** | both paths: `400`, `{"type":"error","error":{"type":"invalid_request_error","message":"messages: Field required"},"request_id":"req_<id>"}` |
| – | `anthropic-ratelimit-*` and `request-id` pass | **PASS** | all 12 `anthropic-ratelimit-*` headers (input, output, requests, tokens × limit/remaining/reset) and `request-id` present on the proxied response. The proxy response has one header fewer than direct: `connection`, a hop-by-hop header, dropped on purpose |

## TTFT

Streamed, N=5 per path after one discarded warm-up each, alternating order (direct/proxy, proxy/direct, …), same body,
cache warm on every sample (`cache_read_input_tokens` > 0). Milliseconds from `fetch()` to the first body byte.

| path | median | min–max | sd | samples |
|-|-|-|-|-|
| direct | 745 | 693–884 | 72 | 766, 884, 745, 693, 736 |
| proxy | 733 | 679–766 | 33 | 766, 745, 719, 733, 679 |

"No measurable cost" rule, fixed before the run: |proxy − direct| median ≤ the larger sd. Result −12 ms against 72 ms.
The proxy is a loopback hop in a separate process; its cost sits below the network jitter of the upstream.

The first content delta arrives with the first byte (median 745 / 733 ms, within 1 ms of the first-byte samples): for a
4-token answer the API flushes the response headers and the first events together, so time to first byte, headers and
first `content_block_delta` cannot be told apart here. A longer generation would separate the last from the first.

## Method

- `proxy.ts`: `Bun.serve` on 127.0.0.1, an ephemeral port, POST `/anthropic/v1/messages`. The request body is read once
  as an `ArrayBuffer` and that buffer goes to `fetch`. The key is read at start with `secrets-run read` and held in
  memory only. Every inbound header is forwarded unchanged except `authorization`, `x-api-key`, `host`, `content-length`
  (dropped) and the hop-by-hop headers (`connection`, `keep-alive`, `transfer-encoding`, …; see below);
  `x-api-key` is set to the iu key. It logs sha256 of the inbound body and of the buffer sent, and the forwarded header
  set (key redacted).
- The response is `new Response(teedBranch, {status, headers})`. The other branch is parsed: SSE `message_start`
  (input, cache-creation, cache-read tokens) and `message_delta` (output tokens); for a JSON body, `usage`. A body with a
  `content-encoding` is buffered and decoded for the parse only.
- `replay.ts` builds a Claude-Code-shaped request: three `system` blocks (request ~22 KB, ~7.7k cached tokens; the last block carries
  `cache_control: {type: "ephemeral", ttl: "1h"}`), three tools (`Bash`, `Read`, `Edit`), `metadata.user_id`,
  `anthropic-version: 2023-06-01`, `anthropic-beta: interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14,extended-cache-ttl-2025-04-11`,
  `max_tokens: 32`. The first system block and the `user-agent` are neutral, not Claude Code's (finding 3: the credit org
  refuses those). Every upstream call is bounded by `AbortSignal.timeout(60_000)`. A persisted counter refuses the 41st call.
  The client sends a dummy `x-api-key` and `Authorization` to the proxy; a 200 proves the swap.
- Each mode gets its own nonce in a system block, so call 1 writes the cache and call 2 reads it.
- The client parses the raw response itself, independently of the tee, and compares.
- `selftest.ts` (offline, free, runs first): the proxy against a local fake upstream checks the wire-level body hash, the
  key swap, that `authorization` never arrives, that SSE is not buffered (first chunk at 1 ms of a 600 ms stream), the
  tee parse, and gzip passthrough.
- Run: `cd docs/spikes/gateway/passthrough && timeout 600 bun run replay.ts`. Summary: `results/summary.txt`, `results/summary.json`.
  Raw proxy logs (with request ids) stay in `results/raw/`, which is gitignored.

## Findings that change the Wave 2 build

1. **Bun's `fetch` corrupts an encoded response unless told not to.** By default it decompresses the body but keeps
   `content-encoding: gzip`, so the caller gets plain bytes under a gzip header. Verified on a local server: default
   body starts `7b 22` (`{"`), with `{decompress: false}` it starts `1f 8b`. The proxy passes `decompress: false` and
   decodes only the tee copy. Anthropic does compress (`content-encoding: gzip` on the streamed responses on both paths
   here), so this is not hypothetical. Consequence: the tee of an encoded stream is decoded when the stream ends, so
   usage lands at the end of the stream (fine for the usage row); a span attribute that needs the first delta mid-stream
   would need a streaming `DecompressionStream`.
2. **Hop-by-hop headers are not forwarded.** The brief says all headers unchanged except four; `connection`,
   `keep-alive`, `transfer-encoding`, `te`, `trailer`, `upgrade` are per-hop by RFC 9110 and are dropped both ways.
3. **Credit orgs refuse Claude-Code-shaped requests.** Same body, same key, a 200 without these signals and a 400
   `"Your credit balance is too low to access the Anthropic API…"` with any of them:

   | Signal | Result on the iu org |
   |-|-|
   | `anthropic-beta` carrying `claude-code-20250219` | 400 |
   | first `system` block `You are Claude Code, Anthropic's official CLI for Claude.` | 400 |
   | `user-agent: claude-cli/2.1 (external, cli)` with `x-app: cli` (not separated) | 400 |
   | `oauth-2025-04-20` | not isolated; it was only sent together with `claude-code-20250219` (400) |
   | `interleaved-thinking-2025-05-14`, `fine-grained-tool-streaming-2025-05-14`, `extended-cache-ttl-2025-04-11` | 200 |

   This matches the credit terms (they never cover Claude Code), and the first run of this spike hit it by accident.
   The 1h TTL needs no beta header (GA since 2025-08-13); sending the old `extended-cache-ttl` value is accepted.
4. **Haiku 5.5's cache floor is 512 tokens**, not the ~4k of Haiku 4.5. The 7.7k-token prefix is far above it (~2.9
   characters per token with the new tokenizer, so a "~5k tokens" pad by the 4-chars rule lands higher).

## Contradictions with `docs/gateway.md`

- Line 22: *"With no payment method on file, a drained org refuses: "Your credit balance is too low…""*, and line 71:
  *"`isBalanceFailure` learns Anthropic's "credit balance is too low"; the pool is marked drained for the cycle"*.
  What is true: the same 400 and text also answer a *funded* org when the request looks like Claude Code (finding 3). A
  caller that sends a Claude Code `user-agent`, system prefix or beta through the gateway would drain-mark a healthy
  pool and fall back to IU. The classifier needs a second signal (the meter says the pool still has headroom → do not
  mark it drained, surface the 400), and the gateway should not rewrite these signals (byte-exact), so the answer is to
  keep Claude-Code-shaped callers off the credit path. Wave 1's OpenCode header probe must check which of these
  signals OpenCode's Anthropic provider sends.
- Line 54: `"apiKeyRef": "op://common/claude-platform/API_KEY_IU"` and the same ref in `docs/waves/PLAN.md` Wave 1. What is
  true on the mini today: that ref is not in the secrets cache (`ref not in cache`, a reseed dropped it); the item is
  `op://mini/claude-platform/API_KEY_IU` (`dotfiles-private/headless.refs`), same key length, same org (the spike's calls
  succeeded). The registry in `claude-accounts.json` and `make verify` must use the `mini` ref.
- Lines 39–42, *"Request bytes and headers … go upstream unchanged; only the auth header is swapped"*: true for the
  body and every end-to-end header; `content-length` is recomputed and hop-by-hop headers are dropped (finding 2).
  *"The response streams through unbuffered"* needs `decompress: false` (finding 1).

## Limits of this spike

- The hash equality on the real upstream is by construction (one buffer, hashed twice); the independent evidence that the
  bytes on the wire are unchanged is the local fake-upstream selftest, not Anthropic.
- N=5 per path from one location; the TTFT verdict is "no cost above jitter", not a latency bound.
- Not tested: tool-use responses, `count_tokens`, extended thinking, large responses, mid-stream upstream errors, client
  disconnect while the tee is running.
- The `AbortSignal.timeout(60_000)` on every call follows the brief for a spend-capped spike; `rules/agent-limits.md`
  asks for a ≥30 min hang guard on single LLM requests in product code, which the gateway should follow.
