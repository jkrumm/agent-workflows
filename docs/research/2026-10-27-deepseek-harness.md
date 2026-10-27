# DeepSeek Harness (`dsh`) — study for agent-workflows (2026-10-27)

Read from the repo at HEAD (shallow clone, files read only, nothing run). Paths are repo-relative.
Gathered without research-gateway (IU budget), so primary sources only, no cross-verification pass.

**Verdict:** a reference, not a runtime. Copy its event taxonomy, log discipline and DeepSeek wire
handling; keep OpenCode as the agent-step runtime.

## 1. Facts

| Fact | Value |
|-|-|
| Repo | https://github.com/deepseek-ai/deepseek-harness (org not GitHub-verified); homepage field https://deepseek.com/harness, not fetched |
| Created | 2026-08-13 (GitHub API); same day as the press-reported v0.1 developer preview |
| Version | tag `dsh-v0.2.1-rc.3` (2026-10-23); npm `@deepseek-ai/dsh` latest `0.2.1-rc.2`, next `0.2.1-rc.4`; all pre-release |
| Runtime | TypeScript, Node ≥ 24.9, pnpm; also Python SDK, Swift, C++, Electron desktop. **Not Bun-native** |
| License | MIT |
| Maturity | README: "THERE WILL BE COMPATIBILITY-BREAKING CHANGES"; `SAFETY.md`: unaudited, sandboxing not guaranteed |
| Base | Cordis plugin framework (https://github.com/cordiverse/cordis) — press claim, not verified; README cites arXiv 2608.25512 (unread) |
| Not to confuse | DeepSeek-TUI (https://github.com/Hmbown/DeepSeek-TUI) is an unrelated community Rust agent |
| Announcement | none found; the V4-Pro GA page (https://api-docs.deepseek.com/news/news260813) doesn't mention it, but confirms effort levels low/high/max and peak/off-peak pricing from 2026-08-16 |

## 2. Architecture

- **Plugins.** Cordis plugins contribute services, typed events and reversible effects. Model
  adapter, tool registry, session log and agent loop are all plugins (`docs/architecture.md`). A
  profile is an ordered stack of bundles plus a `cordis.patch.yml` that replaces rows by id;
  profiles `web`, `headless`, `sdk`, `sdk-minimal`, `acp`.
- **Session log.** Append-only `SessionEvent` JSONL, format v4, with `vN→vN+1` migrations
  (`packages/core/session/src/types.ts`). Events: `turn/*`, `step/*`, `user/message`,
  `assistant/message` (embeds timed stream + `usage`), `assistant/attempt` (failed/cancelled kept),
  `tool/call`, `tool/result`, `request/header`, `request/context`. Principle: **"Model-visible means
  logged"** — every request is reconstructable. Compaction is a logged `replace` op; fork, resume and
  the projection cache derive from the log.
- **Tool pipeline** (`docs/tool-execution-pipeline.md`): `tool/call` logged before execution →
  `tools/pre-execute` waterfall (hooks, permission, sandbox) → guards → approval → `tools/execute`
  (timeout, retry, metrics) → `tools/post-execute` → `finalizeContent` → `tool/result`.
- **Code mode.** `run_code` exposes the other tools as a generated SDK inside a sandboxed Node VM
  (`packages/core/tool-executor-ptc`).
- **Skills.** `SKILL.md` bundles in ranked roots (`.dsh/skills`, `.agents/skills`, user, bundled). The
  catalog (name + description) is injected as a user-role message and **diffed by digest**, so it
  doesn't churn the cached prefix (`docs/subsystems/skills.md`).
- **Workflow primitive** (`packages/workflow/workflow/README.md`): a model-written JS script in the
  sandbox with `agent(prompt, {schema})`, `parallel()`, `pipeline()`, `phase()`, `log()`;
  observe-only `workflow/*` events; failures are `fatal` unless a child run fails (→ `null`). Its
  README states the limits: **no journaling or resume, no saved or nested workflows, no token-budget
  accounting, foreground only.** `ralph` is a fresh-agent loop on the same engine.
- **Goals and subagents.** `dsh-goal` keeps a durable objective across turns (256-round cap);
  subagents can take an `outputSchema`.
- **Headless.** `dsh --profile headless "task"`, `--json` NDJSON events, `--session-id` resume,
  `--permission-mode`, `--approval-policy never|ask`; documented worktree-per-task supervision.
- **Server.** `dsh --profile sdk` is newline-delimited JSON-RPC 2.0 over **stdio**
  (`packages/sdk/protocol/README.md`): `initialize`, `session/prompt`, `session/resume`,
  `session/wait`, `shutdown`; notifications `session.event`, `session.status`, `subagent.*`;
  server→client `approval/request`, `user-question/ask`. No documented HTTP API.
- **Cost and telemetry.** `TokenUsage` has input, output, cache read/write, reasoning tokens; **no
  money model**. `ctx.otel` is a log channel, not run spans. `session-stats` has turn/step counts and
  LLM, tool, first-token and decode wall times. No scorer or eval framework.

## 3. Worth copying

- **Typed interception points** (`agent/pre-step`, `tools/pre-execute`, `tools/post-execute`;
  `docs/event-producer-consumer.md`) — a ready taxonomy for our middleware.
- **Resume as a cursor over a canonical log** — `delivery-accepted` watermark, at-least-once, no gaps.
- **"Model Experience" section per package README** with "KV cache effect" and "Token effect" — a
  cheap review checklist for cost regressions.
- **Repeat-tool reminder** (`packages/guard/repeat-tool-reminder`): nudges at 3, 5 and 8 identical
  calls — maps onto our friction signals.
- **Digest-diffed skill catalog** to keep the prefix cached.
- **Fatal vs null** failure split; **schema-validated `agent()` output**; a hard cap on children per run.
- **Supervision rule:** success needs exit 0 **and** `final.reason.kind === 'completed'`.

**Against using it as the runtime:** Node 24 only, pre-1.0 with admitted breaking changes; stdio
JSON-RPC, one process per profile, no multi-tenant HTTP server; tools via plugins or code mode, not a
CLI; its workflow engine has no journal, resume or budget; session-log upload on by default (§5).
**For:** log fidelity and reasoning passback are better documented than OpenCode's — useful as a
side-by-side bench.

## 4. DeepSeek tuning for our cheap routes

Source: `packages/llm/llm-deepseek/README.md`, `docs/deepseek-llm-api-wire-extensions.md`.

- Anthropic-compatible endpoint; effort in `output_config.effort` = off | low | high | max (default
  high); off = `thinking.type: disabled`; `temperature` ignored while thinking.
- **Reasoning passback:** prior-turn reasoning sent back verbatim, signatures preserved.
- Malformed historical tool arguments replayed as `{}`; empty assistant blocks dropped.
- **Cache discipline:** system-prompt updates appended in-history; mid-conversation tool changes as
  `tool_addition` / `tool_removal` with `defer_loading` (beta header
  `mid-conversation-tool-changes-2026-07-01`); cache hits → `cacheReadTokens`.
- Defaults: 1,048,576-token window, 256k max output, 5-min stream idle timeout, 5 retries.
- The persona is one line; tuning is at the wire and cache level, not prompt prose.

**Actionable:** preserve reasoning and signatures across turns, never edit history, append system
and tool changes instead of rewriting the head, track cache-read tokens per run.

## 5. Gaps and a privacy flag

- **Privacy:** the base bundle enables `dsh_session_log` by default — every request to
  `deepseek-official` carries the unredacted session-log suffix (up to 8 MiB: prompts, tool args and
  results, cwd), and a custom `baseURL` gateway receives it too. Disable row `session-log-deepseek`.
  `dsh_plugin_packages` is also on by default.
- **Unverified:** docs site (returned nothing), the arXiv paper, any official announcement, the
  project lead, press "four presets", real-world performance, whether `deepseek-flash` = V4.1 Flash,
  `session.event` scaling, what `BENCHMARK.md` measures. GitHub star counts (263k) conflict with every
  press figure — ignore them.
