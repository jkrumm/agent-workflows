# @agent-workflows/opencode-host

The runtime's `AgentHost` port (`packages/runtime/src/types.ts`) on one OpenCode 2.0.32 server (concept §3, §8).
Every agent step is one session, in its agent's location directory, driven over the server's HTTP API. Inputs
for the design: `docs/spikes/opencode-wedge/REPORT.md` (the wedge and its fix), agent-gateway's measured v2 API
(`docs/opencode-v2.md` there), and the probes in §Measured below.

## Shape

```ts
const server = new OpenCodeServer() // stateDir ~/.local/state/agent-workflows, `opencode` on PATH
await server.start() // adopts a running server, else spawns one
const host = new OpenCodeHost({
  server,
  agents: [{ name: 'reviewer', agentsMd, skills: { 'diff/SKILL.md': skill }, route: 'review.angle' }],
  traceparent: (runId, stepId) => platform.telemetry.traceparent(runId, stepId),
})
const runtime = new Runtime({ connectionString, workflows, host, middleware })
// on shutdown: runtime.close(); host.close(); server.close() (the server keeps running for the next process)
```

A step picks the route with `options.route` (else the agent's `route`) and asks for JSON with
`options.output: 'json'`: `ctx.agent('review', { agent: 'reviewer', prompt, output: Verdict, options: { output: 'json' } })`.

| Call | Does |
|-|-|
| `open(spec)` | Compiles the agent's location (idempotent), warms it, creates a session there with the route's model (and effort as a variant), title `agw <runId>:<stepId>`, `metadata.agw` = key, agent, route, location hash. Returns the handle |
| `prompt(handle, text)` | Reads the session's messages and inbox; sends only when the prompt is not there. The prompt carries a deterministic id (`msg_agwp_<sha256(session)>`) and `metadata.agw.kind = 'prompt'`, so the check is exact, and the server dedupes a second post of the same id as well |
| `wait(handle, opts)` | Polls the session (`pollIntervalMs`, 1 s): `onProgress` on every new or grown message or part, and while a running shell tool prints; `onTool` `pre` when a tool part first appears, `post` when it completes or fails. Returns at the session's `idle` with the final assistant text (or its JSON) and `usage` |
| `steer(handle, text)` | Appends a user message with `delivery: steer` (id keyed by the text, so a re-delivered steer is a no-op). History is never rewritten |
| `abort(handle)` | `POST /interrupt`. Idempotent: an idle session answers `interrupted: false`, a gone one 404, both fine |

The handle is plain JSON: `{ v, sessionId, directory, agent, route, model, output, runId, stepId, priced }`.

## Server supervisor

`OpenCodeServer` runs `opencode serve --hostname 127.0.0.1 --port <port>` with cwd and every state root under
`<stateDir>/opencode/` (`data`, `config`, `state`, `cache`, `home`, `opencode.db`, `server.log`, and
`server.json` with the port and password, mode 0600).

- **Env is an allow-list** (`serverEnv`): `PATH`, `HOME`, `TMPDIR`, `LANG`, the `XDG_*` roots, `OPENCODE_DB`,
  `OPENCODE_TEST_HOME` (OpenCode's own home, so no `~/.claude` or `~/.agents` file reaches an agent; `HOME` stays
  the user's because the `opencode` shim resolves the pinned build through it), `OPENCODE_DISABLE_FILEWATCHER=1`,
  `OPENCODE_DISABLE_CLAUDE_CODE=1`, `OPENCODE_DISABLE_MODELS_FETCH=1`, `OPENCODE_DISABLE_AUTOUPDATE=1`, the server
  password, the generated config, `IU_KEY` / `IU_ANTHROPIC_BASE` / `IU_OPENAI_BASE` (from `IU_API_KEY` and
  `IU_BASE_URL`), and `OTEL_EXPORTER_OTLP_*` when set. Nothing else (tokens, `CLAUDE_*`, database URLs).
- **Config** (`buildServerConfig`): two IU providers (`iu-anthropic`, `iu-chat`) with a model row for every
  `opencode`-wire route, priced from the route table; `question` and `external_directory` denied, so an unattended
  session never blocks on an `ask`. Model ids come only from `@agent-workflows/routes`.
- **Detached.** The server is its own process group. A host restart (deploy) leaves it and its running sessions
  alone; the next `start()` adopts it from `server.json` after an authenticated `GET /api/info` with the pinned
  version (`OPENCODE_VERSION`, `2.0.32`; another version is refused).
- **Liveness:** `GET /api/info` with a 2 s guard every `livenessIntervalMs` (5 s). `failuresBeforeRestart` (3)
  misses in a row, or the child's exit: SIGTERM, `termGraceMs` (5 s), SIGKILL, a new server on the same port and
  data dir. Every restart resets the warm cache. `ready()` blocks callers while a restart is in flight.
- **No cap.** Nothing in the host counts turns or wall time. The runtime's idle timeout, fed by `onProgress`,
  is the only stop for a session (`rules/agent-limits.md`).

## Locations

`compileLocation(def)` writes `<stateDir>/locations/<name>/`: `AGENTS.md`, skills under `.opencode/skills/<path>`,
`def.config` as `opencode.json`, and `.agw-location.json` with the content hash. Unchanged hash, no write; a
change builds the new directory beside the old one and renames it over. It throws `LocationLeakError` when any
ancestor holds an `AGENTS.md`, a `CLAUDE.md` or a `.git`. `locationHash(def)` is the fingerprint input.

**Warm and evict** (`WarmCache`): the first use of a location boots it (`GET /api/location`), later ones reuse it.
Every `locations.tickMs` (60 s) idle locations older than `evictAfterMs` (10 min) are disposed with
`DELETE /api/debug/location?location[directory]=…`, and at most `maxWarm` (16) stay warm, least recently used
first. A location some `wait` uses is never evicted. A changed location is marked stale and disposed once idle,
because OpenCode reads `AGENTS.md` and skills when it boots a location (§Measured).

## Re-attach

`wait` decides from the session, not from the process that started it:

| State | Seen as | Does |
|-|-|-|
| running | in `GET /api/session/active`, or input in the inbox | poll on |
| done | the newest message is an `idle` after the host's last input | return (`succeeded`), throw (`failed`, `interrupted`) |
| cut off | neither, for `cutoffGraceMs` (3 s) | append one synthetic note ("the turn was cut off, continue"), id keyed by the last message, so it is sent once per cut-off point |
| unprompted | no prompt in messages or inbox | throw: wait before prompt |

A connection refused, a timeout or a 5xx is transient: the wait keeps polling and reports no progress, so a server
that never comes back ends by the idle timeout. A 404 for the session or another 4xx fails the step.

**Why a synthetic note, not the prompt again.** After a SIGKILL mid-turn the store holds the user message and an
empty assistant message, no `idle`, and nothing resumes by itself. Re-posting the prompt id with `resume: true` is
deduped and schedules a run that idles at once with no reply (measured), so the step would end with empty output.
A synthetic message appends to history, is not a user prompt, and the model finishes the task. The step's prompt is
sent exactly once.

## DeepSeek wire rules (concept §8)

| Rule | Who | Evidence |
|-|-|-|
| Reasoning passed back verbatim | OpenCode, on the Anthropic route | assistant messages store `reasoning` parts with the provider `state.signature` (probe, 2.0.32) and replay them from the store. Not verified for DeepSeek's `reasoning_content` on the chat route: no `opencode`-wire route uses DeepSeek today; verify before adding one |
| History never edited | the host | the host only appends (prompt, steer, synthetic resume); it never calls revert, fork, compact, `PATCH` or delete. OpenCode's own compaction can still summarise a long session: it is OpenCode's, not triggered by the host |
| System and tool changes appended, not a rewritten head | the host | the head is the location (`AGENTS.md`, skills, `opencode.json`). A location in use is never evicted, so a running session keeps its head; a change applies to the next session. A re-attach appends a synthetic note instead of a system change |
| Cache-read tokens recorded | both | OpenCode reports `tokens.cache.read` and `.write` per assistant message; `usageFromOpenCodeMessages` carries them into `Usage` (live run: 7 593 of 7 967 input tokens were cache reads) |

## Usage and cost

`usage` is `usageFromOpenCodeMessages` over the whole session with the route's model. OpenCode prices each message
with the config's cost rows, which come from the route table: the route's own `rate`, else the rate another route
carries for the same model (today the `opencode` routes carry none and the Haiku single-call routes do). The step is
reported unpriced (`cost: null`, `costSource: 'unknown'`) instead of OpenCode's fake 0 when the table has no rate,
when cache tokens appear without the matching cache rate, or when one call exceeds 100K prompt tokens (the vendor's
higher tier, as in `costFromUsage`).

## Failure modes

| What | Then |
|-|-|
| Server wedged (no `/api/info` answer) | killed after 3 missed probes, restarted on the same port; waits re-attach |
| Server crashed | restarted on its exit event; waits re-attach |
| Host process restarted (deploy) | the server keeps running; the next host adopts it, the runtime re-attaches by handle |
| A turn hangs inside OpenCode (model call stuck, no new message) | no progress, the runtime's idle timeout fails the step and calls `abort` |
| Session lost (store reset) | `wait` fails: `opencode session … is gone` |
| `ask` permission | prevented: `question` and `external_directory` are denied server-wide; an agent's own rules must not use `ask` |
| Location under a repo | `LocationLeakError` at open |
| OpenCode version changed | adoption and boot refuse it; bump `OPENCODE_VERSION` after re-running the live test |

## Token effect / cache effect

- **No tokens of its own** in a normal step: the prompt is sent once, the title is set at create (no background
  title call), the location head is stable for the whole session.
- **A re-attach after a mid-turn kill** costs one short synthetic note plus a new assistant turn. The provider
  prompt cache stays warm because the head and history are unchanged (live run: 95 % of the resumed turn's input
  was cache reads). What the cut-off turn had generated is lost (an empty message in the store) and is paid again.
- **A changed agent** (`AGENTS.md`, skill, config) changes the head: its next session starts with a cold cache, once.
  The fingerprint changes with it.
- **A server restart** without a running turn costs nothing: the session is read, not resumed.

## Measured (2.0.32, 2026-10-28)

| Question | Result |
|-|-|
| Auth | `GET /api/info` needs Basic auth on 2.0.32 (401 without), so the liveness probe proves the password too |
| Client ids | `POST /api/session` and `/prompt` take a client `id` (`ses…`, `msg_…`); a second post of the same id returns the first admission and adds nothing. Pagination by cursor works with such ids |
| Order | messages are listed by time, not by id |
| Inbox | `POST /prompt` with `resume: false` admits into `GET /api/session/:id/inbox` without running; it is not in the messages until it runs |
| SIGKILL mid-turn | user message and an empty assistant message survive; no `idle`; not in `/active`; nothing resumes by itself. A re-posted prompt id with `resume: true` idles at once with no reply; `POST /synthetic` resumes and the model finishes |
| Evict | `DELETE /api/debug/location?location[directory]=…` → 204, gone from `GET /api/debug/location`; the next use re-reads `AGENTS.md` (an `AGENTS.md` written after the boot was not seen until the eviction) |
| Skills | loaded at the first prompt from the location's `.opencode/skills/` with `OPENCODE_DISABLE_CLAUDE_CODE=1` (live run: the model named the location's skill) |
| `OPENCODE_TEST_HOME` | overrides OpenCode's home (`Global.Path.home`, from the 2.0.32 binary); `HOME` itself is untouched |
| Project | a location outside any repo is its own project (`GET /api/location` → `project.directory` = the location) |

## Tests

`bun test packages/opencode-host`: a fake OpenCode server (`test/fake-opencode.ts`) with the measured behaviour
(persisted store, dedupe by id, no self-resume, an empty idle on a re-posted id), in-process for the host and as a
spawned `opencode` stand-in (`test/fake-opencode-bin.ts`) for the supervisor.

| File | Covers |
|-|-|
| `host.test.ts` | a turn's output and usage; prompt idempotency (twice, and across a restart); JSON output; a failed turn; unpriced routes; a wait surviving a kill and restart with one resume and no second prompt; a finished session read, not resumed; steer and its dedupe; abort twice; tool events; shell output as progress; warm and evict |
| `server.test.ts` | the env allow-list and the file-watcher flag; a wedged server SIGTERMed, SIGKILLed and restarted on the same port; a crash restarted; adoption by the next process; a version mismatch refused; a wait in flight across a liveness kill; the config |
| `locations.test.ts` | compile, idempotence, the hash, ancestor leaks, path escapes, the warm cache's eviction rules |
| `live.test.ts` | `AGW_LIVE=1`: the real binary, SIGKILL mid-turn, restart, re-attach, one prompt; AGENTS.md and a skill reach the model; tokens and cost |

Live: `AGW_LIVE=1 secrets-run run --env-file=.env.tpl -- timeout 600 bun test packages/opencode-host`
(about $0.0005).
