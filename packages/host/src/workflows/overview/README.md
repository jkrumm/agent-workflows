# Overview (concept §10)

The port of agent-gateway's agents overview: what every Claude Code agent on the host is doing, one recommendation each,
and the Max quota beside it. The host owns it end to end; `src/fleet/` holds the collectors, the renderer and the quota,
this directory the one workflow that spends. Section §Host reads in `packages/host/README.md` has the commands.

| Command | Does | Cost |
|-|-|-|
| `agw overview [--stale-after-hours N]` | a journaled run: a fresh snapshot, then one `overview.classify` call; answers `{generatedAt, model, snapshotGeneratedAt, agents[{id, sessionId, project, recommendation, standing, blocker, confidence, synthesized?}]}` and pushes the merged payload to Argo | one Haiku 5.5 call |
| `agw agents [--text] [--cols N] [--color]` | a read, no run: the snapshot merged with the newest `overview` run and the quota (`{data}`), or its render (`{text}`) | 0 |
| `agw quota` / `agw quota-report …` | the Max quota per account; the statusline's report | 0 |

## Route

`overview.classify` (`packages/routes/src/table/overview.ts`): Haiku 5.5 on IU's native Messages wire, priced at the Haiku
5.5 table rate, balance fallback to GPT-6.1 Terra (the route `cheap.summarize` takes). Source seat: agent-gateway's
`overview` tool, the CLASSIFY tier. Hop checked 2026-10-29 with one 17-token probe on the team key: response header
`x-middleware-forwarded-server: AWS Bedrock us-east-1` (`x-middleware-forwarded-model` the Haiku 5.5 Bedrock profile),
not Requesty.

## Decisions

- **The model call is a capability.** `overview.classify` (`packages/capabilities/src/capabilities/overview-classify.ts`)
  takes `{facts, agentIds}`, builds the fenced prompt inside (legacy's skill text word for word, a fresh 128-bit fence,
  fence markers in the facts made inert, the re-assertion after the data) and answers the validated verdicts for the
  listed ids only. No free prompt is reachable. Its CLI command `overview-classify` is hidden: `agw overview` is the
  command, the capability is the seat.
- **The run is the cache.** Legacy kept the newest overview job and merged it onto a fresh snapshot on every read; here
  the newest `done` top-level `overview` run's output is that job (`latest.ts`, one indexed read on the process's own
  pool), re-validated against `OVERVIEW_OUTPUT` so a drifted old run reads as "no overview" and not as an error. An
  agent active after the run keeps `recommendation: null` and `recommendationStale: true`.
- **Reads are not runs.** `agents`, `quota` and `quota-report` are host operations like `run status`; a herdr pane polling
  every 30 s and a statusline reporting on every render journal nothing. The snapshot is cached for 45 s (the promise,
  so concurrent first callers share one build); the classify run always builds a fresh one.
- **No agent, no call.** An empty fleet is a run with an empty `agents` list and no model call.
- **The push carries the run itself.** The `push` step posts the payload merged with the run that is just ending: its
  output is not in the journal until the run ends, so reading "the newest run" there would push the previous one.
- **Dispatch jobs stay in agent-gateway.** The collector reads its HTTP read-only (`GET /api/jobs`, then
  `GET /api/jobs/:id` for the params and session of a job that is running, queued or ended within 6 h: the list view
  carries neither). An agent-gateway that is down or answers an error is a snapshot warning.
- **Git status is read-only except one fetch.** As in legacy each project's checkout is `git fetch --quiet --prune`d (5 s
  cap, no credential prompt) so ahead/behind is current; the status itself needs the branch, `status --porcelain`,
  `rev-list --left-right --count HEAD...@{upstream}` and the newest commit beyond the main branch (else on it).

## Hardening (review r1)

- **Children get four variables.** `git`, `herdr` and `claude` run with `PATH`, `HOME`, `TMPDIR`, `LANG` and
  `GIT_TERMINAL_PROMPT=0`, never the host's environment (`AGW_API_SECRET`, `ARGO_API_SECRET`, `IU_API_KEY`).
