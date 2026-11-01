# Header probes: can OpenCode and Hermes carry per-session gateway headers

Wave 1 spike of `docs/waves/PLAN.md` (step "Header probes"). Input for `docs/gateway.md` §Callers and attribution and
§Picking a pool (session binding). Zero LLM calls: every request went to a loopback capture server
([`headers/capture.ts`](headers/capture.ts)) that logs method, path, headers and the body's `metadata`, then answers with a
minimal valid streaming response (Anthropic Messages, OpenAI chat, OpenAI Responses). Keys are dummies.

Re-run: `cd docs/spikes/gateway/headers && timeout 300 bun run probe.ts` (about 46 s). Output of the run behind this
report: [`headers/evidence/probe-output.txt`](headers/evidence/probe-output.txt) (readable dump) and
[`headers/evidence/capture.json`](headers/evidence/capture.json) (22 requests, raw).

## Verdicts

|Question|Verdict|
|-|-|
|A1. OpenCode 2.0.32: static extra headers on an anthropic / openai-compatible / openai provider|**Yes.** Provider `headers`, provider `settings.headers` and model `headers` all arrive, on all three legs.|
|A2. A per-session value reaches the request with no code|**Yes, built in.** 2.0.32 sends `x-opencode-session-id` (and `x-opencode-session`, `x-session-affinity`, `x-session-id`) on every request. The value is the session id, which the host chooses.|
|A3. A hook sets headers per request with the session id in scope|**Yes, via a plugin.** The `model.request` session hook gets `sessionID` and a mutable `headers` map. The same plugin reads the session's `metadata` with `ctx.session.get({ sessionID })`.|
|A4. `metadata.user_id` on the Anthropic body|**Only via X:** a static `body` overlay on the provider, or a plugin `context` hook setting `options.metadata`. Not needed: the headers carry the session.|
|A5. Could `packages/opencode-host` inject a per-session value|**Yes.** It already creates every session with a client-chosen id and `metadata`. Two small host changes needed (see Recommendation).|
|B1. Hermes custom provider: static extra headers|**Yes**, `extra_headers`, on `chat_completions` and `anthropic_messages`. One gap: auxiliary calls drop them (see B).|
|B2. Hermes: per-session header|**Yes**, `session_affinity_header: <name>` on the provider entry. Value is Hermes' conversation id, new per conversation.|

## A. OpenCode 2.0.32 (pinned build)

Source: `anomalyco/opencode` tag `v2.0.32` (commit `843a6c5`, read through a shallow clone), not memory. The probe runs
the installed pinned binary (`opencode-bin/2.0.32`) through `scripts/opencode-safe` (`run --standalone` and `serve`) with
temp `HOME` and `XDG_*` dirs, `OPENCODE_CONFIG_CONTENT`, `OPENCODE_DB` in a temp dir; the proxy env points at a dead port so
nothing leaves loopback. `~/.config/opencode` is never read.

The three providers mirror `packages/opencode-host/src/config.ts:151-171`: `aisdk:@ai-sdk/anthropic`,
`aisdk:@ai-sdk/openai-compatible`, `aisdk:@ai-sdk/openai` (Responses). In 2.0.32 the `aisdk:` specifiers are rewritten to
OpenCode's native packages (`packages/core/src/aisdk-native.ts:41`), which is why the header overlays below are read from
the config at all.

### A1. Static headers: yes

Config levels, all in the schema (`packages/schema/src/config/provider.ts:35-37,42-43`, `packages/schema/src/provider.ts:68`)
and merged in `aisdk-native.ts:41` (`target.headers = Provider.mergeHeaders(...)`) and `:169` (`settings.headers`).
Captured, case A1, Anthropic leg (`headers/evidence/probe-output.txt:86-110`; the same three lines on the chat and
Responses legs):

```
x-agw-static-model: from-model.headers
x-agw-static-provider: from-provider.headers
x-agw-static-settings: from-settings.headers
```

