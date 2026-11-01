# Lead handoff — Wave 1 (Gateway spike and registry): CLOSE-OUT

Lead `agent-workflows-w1-r3` (pane t3t), 2026-11-01 ~18:20 → ~19:40 local. Briefs on the mini (not in git):
`~/.local/state/agent-workflows/briefs/gw1/`. Verdicts and evidence: `docs/spikes/gateway/REPORT.md`.

## Live state

agent-workflows release `767f643` (host + audio), `make deploy` OK, `make verify` PASS (smoke
`01a19862-359e-…`, cap `01a19862-39c6-…`, audio `01a19862-3da8-…`). dotfiles master `4083638`, main checkout pulled.
Main checkout clean after this commit; every fan worktree reclaimed (`rd fan --clean`), workers closed.

## Per-step verdicts

| Step | Verdict | PR | Review |
|-|-|-|-|
| Passthrough spike | **PASS** all checks: hash equality, 1h cache read on the repeat (7,680 tokens), tee usage = raw usage, TTFT −12 ms vs 72 ms jitter. 28 Haiku calls on the iu key | #79 | Lead read the report and scanned the diff for ids, keys, usernames. No `/review`: spike code under `docs/spikes/**`, excluded from every tool, never deployed |
| Header probes | **Yes** for OpenCode (built-in `x-opencode-session-id`, `model.request` plugin for `x-agw-*`) and Hermes (`session_affinity_header`). Zero LLM calls | #78 | as above |
| Admin API probe | **Works** on both one-person orgs (iu, me). `analytics/cost` (beta) in cents, before credits, groups by key; no balance endpoint. Fresh-request lag 20–70 min (lead re-measured after the worker) | #80 | as above |
| Registry | `platform` blocks, `op://mini/claude-platform/*`, iu + me enabled, me2 disabled, `cycleDay` null = rolling 31-day meter | dotfiles #55 | `agw review` run `01a1983b-…`: 1 blocking (month-end reset for unknown cycleDay → rolling 31 days), fixed; headroom wording fixed. GitHub reported no checks; merged on the train's local `make check` (green) |
| `isBalanceFailure` | Anthropic's 400 "credit balance is too low to access the Anthropic API" is balance (400 and statusless); a 400 carrying `BALANCE_MARKER` too (survives the 300-char cut) | #77 | `agw review` run `01a1983a-…`: 1 blocking (truncation drops the phrase), fixed. `/code-review high`: anchored on the full sentence, a real `failedResponse` → fallback round-trip test, stale balance docs in http.ts + 3 READMEs fixed. Not taken: 503 branch (IU never relays the credit refusal), marker on 400 (same rule as 503). Train: make check 3111 pass, CI green |
| REPORT.md + gateway.md fixes | Six corrections applied to `docs/gateway.md` | `196677c` (direct) | doc-only |

## Gate evidence

- `make check` in the train after every rebase: green for #78, #80, #77 (3111 pass, 0 fail); CI green on #77 and #80.
- `make deploy` + `make verify` PASS at `767f643` (run ids above).
- Live proof of the changed code (balance.ts): a real Claude-Code-shaped Haiku request on the iu key drew Anthropic's
  400 `invalid_request_error` "Your credit balance is too low…" (refused, no spend); the deployed release's
  `isBalanceFailure` returns true with status and text-only, false for another 400.
- No route changed, so no per-route live call beyond `make verify`'s.

## Left behind

- `docs/concept.md:337` and `docs/factory-input.md:17` still say balance is "402/503" (the code review named them;
  `concept.md` needs a version note, so it is the mother's call).
- `docs/gateway.md` §Picking a pool step 0 (Claude-Code-shaped requests skip the credit pools) is a design addition from
  the spike; Wave 2 builds it.
- OpenCode host changes for attribution (plugin dir + `plugins` entry in `packages/opencode-host/src/config.ts`,
  `runId`/`stepId` in `metadata.agw`) are Wave 3 work, not done.
- Owner items: billing days (`cycleDay`) for iu/me/me2; whether any org has a payment method (with one, overspend bills
  instead of being refused); me2 keys after ~2026-11-02; Admin keys sit in the mini's shared secrets cache (review
  finding on #55, owner decision).
- `me`'s cost units/grouping unobserved (no spend yet); OpenCode child sessions source-only; tool-use responses,
  `count_tokens`, mid-stream errors and client disconnects through a proxy untested.

## Retro notes for the mother

- The Claude-Code-identity refusal was the spike's real find: a funded credit org answers with the drained-org text.
  It would have drain-marked a healthy pool in Wave 2. Spikes that probe the refusal paths pay off.
- `rd fan` ignores `RD_WAVE_MODEL`/`RD_WAVE_EFFORT` for factory spawns (role table decides); the brief's model class is
  advisory only.
- `rd say` to an idle-but-tracked worker is held until "its next prompt" and delivered fine; mid-wave owner changes
  (vault move) reached both workers that way.
- The factory re-woke the lead on every idle worker until each was closed; close a worker as soon as its PR is
  reviewed (`rd close`), and `hc kill` one whose worktree the train rebased (`rd close` calls it unpushed).
- The merge train is slow (~10 min per `make check`); one train per repo at a time, queue the next PR behind it.
- The Admin API worker's fresh-lag measure missed because the sibling spike's traffic was not yet visible; lag is
  20–70 min, not the documented 5 min. Sequence probes that depend on another worker's traffic.
