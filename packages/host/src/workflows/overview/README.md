# Overview (concept §10)

What every Claude Code agent on the host is doing, one recommendation each, and the Max quota beside it. The agent
state is the factory's (software-factory, the one producer of it): the overview is a client of its fleet view
(`factory fleet --format json`) and adds only the recommendations (this workflow's classify verdicts) and the quota.
`src/fleet/` holds the factory reader and its mapping, the renderer and the quota, this directory the one workflow that
spends. Section §Host reads in `packages/host/README.md` has the commands.

| Command | Does | Cost |
|-|-|-|
| `agw overview [--stale-after-hours N]` | a journaled run: one step that takes a fresh snapshot (a fresh read of the factory's fleet view) and makes one `overview.classify` call; answers `{generatedAt, model, snapshotGeneratedAt, agents[{id, sessionId, project, recommendation, standing, blocker, confidence, synthesized?}]}` and pushes the merged payload to Argo | one Haiku 5.5 call |
| `agw agents [--text] [--cols N] [--color]` | a read, no run: the snapshot merged with the newest `overview` run and the quota (`{data}`), or its render (`{text}`) | 0 |
| `agw quota` / `agw quota-report …` | the Max quota per account; the statusline's report | 0 |

## Route

`overview.classify` (`packages/routes/src/table/overview.ts`): Terra at effort low on IU's OpenAI chat wire (the `EASY` seat; Haiku 5.5 on the native Messages wire until 2026-10-30), priced at
the Terra table rate, balance fallback to DeepSeek flash. Source seat: agent-gateway's
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
- **The factory is the source.** `fleet/factory.ts` runs `factory fleet --format json` (10 s cap, `FACTORY_TOKEN` and
  `FACTORY_URL` passed to the child, nothing else of the host's environment) and parses it with a local, non-strict zod
  schema of the fields agw reads: the factory's own contract is strict on its side, a field it adds never breaks this
  client. `fleet/derive.ts` maps it onto the overview's shapes, which Argo ingests as they are:
  - `repos[]` with at least one session become `projects[]` (name, `cwd` = `space`, git); a repo with none is not listed
    (an overview is of agents). `unplaced[]` become one `unplaced` project with no directory (the view gives them none).
  - A session is an `AGENT` (`source: factory`, `id` = session id, `paneId` = terminal, `title` without its leading
    symbols, `account`, `lastReply` = the digest's headline, `lastPrompt` null, `startedAt` = `since`, `waitingFor` =
    `wait`, `herdrStatus` = hc's word, plus `plan` and `wave` for the facts).
  - State: factory `waiting`, `blocked`, `walled`, `stuck` or hc `blocked` is `needs_you`; `working`, `starting` is
    `working`; everything else is `idle`, `done` (hc `done`), or `stale` when the last activity is older than the
    threshold (`AGW_AGENT_STALE_HOURS`). A `waiting` on `workers` or a `deploy` waits on machines, not on the owner: it
    reads as idle, done or stale, never `needs_you`.
  - `humanQueue` is the asks of kind `human` (`id`, `at` as `askedAt`, `text` as `question`, `cmd` null), newest first.
    `warnings` are the factory's `errors` plus a failed read.
  - Git has no `ahead`/`behind` in the factory's view: Argo requires numbers, so they are 0, and the facts the seat reads
    say `ahead: unknown  behind: unknown`. A repo with no branch (detached) has no git.
- **A factory that is down is a warning, never a 500.** A non-zero exit, a timeout, a missing binary, output that is not
  JSON or the wrong shape: `agw agents` answers no projects, one warning naming the cause (the exit code and stderr's
  first line; exit 3 is a missing `FACTORY_TOKEN`) and the quota. The failure is not cached; the next call asks again.
- **No dispatch lane.** Dispatch retired with agent-gateway (owner, 2026-10-29). `summary.dispatch` is gone from the wire too (Argo's ingest no longer requires it). The `agent-gateway:review` and `agent-gateway:dispatch`
  quota lanes left the pick list for the same reason (only gateway workers used them).

## Hardening

- **The child gets the review helpers' allowlist.** `factory` runs on `helperEnv` (`PATH`, `HOME`, `TMPDIR`, `LANG`,
  `LC_*`, `TERM`) plus `FACTORY_TOKEN` and `FACTORY_URL`, never the host's environment (`AGW_API_SECRET`,
  `ARGO_API_SECRET`, `IU_API_KEY`). It runs in its own process group, so a timeout kills a grandchild holding the pipes.
- **Text from outside loses its control bytes**, C0 and C1 (U+0080 to U+009F), before it reaches a pane, Argo or a
  prompt. Fields that are one line by nature (ids, account, terminal, titles, wait reasons, project, branch and commit
  text, the model's standing and blocker) also lose CR/LF. In the facts the model reads, the headline is one line, so it
  cannot forge a `- agent id:` line.
- **Keys are raw, display is clean.** A session id that cleaning would change is not an identity (a UUID never is): the
  row is dropped. An id seen twice is one agent, the first stands.
- **The snapshot is stamped after the read**, so no activity time is newer than `generatedAt` (and so than a run's
  `snapshotGeneratedAt`).
- **The journal keeps** the agent ids, the minimal `known` list, a SHA-256 of the facts and the verdicts: no headline,
  no human ask. The one `classify` step takes the fresh snapshot, builds the facts, calls the seat and returns that; a
  completed step is read back on resume, never re-run. The run time is taken inside it.
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
| `FACTORY_TOKEN` | | the token `factory fleet` needs (exit 3 without it, which is the warning); `.env.tpl` resolves it. `FACTORY_URL` is passed too when set |
| `AGW_FACTORY_BIN` | `~/.local/bin/factory`, else on `PATH` | the factory CLI |
| `AGW_AGENT_STALE_HOURS` | 24 | the stale threshold (legacy `AGENT_GATEWAY_AGENT_STALE_HOURS`) |
| `AGW_CLAUDE_ACCOUNT_BIN` | `~/.local/bin/claude-account` | the Max quota's CLI (legacy `AGENT_GATEWAY_CLAUDE_ACCOUNT_BIN`) |

`AGW_HC_BIN`, `AGW_CLAUDE_BIN`, `AGW_CLAUDE_LOG_DIR` and the human-queue directory are gone with the collectors they configured (the factory reads hc, Claude's registry, the transcripts, git and the ask-human queue now). The legacy `AGENT_GATEWAY_CLAUDE_USAGE_TIMEOUT_MS` and the dispatch HTTP base are gone too: the `claude-account` calls have a fixed 5 s cap.

## Port

`src/fleet/render.ts`, `text.ts`, `quota.ts` and the pure parts of `overview.ts` are agent-gateway's `lib/render-text-utils.ts`,
`lib/claude-usage.ts` and `mcp/worker-shared.ts` (picker calls) at its `master` of 2026-10-29; the legacy cases for
`renderText` (plain, colour, `cols`, quota, human queue), `fitHeader`, `mergeAccountQuota`, `renderQuotaHeader`,
`reconcileOverview` and `mergeOverviewIntoSnapshot` run unchanged in `test/fleet-*.test.ts`. The collectors (hc,
Claude's registry, transcripts, git, the human queue) and `deriveState`/`mergeAgents` of that port are gone: the
factory is the producer, `test/fleet-factory.test.ts` covers the reader, the mapping and the Argo shape. Legacy module
state (the memo maps, the posted usage) is a closure per `createQuota` here, so tests need no reset hooks.