- **A session id is a path segment.** Only `[A-Za-z0-9_-]` reaches a transcript or pin path; anything else reads nothing.
- **Text from outside loses its control bytes** (transcript fields, titles, wait reasons, project and branch names, commit
  subjects, the model's standing and blocker) before it reaches a pane, Argo or a prompt.
- **No sync fs on the host loop:** the human queue, the pins and the session-env logs (the last 2 MB of each of the newest
  three day files) are read async.
- **A sparse herdr or registry row** is null-filled in `mergeAgents`, a row with no identity is skipped; `agw agents`'
  strict output never 500s on a missing field.
- **The journal keeps** the facts text, the ids and the minimal `known` list of the snapshot step, and the verdicts: no
  transcript excerpt beyond what classify is shown, no queued command. The run time is taken inside the classify step.
- **The seat's cap:** the facts are cut to the capability's limits (400 000 characters, 500 agents), most recently active
  agents first, whole agents only; the rest are `synthesized` placeholders.
- **The Argo push goes out for `prod` runs only.** The workflow context carries no purpose, so the host reads
  `runs.purpose` of the run in the `push` step; a build or verify run pushes nothing.
- **`quota-report` is bounded:** percentages 0..100, minutes left 0..10 080, and a new account id is accepted only up to
  the CLI registry's accounts plus 4.

## Environment (host)

| Variable | Default | |
|-|-|-|
| `ARGO_URL`, `ARGO_API_SECRET` | | the push is off unless both are set; `ARGO_URL` must be https (loopback http allowed), no redirect is followed |
| `AGW_ARGO_PUSH` | on | `0`, `off`, `false` or `no` turns the ten-minute timer off (tests); the push after a run stays |
| `AGW_AGENT_STALE_HOURS` | 24 | the stale threshold (legacy `AGENT_GATEWAY_AGENT_STALE_HOURS`) |
| `AGW_HERDR_BIN`, `AGW_CLAUDE_BIN` | `~/.local/bin/<name>`, else on `PATH` | |
| `AGW_CLAUDE_ACCOUNT_BIN` | `~/.local/bin/claude-account` | legacy `AGENT_GATEWAY_CLAUDE_ACCOUNT_BIN` |
| `AGW_CLAUDE_LOG_DIR` | `~/.claude/logs` | the `session_env` lines (legacy `AGENT_GATEWAY_CLAUDE_LOG_DIR`) |
| `AGW_SESSION_ACCOUNTS_DIR` | `~/.local/state/agent-gateway/session-accounts` | the spawn pins agent-gateway writes (legacy `AGENT_GATEWAY_SESSION_ACCOUNTS_DIR`) |
| `AGW_AGENT_GATEWAY_URL` | `http://localhost:7705` | where the dispatch jobs are read |
| `XDG_STATE_HOME` | `~/.local/state` | `human-queue/` below it |

The legacy `AGENT_GATEWAY_CLAUDE_USAGE_TIMEOUT_MS` is gone: the `claude-account` calls have a fixed 5 s cap.

## Port

`src/fleet/derive.ts`, `render.ts`, `text.ts`, `quota.ts` and the collectors in `collect.ts` are agent-gateway's
`lib/agents.ts`, `lib/render-text-utils.ts`, `lib/claude-usage.ts` and `mcp/worker-shared.ts` (picker calls) at its
`master` of 2026-10-29; the legacy cases for `deriveState`, `mergeAgents`, `parseTranscriptTail`, `renderText` (plain,
colour, `cols`, quota, human queue), `fitHeader`, the human queue, the session-account join, `mergeAccountQuota`,
`renderQuotaHeader`, `reconcileOverview` and `mergeOverviewIntoSnapshot` run unchanged in `test/fleet-*.test.ts`. Legacy
module state (the memo maps, the posted usage) is a closure per `createQuota` / `sessionAccountResolver` here, so tests
need no reset hooks.
