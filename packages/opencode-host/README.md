# @agent-workflows/opencode-host

The runtime's `AgentHost` port (`packages/runtime/src/types.ts`) on one OpenCode 2.0.32 server (concept §3, §8).
Every agent step attempt is one session, in its agent's location directory, driven over the server's HTTP API.
Inputs for the design: `docs/spikes/opencode-wedge/REPORT.md` (the wedge and its fix), agent-gateway's measured v2
API (`docs/opencode-v2.md` there), and the probes in §Measured below.

## Shape

```ts
const server = new OpenCodeServer() // stateDir ~/.local/state/agent-workflows, the real `opencode` build
await server.start() // adopts a running server with the same env and config, else spawns one
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
A JSON step answers through its result tool, never in text (§Structured output).

| Call | Does |
|-|-|
| `open(spec)` | Compiles the agent's location (idempotent), warms it, creates the session with the route's model (effort as a variant), the agent's permissions, title `agw <runId>:<stepId>` and `metadata.agw` (key, agent, route, location hash, the step's attribution: §Attribution). The session id is derived from `spec.key` (`ses_agw<sha256(key, generation)>`): a re-open after a crash between create and journal finds the same unprompted session; a retry whose earlier session still runs (or holds input) re-attaches to it, because its wait failed while the turn went on and a sibling session would run the same task on the same files; only a retry after a turn that ended gets the next generation. The directory the session lives in (an older hash directory on a re-attach) is pinned from `open` until its `wait` takes the use over (a pin nobody claims lapses after 30 min), and its marker is renewed |
| `prompt(handle, text)` | Reads the session's messages and inbox; sends only when the prompt is not there. The prompt carries a deterministic id (`msg_agwp_…`) and `metadata.agw.kind = 'prompt'`, so the check is exact, and the server dedupes a second post of the same id as well |
| `wait(handle, opts)` | Polls the session (`pollIntervalMs`, 1 s): `onProgress` on every new or grown message or part, and while a running shell tool prints; `onTool` `pre` when a tool part first appears, `post` when it completes or fails (recorded per `wait` call: a second wait reports again, at least once). Returns at the session's `idle` with the final assistant text, or a JSON step's result-tool input (§Structured output), and `usage` |
| `steer(handle, text, { signalId })` | Appends a user message with `delivery: steer`, id keyed by the runtime's signal row: a re-delivered row is a no-op, two identical steers stay two. Without a `signalId`, a nonce per call (never the text alone). History is never rewritten |
| `abort(handle)` | `POST /interrupt`. Idempotent: an idle session answers `interrupted: false`, a gone one 404, both fine |

The handle is plain JSON: `{ v, sessionId, directory, agent, route, model, output, runId, stepId, attribution }`, and
on a JSON step `result: { digest, wrapped? }` (§Structured output).

**Permissions: deny by default** (as agent-gateway's `OPENCODE_READONLY_PERMISSIONS`). Every session gets, in this
order, the last match winning: `{ *, *, deny }`; `allow` for exactly `read`, `glob`, `grep` and `skill`;
`{ shell, *, allow }` only when the agent has `permissions.shell: true`; the agent's own `permissions.rules`; one
`external_directory` allow per entry of the step's `spec.options.allowDirectories`. Anything else is refused, an action
that ships in a later OpenCode too. An opt-in is an `allow` rule in the agent's `agent.json`, which comes after the
host's deny and wins: `{ "action": "webfetch" | "websearch" | "subagent" | "edit" | "execute", "resource": "*",
"effect": "allow" }`. `spec.options` is strict: a key other than `route`, `output` and `allowDirectories` (a typo, a
removed option such as `repoShell`) fails the step before a session exists, so a rule a caller counts on is never
silently absent. Server-wide the same `basePolicy` (catch-all deny, then the four read-only allows) is the backstop,
followed by `question` and `external_directory` denied, so an unattended session never blocks on an `ask` and a session
made without rules, or by anything but the host, is not allow-all. **A session from before a deploy.** A session keeps the rules it was created with, and `createSession` with an existing id
returns that session unchanged (measured). So the host reads the stored rules and, only when they differ from the
current policy, patches the current ones on with `PATCH /api/session/{id}`: in `open` for a session it found already
there (a retry re-attaching to an attempt, a crash between create and prompt), for a fallback session it opens, and in
`followUp` (`ctx.continue`) for the session, or the fallback session, it continues. A session created with the current
policy, or one re-attached within one release, is read once and never written. A failed patch fails the call (the
warm-location pin is released) rather than proceeding on the old rules. The patch is measured **between turns** only:
one onto a session mid-turn (a re-attach to a running attempt of an older release) is unmeasured. What covers those
sessions is the server backstop above: a deploy restarts the server with `basePolicy` in its config, so every session
that predates the deploy runs under the catch-all deny at once, whether or not it was patched. A `wait` on a follow-up
handle persisted before a deploy does not patch; it relies on the same backstop.

A subagent runs under its own permissions (OpenCode's built-in `general` allows shell and edit),
which is why `subagent` is off unless an agent opts in; so is `execute` (Code Mode).

**Measured on 2.0.32** (`test/live-permissions.test.ts`, `AGW_LIVE=1`, the cheapest route, under $0.01 for the file):

| Finding | Result |
|-|-|
| Tools a session has | `read`, `glob`, `grep`, `skill` (the allowed set). There is no `list` and no `todowrite` tool, so neither is allowed |
| Action names | the tool name, except `edit` covers both the `edit` and the `write` tool. Denying `read`, or `glob`, `grep` and `skill`, removes exactly that tool, so none of the four is allowed by another's rule |
| A denied tool | is **not in the model's tool list at all** (the model answers "no webfetch tool is available"); a call to it anyway ends `No tool named "…" is currently available` and the turn goes on. `webfetch`, `websearch`, `subagent`, `edit`, `write`, `shell` and `execute` were each refused this way; no file was written |
| Opt-in | `edit` adds `edit` and `write`; `websearch`, `subagent`, `execute` and `shell` add the tool of their name. An agent with only `webfetch: allow` completed a `webfetch`, and its `websearch` was still refused |
| Server backstop | session rules win over the server's catch-all deny: with `basePolicy` in the server config, an agent with `webfetch: allow` still completed a `webfetch`, and the `edit`, `websearch`, `subagent`, `execute` and `shell` opt-ins still added their tools (`test/live-permissions.test.ts`, run with the backstop in place) |
| `PATCH /api/session/{id}` | `{ permissions }` **replaces** the session's rules (read back with `GET`: equal to what was sent, nothing appended) and the next turn uses them: widened with `webfetch` + `shell`, the tool list gained both; narrowed again, it lost both |
| Code Mode (`execute`) | its catalog holds MCP, browser and OpenCode session/worktree tools, never the built-in ones: with everything allowed (`* allow`) a `read` from `execute` is not found either. Under this policy, even with `execute` opted in, the catalog is empty ("No Code Mode tools are available") and nothing denied is reachable. Same result as agent-gateway's on 2.0.25. MCP servers: none configured; one would be refused by the catch-all until an agent allows it |

`allowDirectories: string[]` is how a step lets its agent read a repository the agent's own location is not in
(review angles, check). Each entry must be an absolute directory without wildcards or `..` (never `/`); anything else
fails the step before a session exists. It appends `{ external_directory, <dir>/*, allow }`. The option opens
`external_directory` only: it grants no edit, which the catch-all refuses unless the agent opts in. Measured on 2.0.32 (`test/live.test.ts`, "allowDirectories"): the pattern matches
the path as the agent gives it, so hand the agent the same string you allowed (a symlink-resolved spelling such as
`/private/var/…` for `/var/…` is a different path and is refused); `<dir>` alone matches nothing.


**Symlinks inside an allowed directory are an escape** (measured on 2.0.32, `test/live.test.ts`, "symlink inside an
allowed directory"): the grant is matched against the path the agent names, not where a link leads, so `repo/link -> ~`
is read, globbed and grepped like any file below `repo`, and its content reaches the session. The host cannot close this.
Callers must: a throwaway clone (the review's `pr`/`branch` mode) has every symlink whose realpath leaves the clone deleted
right after checkout; the caller's own live checkout (review of `uncommitted`, `check`) is never edited, so **a symlink in
a work tree the caller hands an agent is an accepted risk**, the same trust as the rest of this section (one server, one
key, a shell-capable agent reads what the user can): the repo is the owner's, and a read-only reader cannot write the link.

## Structured output

**Probe (2.0.32, 2026-11-02).** The binary carries `SessionV1.OutputFormat` (`{ type: "json_schema", schema,
retryCount }`), `StructuredOutputError` and a `structured` field on the assistant message, but only in the v1 data model:
the server serves no v1 route, and the v2 `POST /api/session/{id}/prompt` the host uses takes `id`, `text`, `files`,
`agents`, `skills`, `metadata`, `delivery`, `resume` only. A prompt sent with `format` and `outputFormat` was answered
200 and both were dropped: the stored user message had neither and the assistant message no `structured`.
`/api/session/{id}/generate` returns text only. The "Root JSON Schema must have type object and must not use anyOf"
string belongs to Effect's `OpenAiStructuredOutput`, not to anything the host can reach. What does work: a plugin
tool's `input` may be a plain JSON Schema object. OpenCode offers it to the model as the tool's input schema as it is,
validates every call against it, and ends an invalid call as a tool part `status: error` with `Invalid arguments for
tool "…": - <path>: Expected <type> … Update the arguments and call the tool again.`; the model retries in the same
turn. A valid call ends `completed` with `state.input` the arguments. A tool without an `output` schema must return
no `output` key (`Tool result declared output without an output schema`), and `execute` must return a promise.

**How a JSON step answers.** The runtime hands the step's schema to `open` as `spec.schema`
(`z.toJSONSchema(output, { io: 'input', unrepresentable: 'any' })`: what the agent produces before transforms; a
part JSON Schema cannot express is left open, and the zod parse after `wait` stays the last check); a conversion that
still throws (two schemas sharing a `meta` id) arrives as `spec.schemaError`, its reason. `open` of an
`output: 'json'` step compiles the agent's location with two additions, so a schema is its own hash directory:
`.opencode/plugins/agw-result.js` (`src/result.ts`, plain JS with the schema inlined: one tool, `submit_result`, input =
the schema without `$schema`, `codemode: false`) and a `## Result` section in `AGENTS.md`, the one place that names the
tool (an agent's own `AGENTS.md` describes the shape and says to submit it). The session's permissions allow
`submit_result` (`sessionPermissions(def, { allowDirectories, resultTool: true })`; a follow-up turn and a balance
fallback session keep the rule). The handle carries `result: { digest }`, the sha256 (16 hex) of the tool's schema.
`wait` returns the input of the answer's last completed `submit_result` call, read in the same window as a text answer
(a nudge turn after the turn ended is not the answer); a rejected call does not count. A turn that ends without one
fails the step `invalid_output`, the message carrying up to 4,000 characters of its last text: the text is never
parsed as JSON, and the workflows' one retry re-asks (the review synthesis keeps that text in its salvaged verdict).

**Schemas.** A root that is an object (no `anyOf`, `oneOf`, `allOf`, `not`, `if`, `enum`, `const` at the top) is
offered as it is. Any other root (an array, a string, a union) is wrapped as `{ result: <schema> }` (its `$defs` and
`definitions` moved up) and unwrapped by `wait` (`result.wrapped`); a call without the `result` key fails
`invalid_output`. Refused at `open`, before a session exists, naming the agent and why: no schema (with the conversion's
reason when there is one), a schema that is not an object, a non-object root with a local `$ref` other than
`#/$defs/…` or `#/definitions/…` (`#`, `#/items/…`: it would not resolve once wrapped). The review angles', the review
synthesis's, `check`'s and `retrospective`'s schemas are object roots and convert as they are.

**Follow-up turns** (`ctx.continue`) run in the same session and location, so they answer through the same tool. The
runtime hands `followUp` the continuing step's schema too, and on a JSON session it must give the same tool schema
(same digest); a text output or another shape is refused before anything is sent. A text session's follow-up is not
checked: it answers in text whatever the step's output.

**A JSON handle without `result`** was opened by a release before the result tool: its session has no `submit_result`
and can never answer. `wait` and `followUp` fail it at once with an error that says so; the step's next attempt opens a
new session.

**Usage.** A turn without a result throws, like every host-side failure, so the step's run row does not carry that
turn's tokens; the gateway's usage rows do.

## Server supervisor

`OpenCodeServer` runs `<opencode> serve --hostname 127.0.0.1 --port <port>` with cwd and every state root under
`<stateDir>/opencode/` (`data`, `config`, `state`, `cache`, `home`, `opencode.db`, `server.log`, and
`server.json` with port, password, the launch fingerprint and the spawned child's pid, written atomically at mode 0600).

- **The real binary by absolute path** (`resolveOpencodeBinary`): `AGW_OPENCODE_BIN`, else `opencode` on PATH,
  followed through the machine's shim (`bin="$HOME/…"`) to the pinned build. So the server needs no user `HOME`.
- **Env is an allow-list** (`serverEnv`): `PATH`, `TMPDIR`, `LANG`, `HOME` = `<root>/home` (the server's own), the
  `XDG_*` roots, `OPENCODE_DB`, `OPENCODE_DISABLE_FILEWATCHER=1`, `OPENCODE_DISABLE_CLAUDE_CODE=1`,
  `OPENCODE_DISABLE_MODELS_FETCH=1`, `OPENCODE_DISABLE_AUTOUPDATE=1`, the server password, the generated config,
  `AGW_GATEWAY_URL` and `AGW_GATEWAY_TOOL_TOKEN` (`gatewayFromEnv`, both required, the start fails naming the variable; on the
  mini `.env.tpl` sets the URL and `scripts/launch.sh` reads the token from the `agw-opencode` line of `data/door-tokens`), and
  `OTEL_EXPORTER_OTLP_*` when set. Nothing else: no provider key, no `AGW_API_SECRET`, no `CLAUDE_*`, no database URL.
- **Config** (`buildServerConfig`, built once per server spawn from the route table): three providers with a model row
  for every `opencode`-wire route and its fallback, each row carrying exactly the efforts the model's provider takes
  (`effortsOf` in `@agent-workflows/routes`: a Sonnet no `none`, DeepSeek `none`/`low`/`high`/`max`), so a step whose run's arm moves its route to another of these models or effort opens on the
  running server without a restart (`open` resolves the route with `AgentOpenSpec.arm`, and the handle keeps the
  route's patch for the fallback and the pricing). An arm naming a model outside the config is refused at admission
  (`validateArm`), never served by a silent fallback to the table. Cost rows come from the rate of the first route naming
  the model (the table names one rate per model), all on the inference gateway (`docs/gateway.md`) with the door token of the caller
  `agw-opencode`. The key in the config is the reference `{env:AGW_GATEWAY_TOOL_TOKEN}`; the token opens the gateway only,
  never the API, and it is the only credential in the server's env and its tool shells. `anthropic` (`@ai-sdk/anthropic`,
  `<AGW_GATEWAY_URL>/anthropic/v1`) serves the `claude-` models, which the gateway pays from a credit pool or IU; its
  variants set `effort` plus adaptive `thinking` (effort `none`: thinking disabled), since the Anthropic protocol ignores
  `reasoningEffort`. It sends a static `x-agw-fallback: none`, so credit that runs out becomes a 402 and the route's own
  fallback, never Claude on IU. `iu-chat` (`@ai-sdk/openai-compatible`) and `iu-responses` (`@ai-sdk/openai`) keep their
  ids on `<AGW_GATEWAY_URL>/openai/v1`. OpenAI's own models (`gpt-`) go on `iu-responses`: they call tools only over the
  Responses API. Model ids come only from `@agent-workflows/routes`.
- **Detached.** The server is its own process group. A host restart (deploy) leaves it and its running sessions
  alone; the next `start()` adopts it after an authenticated `GET /api/info` with the pinned version
  (`OPENCODE_VERSION`, `2.0.32`; another version is refused) **and** the same launch fingerprint (sha256 of command
  and env, config included). A drifted server (new routes, rates, key or binary) is restarted, logged.
- **Pid trust.** The only pid the supervisor signals or adopts is the child it spawned, recorded in `server.json`
  right after the spawn. A recorded child that is alive (its `ps` command line is `serve … --port <port>`) but does
  not answer is terminated before a new spawn. A boot counts only when `/api/info` answers with that child's pid while the child is alive; liveness
  checks the same. A server on the port whose pid is not the recorded one is neither adopted nor signalled: `start()`
  fails naming the file. An HTTP answer alone is never a reason to signal a process.
- **`server.json`** that does not parse fails `start()` with its path ("remove it to start a fresh server"),
  never a boot loop.
- **Liveness:** `GET /api/info` with a 2 s guard every `livenessIntervalMs` (5 s). `failuresBeforeRestart` (3)
  misses in a row, or the child's exit: SIGTERM, `termGraceMs` (5 s), SIGKILL, a new server on the same port and
  data dir. Every restart marks the warm cache cold. `ready()` blocks callers while a restart is in flight.
- **No cap.** Nothing in the host counts turns or wall time. The runtime's idle timeout, fed by `onProgress`,
  is the only stop for a session (`rules/agent-limits.md`).

### Threat model

**Measured (live, 2.0.32):** a non-shell agent asked to read `/etc/hosts` and `<stateDir>/opencode/server.json`,
glob `/etc`, grep the server's state directory and write a file under `$TMPDIR`: all five tool calls ended
`error`, each with `Permission denied: external_directory`; the file was not written and neither the password nor
the hosts file reached the session (`test/live.test.ts`, "cannot read, search or write outside its location").
So `external_directory: deny` (server config) confines `read`, `glob`, `grep` and `write`/`edit` to the location;
no extra path rules are needed.

### Accepted risk: one server, one door token, shell reach

**The `check` agent's boundary is its shell.** It runs with `permissions.shell: true`; the `edit` and `write` tools are
refused, but a shell can still write any file the user can (`echo > file`, `git checkout`, …). Nothing in the policy
confines it; the boundary is the agent's prompt and the throwaway tree it is pointed at.

One server and one door token serve every agent; the server's env holds no provider key, only the token of the caller
`agw-opencode` and the server password. A shell-capable agent can read anything the user can (the password file, the
token in the server's env through `ps`, the user's files by absolute path) and so can call the gateway as
`agw-opencode`: spend on the owner's pools and IU, on rows that lane `agw_workflow`, with any `x-agw-*` value it likes.
The gateway's other paths (`/gemini`, `/replicate`, `/decisions`) are open to the token too. It cannot read an IU or
Claude key and it cannot open the API; rotating the token is one line in `data/door-tokens`
and a restart (`AGENTS.md`, "The doors' callers"). The user's own files stay in reach, so `.env` files and a secrets cache
a shell can read are outside this boundary. Mitigations: the shell tool is denied unless an agent opts in, the server's
`HOME` is its own (no `~/.claude`, `~/.agents` or dotfiles at `~`), the env is an allow-list, the server listens on
loopback with a password. Decided by the lead on that evidence, not an isolation boundary.

The allow-list forwards `OTEL_EXPORTER_OTLP_*`, and on the mini the deploy sets `OTEL_EXPORTER_OTLP_HEADERS`
(`authorization=<ClickStack ingest key>`). That key therefore sits in the server's env and in the env of its tool
shells, readable by a shell-capable agent exactly like the door token. Accepted by the lead for the same reason: the shell
tool is denied unless an agent opts in, and the key is an ingest key.

## Attribution

Every model request carries who it is for, so the gateway's usage row and pool binding land on the step. Evidence and the
pinned source: `docs/spikes/gateway/headers.md`.

`metadata.agw` of a step's session holds the step's `Attribution` (`runId`, `rootId`, `workflow`, `step`, `purpose`,
`project`, `workspace`, `origin`, the names of the runtime's `ctx.attribution`, without `traceparent`, which cannot land) at both create calls, primary and
fallback. The fallback session also holds `routeFallback: "unknown"`, on its follow-up turns too: OpenCode ends a turn with
the error's text, not the 402's headers, so the refused request's id is out of reach. The runtime hands it over in `spec.attribution` of `open` and `followUp`, so opening a step reads nothing, and
the handle keeps it for the fallback session (a handle journaled before a deploy holds no attribution: its fallback
session carries `runId` and `step` only). A session the host finds already there, and the session of a follow-up turn, get
the current values by `PATCH` (one read, a write only when they differ; `PATCH` replaces `metadata` whole, so the rest is
sent back, and the attribution fields are replaced as a set, so a project the new step lacks does not stay), so a `ctx.continue` turn is attributed to the continuing step.

`plugin/agw-attribution/` (a `package.json` and a plain `server.js`, no build: a release is exported from git) hooks
`model.request` and sets `x-agw-session` (`rootId`), `x-agw-run-id`, `x-agw-step`, `x-agw-workflow`, `x-agw-purpose`,
`x-agw-project`, `x-agw-workspace`, `x-agw-origin` (who asked agw) and, on a fallback session, `x-agw-route-fallback: unknown`
(the gateway's `lane_detail.routeFallback`), with the value filter of `gatewayHeaders` (printable ASCII, no space at
either end, up to 200 characters). `ctx.session.get` takes `{ sessionID }`, not the bare id. A child session (OpenCode's
`subagent`) has no metadata of its own: the plugin walks `parentID` to the root, at most 32 hops, and caches the walk, not
the metadata. A read that fails, or a root whose `metadata.agw` has no `runId`, logs `agw-attribution: session <id> sent unattributed:
<why>` to `server.log` and the request goes out without the headers: the gateway then binds on `x-session-affinity`.

The server loads a copy, `<root>/plugins/agw-attribution-<hash16>` (`installPlugin`). A release's directory is named by its
sha: pointing the config there would drift the launch fingerprint on every deploy, restarting the server under its running
sessions. The copy changes only with the plugin.

**Measured on 2.0.32** (`test/live-gateway.test.ts`, `AGW_LIVE=1`, the real binary and host against a loopback stand-in, no
LLM, no key, about 10 s):

| Question | Result |
|-|-|
| All three legs | the base and the key arrive as configured (`x-api-key` on `/anthropic/v1/messages?beta=true`, `authorization: Bearer` on `/openai/v1/*`); the seven `x-agw-*` headers on each. The provider id `anthropic` is what adds `?beta=true`; the gateway routes on the path and passes the query on |
| `x-agw-fallback: none` | on the Anthropic leg, not on the other two |
| A child session | a real `subagent` call: the child's request carries the root's run and step, and `x-opencode-parent-session-id` |
| A follow-up turn | `x-agw-step` is the continuing step |
| `traceparent` | **does not land.** OpenCode's HTTP client writes its own (with `b3`) at send time, after `model.request` and after `http.request` too (probed). The `traceparent` the host sends with its API calls does not reach it either. So the gateway's span sits in OpenCode's trace, not under the step; the join is `x-agw-run-id` and `x-agw-step`. So the host neither stores nor sets it |
| Claude Code signals (`isClaudeCodeShaped`, the gateway's step 0) | none, with and without thinking: `anthropic-beta: interleaved-thinking-2025-05-14` and nothing else, `user-agent: opencode/latest/2.0.32/cli`, no `x-app`, the system starts "You are an AI agent running in OpenCode". No provider config was needed to keep it so. `supportsThinkingBlockBinding: false` keeps the binding beta off |
| A gateway 402 | not retried; the session's error is `{ type: 'provider.quota', message: 'provider balance exhausted: no credit pool eligible', status: 402, response: { body } }`. `isBalanceFailure({ text })` takes the message (the marker), the step moves to the route's fallback |
| Cache writes | every `cache_control` is `{ "type": "ephemeral" }`, on `system`, `tools` and the last message: 5 minutes, no `ttl`. `tokens.cache.write` is priced at `cacheWritePerM`, which is right |

Re-run it on a pin bump, with `docs/spikes/gateway/headers/probe.ts`.

## Pinned build

One OpenCode build for the whole machine: `OPENCODE_VERSION` (`src/server.ts`, 2.0.32), the npm package `@opencode/cli`.
Homebrew's `opencode` is not used: its bottle lags the npm releases, and a `brew upgrade` once changed behaviour under
a running host and broke every run. A Homebrew copy ahead of the pin on `PATH` (`which -a opencode`) is a defect; remove it.

| What | Where |
|-|-|
| the build | `~/.local/share/agent-workflows/opencode-bin/<version>/`, `current` links the pinned one |
| the shim | `scripts/opencode`, linked as `~/.local/bin/opencode`: execs `current`. The host (`resolveOpencodeBinary`), interactive `oc`, `rd wave\|fan --kind opencode` and herdr panes all resolve `opencode` through it |
| the probe wrapper | `scripts/opencode-safe`, linked as `~/.local/bin/opencode-safe`: refuses to start `opencode` when the model endpoint is down (exit 75) instead of retrying forever; an explicit `IU_OPENAI_BASE` wins, then `AGW_GATEWAY_URL` (the mini: its `/health` must say status ok), then `IU_BASE_URL` and the Keychain (the MacBook) |
| react-doctor (the `review` workflow) | `~/.local/share/agent-workflows/react-doctor/<version>/`, `REACT_DOCTOR_VERSION` in `packages/host/src/workflows/review/react-doctor.ts` |

`make install-opencode` (from the main checkout, never a linked worktree: the links point at its `scripts/`) installs the
OpenCode pin, links the two scripts, then installs react-doctor (a react-doctor failure only warns). Idempotent: a version
that is present is not downloaded again; an install is built in a temp directory and renamed into place, and `current` is
repointed atomically, so an interrupted run leaves nothing half-installed. It never restarts the host. The host's OpenCode
server runs the new binary on its next start: the binary path is part of the launch fingerprint, so the first `start()`
after a version bump sees drift and restarts the server (logged). `make verify` fails, naming `make install-opencode`,
when either pinned install is missing. `AGW_OPENCODE_ROOT`, `AGW_REACT_DOCTOR_ROOT` and `AGW_BIN_DIR` (absolute paths)
redirect the installs and the links; `scripts/pins.sh` resolves them and reads the pinned versions.

**Upgrade** is a deliberate act, gated on the live tests:

1. No OpenCode run in flight (the restart interrupts sessions; re-attach resumes them, §Re-attach).
2. Bump `OPENCODE_VERSION` in `src/server.ts` (the installer reads that line, so there is one pin), then `make install-opencode`.
3. Gate: `AGW_LIVE=1 secrets-run run --env-file=.env.tpl -- timeout 600 bun test packages/opencode-host` (§Tests). It covers
   what a new build can break: kill and re-attach, the deny-by-default tool list, skills and `AGENTS.md`, home isolation,
   tokens and cost. Update §Measured for what changed.
4. Green: `make deploy`. Red: restore the old `OPENCODE_VERSION` and `make install-opencode`; the old directory is still
   there, so nothing is downloaded and `current` returns to it.

Skip a fresh minor release until its first patch. The first start of an interactive pane on a new version shows a one-time
release-notes dialog that swallows the initial prompt; dismiss it with Enter.

## Locations

`compileLocation(def)` writes `<stateDir>/locations/<name>/<hash16>/`: `AGENTS.md`, skills under
`.opencode/skills/<path>`, plugins under `.opencode/plugins/<path>` (an agent's custom tools: 2.0.32 discovers a plugin
only there, not in 1.x's `.opencode/tool/` nor through an `opencode.json` `plugins` entry; a plugin tool needs
`options: { codemode: false }` to be offered and stays denied unless the agent's `permissions` allow it by name; measured
Wave 6), `def.config` as `opencode.json`, and `.agw-location.json`. A hash directory is written
once (built beside it, renamed into place) and never changed; a changed agent is a new directory, so a running
session's files are never touched. It throws `LocationLeakError` when any ancestor holds an `AGENTS.md`, a
`CLAUDE.md` or a `.git`. `locationHash(def)` (content incl. plugins, permissions and the host's `basePolicy`, so changing the default moves every agent's hash) is the location input. The *run* fingerprint (`fsFingerprintSource`, middleware) covers each agent's `AGENTS.md`, `agent.json` (route and permissions), `skills/**` and `plugins/**`, plus `basePolicyDigest()` as its `hostPolicy`, so an experiment that changes an agent's route or permissions, or the default policy, moves eval arms.

**Pruning** (`maintain()`, every `locations.tickMs`, 60 s): a hash directory goes when it is not the agent's current
one, not known to the warm cache, not the location of a session the server runs (`GET /api/session/active`), and
unused for `retentionMs` (24 h; the marker's mtime is touched on every open). The retention covers what the host
cannot see: a session that will be re-attached after a crash, and a second host process on the same state dir
during a deploy. The same pass sweeps leftovers of crashed writes older than 10 minutes: `locations/<name>/.tmp-*`
builds and `opencode/server.json.tmp-*`. Only directories are walked (a `.DS_Store` is ignored). When a running
session's lookup fails, pruning is skipped for that tick: its directory is unknown.

**Warm and evict** (`WarmCache`):

- The first use boots a location (`GET /api/location`). Single-flight: concurrent first uses share one warm and one
  refcounted entry; a failed warm fails every waiter and leaves no entry.
- New content (`changed`) with no entry disposes the location before warming it, because an adopted server may hold
  an older head. On a warm entry it marks it stale: evicted before the next use if idle, else once idle.
- Idle locations older than `evictAfterMs` (10 min) are disposed with `DELETE /api/debug/location?location[directory]=…`;
  at most `maxWarm` (16) stay warm, least recently used first. A location in use is never evicted.
- An entry is marked evicting before the DELETE; a use that arrives meanwhile waits and warms again. A failed DELETE
  is logged, the entry stays warm and the next tick retries; it never fails a use or leaks its count. Every
  snapshot-then-await loop (shrink, tick) re-checks an entry (`inUse === 0`, `warm`) right before its DELETE, so a
  use that arrived during an earlier DELETE keeps its location.
- After a server restart every entry goes cold (counts kept); the next use warms.

OpenCode reads `AGENTS.md` and skills when it boots a location (§Measured), which is why changes go through eviction.

## Re-attach

`wait` decides from the session, not from the process that started it:

| State | Seen as | Does |
|-|-|-|
| running | in `GET /api/session/active`, or input in the inbox (prompt projected or not) | poll on |
| done | the newest message is an `idle` after the host's last input | return (`succeeded`); throw (`failed`, `interrupted`, or an idle without a known outcome: `unknown`) |
| cut off | neither, for `cutoffGraceMs` (3 s) | append one synthetic note ("the turn was cut off, continue"), id keyed by the last message, so it is sent once per cut-off point |
| unprompted | no prompt in messages or inbox, not running, for the same grace | throw: wait before prompt |

A connection refused, a timeout or a 5xx is transient: the wait keeps polling and reports no progress, so a server
that never comes back ends by the idle timeout. Swallowed failures (a resume post, a shell size read) are logged with
the session id and error class. A 404 for the session or another 4xx fails the step.

**Why a synthetic note, not the prompt again.** After a SIGKILL mid-turn the store holds the user message and an
empty assistant message, no `idle`, and nothing resumes by itself. Re-posting the prompt id with `resume: true` is
deduped and schedules a run that idles at once with no reply (measured), so the step would end with empty output.
A synthetic message appends to history, is not a user prompt, and the model finishes the task. The step's prompt is
sent exactly once.

**Polling cost.** `GET /api/session/:id/message` pages by cursor (`order`, `limit` ≤ 200, `cursor.next`), so reads
are incremental: one full walk when a wait starts (and after a transient failure), then one newest-first page of 50
per poll merged by id (messages are append-only, and the newest are the ones still changing). A page that does not
reach back to a known message triggers a full walk again. The final usage read walks the whole session once.

## Follow-up turns (`ctx.continue`)

`followUp(handle, { runId, stepId, key, attempt })` returns a handle for a new turn in the same session (the step's
fallback session when it moved there): `turn: <key>#<attempt>`, no request sent. `prompt` on it sends a user input
with a deterministic id (from the session and the turn) and `metadata.agw = { kind: 'followup', turn }`, after
reading the session first, so a re-send is a no-op. `wait` on it is the first-turn loop counted from the turn's own
input: done is an idle after the turn's last input, a cut-off turn gets the same synthetic resume note, and the
answer, tools and usage are those after the turn's input only. A follow-up never falls back on provider balance
(the session already ran on its route). A retried continue step asks for the next `attempt`, so it never re-reads
the failed turn.

## Repeat-tool nudge and friction counters

While a session runs, every poll counts the tool parts after the prompt by **tool name + canonical JSON of the
input** (keys sorted recursively, so `{a,b}` and `{b,a}` are one call). A part whose input is not known yet
(`pending`) is not counted. When one key reaches its **3rd, 5th or 8th** call the host appends ONE synthetic note
(`metadata.agw.kind: nudge`, the same `/synthetic` route as the resume note): "you called this tool with identical
input N times; change approach or answer." Never an abort, never a turn cap.

**Measured on 2.0.32 (2026-10-28, `test/live-nudge.test.ts`, check route, two runs):** a synthetic input posted while
a turn runs is read **in that turn**, at its next step boundary: the note lands after the last assistant message that
finished `tool-calls`, the model answers it in the same turn, and the session has one `idle` in total
(`read, read, read, read, synthetic, assistant "NUDGED" [finish=stop], idle`). It does not wait for the turn to end.
The one race is a note posted as the turn is finishing, which may run as a turn of its own; `finalText` therefore
ignores everything after a nudge that follows an `idle` or a message that finished anything but `tool-calls` (a steer or
resume in between starts a new turn again). A message with no `finish` (aborted, cut off by a restart, or a text
preamble still streaming before its tool calls) is not taken as ended: only an `idle` after it proves the turn is over. The text stops at the last non-empty reply before
such a nudge, so the answer of a step never comes from a nudge turn and a final empty `stop` message does not blank it. The fake server models the measured behaviour (`queueSynthetic(true)`
models the queued one for that race).

- **Exactly once per threshold.** The note's id is keyed by (session, tool+input digest, threshold); the host checks
  its own sent set and the session's messages before posting, and the server dedupes the id too. A re-attached wait,
  a repeated poll, or a restart sends nothing extra. A jump from 2 to 5 calls between two polls sends one note, for 5.
- **Only while running, and a failure is never fatal.** A session that is done is not nudged; a nudge counts as host
  input for the done check, like the resume note. A post that fails is logged with the HTTP status, the error message
  (never a response body), whether it is transient, the attempt and whether it gave up: a transient error is retried
  on the next polls (3 tries in all), anything else gives that threshold up. A given-up nudge stays
  visible: `nudgesMissed` in the session's counters is derived from the messages, so it survives a restart. A threshold
  counts as missed only when a later tool call followed it (the turn went on, so the host had a poll to send the note;
  a threshold at the very last call may never have been polled) and no note for it or any higher threshold of the same
  call is there (a jump across thresholds sends one note, for the highest). Neither touches the turn.
- **Counters are derived, not accumulated.** `sessionCounters(messages, promptId)` (`toolErrors`: parts that ended in
  `error`; `repeatToolCalls`: the highest identical count; `nudges`: nudge notes in the session) is pure over the
  messages. `OpenCodeHost.stepFriction({ runId, stepId })` finds every session of the step from its key (each
  generation a retry opened, each one's provider-balance fallback) and returns the counters per session id. It needs no
  handle: a failed attempt clears its handle, its session stays. Returns `{ sessions, incomplete }`: a probe that fails
  is logged and that session skipped, the others still count, and `incomplete` is set (a failed probe on a generation
  also ends the walk: whether a later one exists is unknown). The middleware marks the run's document and has the
  runtime deliver the hooks again. The middleware calls it at `runPost` (middleware README §Friction).

## DeepSeek wire rules (concept §8)

| Rule | Who | Evidence |
|-|-|-|
| Reasoning passed back verbatim | OpenCode, on the Anthropic route | assistant messages store `reasoning` parts with the provider `state.signature` (probe, 2.0.32) and replay them from the store. On the chat route (`research.agent`, DeepSeek) a tool-call turn's `reasoning_content` goes back verbatim on the next request, and `prompt_tokens_details.cached_tokens` arrive as cache reads priced at the route's rate (real 2.0.32, scripted fake model: host `test/research-opencode.test.ts`, Wave 6) |
| History never edited | the host | the host only appends (prompt, steer, synthetic resume); it never calls revert, fork, compact, `PATCH` or delete. OpenCode's own compaction can still summarise a long session: it is OpenCode's, not triggered by the host |
| System and tool changes appended, not a rewritten head | the host | the head is the location (`AGENTS.md`, skills, `opencode.json`) and the session's permissions. A hash directory never changes and a location in use is never evicted, so a running session keeps its head; a change applies to the next session. A re-attach appends a synthetic note instead of a system change |
| Cache-read tokens recorded | both | OpenCode reports `tokens.cache.read` and `.write` per assistant message; `usageFromOpenCodeMessages` carries them into `Usage` (live run: 7 095 of 7 691 input tokens were cache reads) |

## Bounded context

A route with a `contextLimit` (`packages/routes`; off unless an arm or the table sets it) keeps every call of its agent
steps under that many prompt tokens. Why: Claude Haiku 5.5 bills a request whose prompt (input, cache reads, both cache
writes) is over 100,000 tokens at 5x on every column, and a session grows over its tool turns.

**Mechanism.** The server config adds, for every Claude model and every `CONTEXT_LIMITS` value, an alias row
`<model>~ctx<limit>` (`contextAlias`) with the base row's cost, variants and compatibility, `modelID: <model>` and its
own `limit.context` (`windowFor`). `modelRef` returns the alias for a route with a `contextLimit` (the fallback's is the
plain id), so OpenCode's own `auto` compaction, which runs off the model's window, fires early. No restart: the server
serves every bound, an arm picks one. The key is `modelID`, not `id`: OpenCode 2.0.32's v2 config ignores unknown keys, so
`id` would silently leave the alias calling the gateway with `claude-haiku-5-5~ctx80000`.

**The rule** (OpenCode 2.0.32, `packages/core/src/session/compaction.ts`, `runner/llm.ts`). Before each model call the
runner compacts when `estimate >= ceiling`, `ceiling = window - max(floor(window / 10), 16000)` (so `window - 16000` for a
window from 32k to 160k; `compaction.buffer` is not set). `estimate` = the last response's measured `input + cache.read +
cache.write + output + reasoning`, plus chars/4 of what came after (tool results); the first call is chars/4 of the
whole request. The summary call is the history, as it is when its chars/4 estimate is within `ceiling - ~1k` and
flattened to that size otherwise, plus the summary prompt. So a prompt cannot pass `ceiling * (1 + e)`, `e` being how
far chars/4 undercounts the real tokens (a call after tool results is off only by that results' share). `windowFor(B) =
B / 1.25 + 16000` makes `ceiling = B / 1.25`:

| Bound | `limit.context` | Compaction ceiling | Headroom |
|-|-|-|-|
| 60000 | 64000 | 48000 | 12000 |
| 80000 | 80000 | 64000 | 16000 |
| 100000 | 96000 | 80000 | 20000 |

`e` = 25% is an **assumption**, not a measurement (OpenCode itself assumes 15% for its output sizing; code and JSON
tokenize denser than 4 characters per token). The arm that sets a bound should read the largest prompt it saw.

**Measured on 2.0.32** (`test/live-context-limit.test.ts`, `AGW_LIVE=1`, loopback stand-in, no LLM): the provider gets
`model: claude-haiku-5-5` for an alias session; a first prompt of `ceiling - 6k` estimated tokens is one call, one of
`ceiling + 3k` is a summary call and then the call (the plain row: one call).

**What it costs, and what to check before setting a bound**
- A first prompt (or any prompt) over the ceiling is **summarised before the step runs**: the model works from a summary
  of its own task, not the task. The route's largest first prompt has to be well under the ceiling (80000 for the
  100000 bound).
- `max_tokens` follows the window: `min(route limit, window - prompt)`, 128000 on the plain row, about 16000 near the ceiling.
- The `# Your Model` block of OpenCode's system prompt names the alias key as the model id (text only; the wire carries
  the real id), so a bounded session's system prompt differs from a plain one's by that line.
- A compaction summary call is billed by the gateway, but its tokens sit on the session's `compaction` message, which
  `usageFromOpenCodeMessages` (assistant messages only) does not read: the step's `usage` undercounts the summary calls.
  The gateway's usage rows are complete.

## Usage and cost

`usage` is `usageFromOpenCodeMessages` over the whole session with the route's model (the real id: a bounded route's alias row never reaches usage or pricing, `test/context-limit.test.ts`). OpenCode asks for 5-minute cache
writes only (§Attribution, measured), so its one `cache.write` count and the rate's `cacheWritePerM` are the right pair.
Cost per assistant message:
OpenCode's when it is positive (it prices with the config's cost rows, i.e. the route's own `rate`, `costSource:
provider`); a message reported at cost 0 with tokens is priced with the route's rate through `costFromUsage`
(`costSource: rate`). The step is unpriced (`cost: null`, `costSource: unknown`) when that has no rate, when cache
tokens appear without the matching cache rate: never free. A message above the rate's `longPromptTokens` on a rate with a
`longPrompt` tier is priced by the rate whatever OpenCode reported (its cost rows are flat and cannot know the tier); a
rate without the tier is flat at any size. A step that moved to its fallback session is priced with
the fallback's rate and reports the fallback's model. Every `opencode`-wire route carries its own rate (`packages/routes`).

## Provider-balance fallback

A turn that ends `failed` with a provider-balance error (`isBalanceFailure` from `@agent-workflows/routes`: the IU
503 "Insufficient Balance (PaymentRequired)" wording, a 402, or Anthropic's "credit balance is too low to access the Anthropic API" sentence) reopens the step once on the route's `fallback`:

- Only when the turn did nothing: no tool call and no output tokens after the prompt. A turn that ran is never
  prompted a second time (concept §3); its step fails with the balance error, logged.
- The fallback session's id is derived from the failed session's (`ses_agw<sha256(sessionId, "fallback")>`), in the
  same location, with the same permissions (the handle keeps the step's `allowDirectories` as `allow`). A wait after
  a crash reads the failed primary again and lands on the same fallback session: its create returns the existing one
  and `prompt` sends nothing when the prompt is there.
- The fallback session never falls back again; its failure fails the step. An arm's `{"routes": {"<route>": {"fallback": null}}}`
  turns it off for the runs of that eval.
- A retry of the step (`open` again with the same key) while the fallback session still runs re-attaches through the
  primary's handle, as for a primary that still runs: no new session, no second prompt.
- `abort` interrupts the fallback session too (every session is tried, errors are raised after) and `steer` goes to
  it once it exists: the journal keeps only the step's first handle.
- **Known limit:** a steer sent to the primary before its turn was refused is not carried to the fallback session.
  Only a turn that did nothing falls back, so the steer had no effect there either.

## Failure modes

| What | Then |
|-|-|
| Server wedged (no `/api/info` answer) | killed after 3 missed probes, restarted on the same port; waits re-attach |
| Server crashed | restarted on its exit event; waits re-attach |
| Host process restarted (deploy) | the server keeps running; the next host adopts it (or restarts it if its env or config drifted), the runtime re-attaches by handle |
| A turn hangs inside OpenCode (model call stuck, no new message) | no progress, the runtime's idle timeout fails the step and calls `abort` |
| Session lost (store reset) | `wait` fails: `opencode session … is gone` |
| `ask` permission | prevented: `question` and `external_directory` are denied server-wide; an agent's own rules must not use `ask` |
| Location under a repo | `LocationLeakError` at open |
| Corrupt `server.json` | `start()` fails naming the file |
| OpenCode version changed | adoption and boot refuse it; bump `OPENCODE_VERSION` after re-running the live test |

## Known gaps

- **One host process per machine.** `compileLocation` is atomic per hash directory, but two processes compiling the
  same agent at the same moment may both build it (the second rename fails or replaces an identical tree). The
  deploy shape is one host process, so this is not handled.
- DeepSeek reasoning pass-back on the chat route is unverified (no route uses it).

## Token effect / cache effect

- **No tokens of its own** in a normal step: the prompt is sent once, the title is set at create (no background
  title call), the location head is stable for the whole session.
- **A re-attach after a mid-turn kill** costs one short synthetic note plus a new assistant turn. The provider
  prompt cache stays warm because the head and history are unchanged (live run: 92 % of the resumed turn's input
  was cache reads). What the cut-off turn had generated is lost (an empty message in the store) and is paid again.
- **A follow-up turn** (`ctx.continue`) sends only its own text: the session's head and history are a warm
  prompt-cache prefix, so a nudge costs the feedback plus the new answer, not the original prompt again.

- **A nudge** is one short model-visible note (about 50 tokens) at the 3rd, 5th and 8th identical call, appended after
  the cached prefix: the head and history stay byte-identical, so the cache is unaffected. It is read in the running
  turn (measured), so it adds one step boundary's worth of input, not a turn; in the finishing race it can cost one
  short extra turn whose reply is ignored. It also changes what the agent does next, on purpose. Reading the counters
  at `runPost` is a full message read per session of each agent step; no tokens.
- **Deny by default shrinks the head.** A refused tool is not in the model's tool list, so its definition is not sent:
  a read-only session carries four tool definitions instead of twelve, input tokens down on every turn, and the
  prefix stays byte-stable per agent (the rules do not change between sessions of an agent). An opt-in adds that
  tool's definition back, once, to that agent's head.
- **A changed agent** (`AGENTS.md`, skill, config, permissions) changes the head: its next session starts with a
  cold cache, once. The fingerprint changes with it.
- **A server restart** without a running turn costs nothing: the session is read, not resumed. A drift restart at
  adoption cuts running turns, which then cost one resume each.

## Measured (2.0.32, 2026-10-28)

| Question | Result |
|-|-|
| Auth | `GET /api/info` needs Basic auth on 2.0.32 (401 without), so the liveness probe proves the password too |
| Client ids | `POST /api/session` and `/prompt` take a client `id` (`ses…`, `msg_…`); a second post of the same id returns the first admission and adds nothing. Pagination by cursor works with such ids |
| Order | messages are listed by time, not by id |
| Inbox | `POST /prompt` with `resume: false` admits into `GET /api/session/:id/inbox` without running; it is not in the messages until it runs |
| SIGKILL mid-turn | user message and an empty assistant message survive; no `idle`; not in `/active`; nothing resumes by itself. A re-posted prompt id with `resume: true` idles at once with no reply; `POST /synthetic` resumes and the model finishes |
| Evict | `DELETE /api/debug/location?location[directory]=…` → 204, gone from `GET /api/debug/location`; the next use re-reads `AGENTS.md` (an `AGENTS.md` written after the boot was not seen until the eviction) |
| Skills | loaded at the first prompt from the location's `.opencode/skills/` (live run: the model named the location's skill) |
| Home isolation | with `HOME=<root>/home` (no `OPENCODE_TEST_HOME`) and `OPENCODE_DISABLE_CLAUDE_CODE=1`, the model's skill list is the location's skill plus OpenCode's builtins (`opencode`, `report`), none of the user's `~/.claude/skills` (live run asserts it). `OPENCODE_TEST_HOME` is not needed |
| Deny by default | with the catch-all deny the model's tool list is `read, glob, grep, skill`; with every action allowed it is `edit, glob, grep, question, read, shell, skill, subagent, webfetch, websearch, write, execute` (`test/live-permissions.test.ts`) |
| Synthetic mid-turn | a `POST /synthetic` while a turn runs is read in that turn at its next step boundary (after a `finish=tool-calls` message; one `idle`), not queued behind it (`test/live-nudge.test.ts`) |
| Project | a location outside any repo is its own project (`GET /api/location` → `project.directory` = the location) |

## Tests

`bun test packages/opencode-host`: a fake OpenCode server (`test/fake-opencode.ts`) with the measured behaviour
(persisted store, dedupe by id, client session ids, no self-resume, an empty idle on a re-posted id), in-process for
the host and as a spawned `opencode` stand-in (`test/fake-opencode-bin.ts`) for the supervisor.

| File | Covers |
|-|-|
| `host.test.ts` | a turn's output and usage; structured output: the schema in the location's result plugin, `AGENTS.md` and permissions, the handle's marker, the value returned, a follow-up turn and a continue with another output refused, a fenced-JSON text answer and a rejected call failing `invalid_output`, a wrapped root and a keyless call, refusals at open (no schema, the conversion's reason, unresolvable refs), a handle without the marker, the fallback session's rule; prompt idempotency (twice, and across a restart); open idempotency per key, the retry generation, a retry re-attaching a still-running session; a failed turn; an outcome-less idle; cost 0 priced by rate, unpriced without one; permissions; a pending prompt is running, a missing one fails after the grace; incremental reads; a wait surviving a kill and restart with one resume and no second prompt; a finished session read, not resumed; the provider-balance fallback (one reopen, re-attach without a second prompt, no fallback after a turn that ran, none for other failures or with `fallback: null`, abort reaching it); steer dedupe by signal; abort twice; tool events per wait; shell output as progress; warm, evict, hash directories and pruning |
| `server.test.ts` | the env allow-list (no provider key, no API secret), `gatewayFromEnv`, `installPlugin`, the server's own HOME and the file-watcher flag; a wedged server SIGTERMed, SIGKILLed and restarted on the same port; a crash restarted; adoption by the next process; drift restart; a foreign pid neither adopted nor signalled; corrupt `server.json`; a version mismatch refused; shim resolution; a wait in flight across a liveness kill; the config |
| `locations.test.ts` | compile, hash directories, the hash, ancestor leaks, path escapes, pruning, the temp sweep; the warm cache under concurrency: single-flight, failed warm, failed evict, shrink re-check, use during evict, reset, changed content |
| `live-permissions.test.ts` | `AGW_LIVE=1`: the deny-by-default policy: the tool list per opt-in, refused calls, an opted-in `webfetch`, Code Mode's empty catalog |
| `plugin.test.ts` | the attribution plugin against a fake session store: parity with `gatewayHeaders`, the value filter, the walk to the root and its cache, the loud failures |
| `context-limit.test.ts` | the bounded rows (`contextLimit`): an alias per Claude model and bound with `modelID`, the window, the base row's cost and variants; `modelRef` and the fallback; the usage and price on an alias session |
| `live-context-limit.test.ts` | `AGW_LIVE=1`: a bounded route on the pinned build: the real model id on the wire, compaction at the ceiling and not below it; no key, no LLM |
| `live-gateway.test.ts` | `AGW_LIVE=1`: the wire of the pinned build (§Attribution); needs no key and calls no LLM |
| `packages/host/test/attribution-opencode.test.ts` | a run's attribution end to end: the real `Runtime` and `OpenCodeHost` on the fake server, through a balance fallback and a follow-up turn, to the headers the plugin sets |
| `live-structured.test.ts` | `AGW_LIVE=1`: a JSON step on Haiku: a planted invalid `submit_result` call rejected by OpenCode, the valid one's input as the output, a follow-up turn's result |
| `live.test.ts` | `AGW_LIVE=1`: the real binary, SIGKILL mid-turn, restart, re-attach, one prompt; AGENTS.md and a skill reach the model, the user's skills and the shell tool do not; a non-shell agent's read, glob, grep and write outside its location are refused; tokens and cost |

Live: `AGW_LIVE=1 secrets-run run --env-file=.env.tpl -- timeout 600 bun test packages/opencode-host`
(about $0.002). The env needs `AGW_GATEWAY_URL` and `AGW_GATEWAY_TOOL_TOKEN`: the sessions run through the gateway.
