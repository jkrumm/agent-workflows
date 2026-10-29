# Overview (concept §10)

The port of agent-gateway's agents overview: what every Claude Code agent on the host is doing, one recommendation each,
and the Max quota beside it. The host owns it end to end; `src/fleet/` holds the collectors, the renderer and the quota,
this directory the one workflow that spends. Section §Host reads in `packages/host/README.md` has the commands.

| Command | Does | Cost |
|-|-|-|
| `agw overview [--stale-after-hours N]` | a journaled run: one step that takes a fresh snapshot and makes one `overview.classify` call; answers `{generatedAt, model, snapshotGeneratedAt, agents[{id, sessionId, project, recommendation, standing, blocker, confidence, synthesized?}]}` and pushes the merged payload to Argo | one Haiku 5.5 call |
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
  listed ids only. No free prompt is reachable: the capability is `internal`, so no route and no CLI command serves it and
  only the `overview` workflow calls it.
- **The run is the cache.** Legacy kept the newest overview job and merged it onto a fresh snapshot on every read; here
  the newest `done` top-level `prod` `overview` run's output (the push's own gate: a build or verify run is never served) is that job (`latest.ts`, one indexed read on the process's own
  pool), re-validated against `OVERVIEW_OUTPUT` so a drifted old run reads as "no overview" and not as an error. An
  agent active after the snapshot the run classified (`snapshotGeneratedAt`, not the moment the model answered) keeps `recommendation: null` and `recommendationStale: true`.
- **Reads are not runs.** `agents`, `quota` and `quota-report` are host operations like `run status`; a herdr pane polling
  every 30 s and a statusline reporting on every render journal nothing. The snapshot is cached for 45 s (the promise,
  so concurrent first callers share one build); the classify run always builds a fresh one.
- **No agent, no call.** An empty fleet is a run with an empty `agents` list and no model call.
- **The push carries the run itself.** The `push` step posts the payload merged with the run that is just ending: its
  output is not in the journal until the run ends, so reading "the newest run" there would push the previous one.
- **No dispatch lane.** Dispatch retired with agent-gateway (owner, 2026-10-29): the collector reads herdr, Claude's
  registry, transcripts and the human queue only. `summary.dispatch` stays on the wire as a constant `0` because Argo's
  ingest still requires the field; it goes when Argo drops it. The `agent-gateway:review` and `agent-gateway:dispatch`
  quota lanes left the pick list for the same reason (only gateway workers used them).
- **Git status is read-only except one fetch.** As in legacy each project's checkout is `git fetch --quiet --prune`d (5 s
  cap, no credential prompt) so ahead/behind is current; the status itself needs the branch, `status --porcelain`,
  `rev-list --left-right --count HEAD...@{upstream}` and the newest commit beyond the main branch (else on it).

## Hardening (review r1)

- **Children get the review helpers' allowlist.** `git`, `herdr` and `claude` run on `helperEnv` (`PATH`, `HOME`,
  `TMPDIR`, `LANG`, `LC_*`, `TERM`, `GIT_TERMINAL_PROMPT=0`, `GIT_OPTIONAL_LOCKS=0`), never the host's environment
  (`AGW_API_SECRET`, `ARGO_API_SECRET`, `IU_API_KEY`). Only `git fetch` adds `networkEnv` (`SSH_AUTH_SOCK`,
  `XDG_CONFIG_HOME`, proxy and CA variables): the one call that talks to a remote.
- **A session id is a path segment.** Only `[A-Za-z0-9_-]` reaches a transcript or pin path; anything else reads nothing.
- **Text from outside loses its control bytes**, C0 and C1 (U+0080 to U+009F), before it reaches a pane, Argo or a
  prompt. Fields that are one line by nature (ids, account, pane and workspace ids, titles, wait reasons, project, branch
  and commit text, the model's standing and blocker) also lose CR/LF. In the facts the model reads, a multi-line prompt
  or reply is one line, so it cannot forge a `- agent id:` line.
- **Keys and paths are raw, display is clean.** A session, pane, workspace or job id that cleaning would change is not an
  identity (a UUID never is): the row is dropped, or the pane or workspace id left null. `git -C` and the transcript
  path take the raw `cwd`; a `cwd` with a control byte or a line break gets no git, and the project's displayed `cwd`
  is the cleaned copy. A pane with no session (`{}`, `{ value: null }`) is a valid agent keyed by its pane.
- **The snapshot is stamped after the transcript tails are read**, so no tail line is newer than `generatedAt` (and so
  than a run's `snapshotGeneratedAt`).
- **The collectors validate shapes.** A herdr or registry row of the wrong type, a null or a scalar is dropped with one
  warning counting them, never a throw. A row without a `cwd` gets no transcript read and no `git -C ''`.
- **Bounded work:** transcript tails and per-project git run at most 8 at a time; the human queue reads the newest 200
  requests of at most 64 KiB each.
- **No sync fs on the host loop:** the human queue, the pins and the session-env logs (the last 2 MB of each of the newest
  three day files) are read async (the pin's dir check included).
- **A sparse herdr or registry row** is null-filled in `mergeAgents`, a row with no identity is skipped; `agw agents`'
  strict output never 500s on a missing field.
- **The journal keeps** the agent ids, the minimal `known` list, a SHA-256 of the facts and the verdicts: no transcript
  excerpt, no queued command. The one `classify` step takes the fresh snapshot, builds the facts, calls the seat and
  returns that; a completed step is read back on resume, never re-run. The run time is taken inside it.
- **The seat's cap:** the facts are cut to the capability's limits (400 000 characters, 500 agents), most recently active
  agents first, whole agents only; the rest are `synthesized` placeholders.
- **The Argo push goes out for `prod` runs only.** The workflow context carries no purpose, so the host reads
  `runs.purpose` of the run in the `push` step, inside the never-fatal catch: a Postgres error there does not fail the run,
  and a build or verify run pushes nothing.
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
| `XDG_STATE_HOME` | `~/.local/state` | `human-queue/` below it |

The legacy `AGENT_GATEWAY_CLAUDE_USAGE_TIMEOUT_MS`, `AGENT_GATEWAY_SESSION_ACCOUNTS_DIR` (the spawn pins only agent-gateway's workers wrote; an agent's account now comes from the `session_env` log lines alone) and the dispatch HTTP base are gone: the `claude-account` calls have a fixed 5 s cap.

## Port

`src/fleet/derive.ts`, `render.ts`, `text.ts`, `quota.ts` and the collectors in `collect.ts` are agent-gateway's
`lib/agents.ts`, `lib/render-text-utils.ts`, `lib/claude-usage.ts` and `mcp/worker-shared.ts` (picker calls) at its
`master` of 2026-10-29; the legacy cases for `deriveState`, `mergeAgents`, `parseTranscriptTail`, `renderText` (plain,
colour, `cols`, quota, human queue), `fitHeader`, the human queue, the session-account join, `mergeAccountQuota`,
`renderQuotaHeader`, `reconcileOverview` and `mergeOverviewIntoSnapshot` run unchanged in `test/fleet-*.test.ts`. Legacy
module state (the memo maps, the posted usage) is a closure per `createQuota` / `sessionAccountResolver` here, so tests
need no reset hooks.