A static body overlay lands too: `body: { metadata: { user_id: "static-body-user" } }` on the Anthropic provider arrives as
`body.metadata: {"user_id":"static-body-user"}`; `body: { user: ... }` arrives as the OpenAI `user` field. Static means one
value per server process: it cannot carry a session.

### A2. Per-session value with no code: yes, built in

`packages/core/src/session/model-request.ts:279-291` builds the default HTTP headers of every model request:

```ts
"x-opencode-session-id": session.id,
...(session.parentID ? { "x-opencode-parent-session-id": session.parentID } : {}),
"x-session-affinity": affinity,   // parentID ?? fork source ?? id  (core/src/session/affinity.ts)
"X-Session-Id": affinity,
"x-opencode-session": affinity,
"x-opencode-project": session.projectID,
```

Captured with no headers configured (case A0, Anthropic leg, `probe-output.txt:5-20`, excerpt):

```
x-opencode-client: cli
x-opencode-project: 72c13062d38d68674c6774a0d389b7353e58c813
x-opencode-session: ses_aaaa…aaaac0de00
x-opencode-session-id: ses_aaaa…aaaac0de00
x-session-affinity: ses_aaaa…aaaac0de00
x-session-id: ses_aaaa…aaaac0de00
```

Same on the chat-completions and Responses legs (Responses also sends `prompt_cache_key` in the body). The value is the
session id, and the host picks it: `sessionIdFor(key, generation)` is `ses_agw<digest>` (`packages/opencode-host/src/session.ts:27`),
the fallback session another id (`fallbackSessionId`). For a child session (OpenCode's own sub-agents, not exercised here)
`x-opencode-session-id` is the child and `x-session-affinity` the parent's id (source, `affinity.ts`).

### A3. Per-request hook with the session id in scope: yes, a plugin

`model.request` is a session hook (`packages/plugin/src/effect/session.ts:63-70,144`), triggered once per model request
at `model-request.ts:305-309` with the headers above as a mutable copy; whatever it returns is sent
(`model-request.ts:310-318`). The hook event carries `sessionID`, `agent`, `model`, `kind` (`primary | compaction | title |
generate`), `baseURL` and `headers`. It is not marked experimental (the `experimental.ws.*` hooks are).

The probe plugin ([`headers/plugin/agw-session-headers/server.js`](headers/plugin/agw-session-headers/server.js), 20 lines):

```js
await ctx.session.hook('model.request', async (event) => {
  event.headers['x-agw-session'] = event.sessionID
  event.headers['x-agw-kind'] = event.kind
  const session = await ctx.session.get({ sessionID: event.sessionID }).catch(() => undefined)
  const agw = session?.metadata?.agw
  if (agw?.runId) event.headers['x-agw-run-id'] = String(agw.runId)
  if (agw?.stepId) event.headers['x-agw-step'] = String(agw.stepId)
})
```

Captured, case A2 (`serve` + HTTP API, sessions created like `host.ts:355-366`: client-chosen `id`, `metadata.agw`), Anthropic
leg (`probe-output.txt:185-200`, excerpt; the chat and Responses legs carry the same four):

```
x-agw-kind: primary
x-agw-run-id: run-0
x-agw-session: ses_aaaa…aaaafeed00
x-agw-step: step-0
```

Two traps found on the way, both in the loading, not the hook:
- A configured plugin must be a **directory** (`config/plugin/source.ts:150-155`: "configured plugin path must be a directory"):
  a `package.json` plus a `server.js` (or `index.js`) entry. A bare `.mjs` file in `plugins` is dropped silently.
- `ctx.session.get` takes `{ sessionID }`, not the bare id (`core/src/config/plugin/command.ts:125`). My first plugin passed the
  bare id: the headers built from `event` arrived, `x-agw-run-id` / `x-agw-step` did not, and nothing errored (the plugin's
  `.catch` swallowed it). Keep a loud failure there in the real plugin.

### A4. `metadata.user_id`: only via a plugin or a static overlay

A plugin `context` hook (`SessionContext.options`, "any other key is a provider option", `plugin/src/effect/session.ts:22`) with
`event.options.metadata = { user_id: event.sessionID }` put it on the wire for two of the three legs (A2):

```
anthropic leg:  body.metadata: {"user_id":"ses_aaaa…aaaafeed00"}
responses leg:  body.metadata: {"user_id":"ses_aaaa…aaaafeed02"}
chat leg:       body.metadata: null
```

Nothing sets it by default (`body.metadata: null` in A0). It works, but it is a second channel for a value the header already
carries, it does not exist on the chat leg, and `user_id` has Anthropic-side meaning (abuse attribution). Do not use it.

### A5. What the host does today and what it would change

`packages/opencode-host/src/host.ts:355-366` creates each session with `{ id: sessionId, title: "agw <runId>:<stepId>", location, model,
permissions, metadata: { agw: { key, agent, route, locationHash } } }`; the fallback session (`host.ts:687-697`) carries
`{ agent, route, fallbackOf }`. `runId` and `stepId` are in the title only. Provider settings are built once per server in
`config.ts:151-171` (`buildServerConfig`, handed over as `OPENCODE_CONFIG_CONTENT`, `server.ts:114`). The server's env and
config are fingerprinted (`server.ts:317-327`), so a config change restarts the server on deploy.

To attribute by step the host needs:
1. `plugins: [<absolute dir of the plugin>]` in `buildServerConfig`'s result, and the plugin shipped in the package.
2. `runId` and `stepId` in `metadata.agw` on both create calls (the title is parseable, but metadata is the contract).

Not exercised, flagged: **child sessions** (OpenCode's own sub-agent `task` calls). They have no host metadata; the plugin must
walk `parentID` to the root session for `runId` / `stepId`, otherwise a sub-agent's requests go out with `x-agw-session` set but
no run or step. Whether the host's policy even lets agents spawn sub-sessions is a host question; check it before relying on this.

## B. Hermes

Source: the install the live Hermes runs, `~/.hermes/hermes-agent` (tag `v0.22.2`, commit `d923a5e`), read-only. The task named
`~/SourceRoot/hermes-agent`: that repo holds config, skills and patches only, no Python source. None of its `patches/*.patch` mentions
`affinity`, `extra_headers` or `default_headers` (grep), so the installed header behaviour is upstream's.

### Capture run: possible without touching `~/.hermes`

`HERMES_HOME` and `HOME` both point to temp dirs, `--ignore-user-config`, the proxy env points at a dead port, a custom provider
named `capture` points at the capture server, run with `venv/bin/hermes -z ping --provider capture -m capmodel`. A search of the
live `~/.hermes` for the three probe session ids afterwards found nothing. Each run prints a `hermes pm` dependency-repair
notice on stderr (the temp home has no committed dependency env); the request still goes through with the installed
dependencies.

### B1. Static `extra_headers`: yes

`providers.<name>.extra_headers` (docs: `website/docs/user-guide/configuring-models.md:190-201`) is merged into the OpenAI client's
`default_headers` (`hermes_cli/config_providers.py:500-512`, called from `agent/agent_init.py:984` and
`agent/client_lifecycle.py:959`). Docs say it also covers `anthropic_messages`. Captured, `anthropic_messages`
(B2 case, `probe-output.txt:331-338`, excerpt):

```
POST /v1/messages
x-agw-caller: hermes
x-agw-session: 20261101_183031_958e10
x-agw-workflow: static-value
```

**Gap:** the second request of each `chat_completions` run (read timeout 30 s instead of 1800 s, so an auxiliary call) carried the
session header but **not** the static ones (`probe-output.txt:285-297`: only `x-agw-session`). The docs promise auxiliary clients
get `extra_headers`; in this run they did not. A gateway must not depend on a static header for attribution; the caller comes
from the door token anyway.

### B2. Per-session header: yes, `session_affinity_header`

`providers.<name>.session_affinity_header: <header name>` (opt-in, default off, `config_providers.py:515-528`) makes every
request on that provider carry the conversation id under that name: `build_api_kwargs` (`agent/chat_completion_helpers.py:1505-1518`)
calls `merge_session_affinity_headers` (`agent/opencode_affinity.py:131-146`) on every transport (`chat_completions`,
`anthropic_messages`, `codex_responses`); auxiliary calls go through the same merge (`agent/auxiliary_client.py:6854`). The value
(`resolve_affinity_key`, `opencode_affinity.py:81-90`) is opaque, stable across turns and compaction, and different for every
conversation. Captured, `chat_completions`, two separate runs (`probe-output.txt:268-325`):

```
run 1, main request:  x-agw-session: 20261101_183016_46a65a
run 1, aux request:   x-agw-session: 20261101_183016_46a65a
run 2, main request:  x-agw-session: 20261101_183024_68c787
run 2, aux request:   x-agw-session: 20261101_183024_68c787
```

The header NAME is free, so `session_affinity_header: x-agw-session` is exactly what the gateway's session binding reads first.

The live `config.yaml` uses a `providers.custom` entry and a legacy `custom_providers` list on the OpenAI-compatible wire. The route lookup
(`_entries_for_route`, `config_providers.py:368`) matches entries by normalized base URL over the merged `providers:` and
`custom_providers` lists; the probe covered the `providers:` dict form only. Moving Hermes
onto the gateway means an `anthropic_messages` entry (the gateway's wire), not a change to the existing one; the captured B2
case is that shape.

## Recommendation for `docs/gateway.md` §Callers and attribution

Replace the sentence "Whether OpenCode can carry per-session headers decides how OpenCode steps are attributed (Wave 1 spike);
without them the join is by `opencode.session.id` on the step span." with:

> **OpenCode** sends the session id on every request without configuration (`x-opencode-session-id`, plus
> `x-session-affinity`, the root session's id). The host adds `x-agw-session`, `x-agw-run-id` and `x-agw-step` through a small
> plugin (`model.request` hook, values read from the session's `metadata.agw`). The join by `opencode.session.id` stays as the
> fallback. **Hermes** sets `session_affinity_header: x-agw-session` on its gateway provider entry; static `extra_headers` are
> optional and not relied on (auxiliary calls drop them).

And in §Picking a pool, session binding:

1. **OpenCode steps bind on the run, not the OpenCode session.** The plugin should send `x-agw-session = <runId>`, the value agw's
   own calls send, so a run's steps share one pool. Falling back to `x-opencode-session-id` works with no host change but binds
   per step session (a cache restart between steps of a run; accepted if the plugin slips).
2. **Add `x-opencode-session-id` to the binding chain** (after `x-claude-code-session-id`), so an OpenCode request without the
   plugin still binds. Add `x-session-affinity` instead if sub-agent sessions should share their parent's pool.
3. **Namespace binding keys by the door-token caller.** Hermes' ids (`20261101_183016_46a65a`) and OpenCode's (`ses_…`) come from
   different generators; `(caller, session)` removes any collision question.
4. Do not use `metadata.user_id` for OpenCode or Hermes (A4).

Host changes this implies (not made here, out of the spike's owned files): plugin dir + `plugins` entry in
`packages/opencode-host/src/config.ts`, `runId` / `stepId` in `metadata.agw` at `host.ts:363` and `:694`, and the OpenCode
Anthropic provider's `baseURL` / key moving from `https://api.anthropic.com/v1` + `ANTHROPIC_API_KEY` to the gateway and a door
token. The Anthropic SDK path sends the key as `x-api-key`, the OpenAI legs as `authorization: Bearer` (both seen in the capture);
the gateway's door-token check must read the one the caller's wire uses.

## What is not proven

- Sub-agent (child) sessions: source only (A3, A5).
- The plugin hook against a **non-loopback** gateway or with TLS: the hook runs before the transport, so no difference is expected.
- Behaviour on other OpenCode builds: a pin bump needs `probe.ts` re-run; it is the regression test for A2 and A3.
- Hermes' `gateway` (Slack) process path: the probe drove `hermes -z` (one-shot CLI). The gateway builds requests through the
  same `build_api_kwargs`, which is why B2 should hold there; not run.
