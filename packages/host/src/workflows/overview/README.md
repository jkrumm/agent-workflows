# Overview (concept §10)

What every Claude Code agent on the host is doing, one recommendation each, and the Max quota beside it. The agent
state is the factory's (software-factory, the one producer of it): the overview is a client of its /v1 read API
(`factory read overview` and `factory read sessions --live`) and adds only the recommendations (this workflow's classify verdicts) and the quota.
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
- **The factory is the source.** `fleet/factory.ts` runs `factory read overview` and `factory read sessions --live` in parallel (10 s cap each, `FACTORY_TOKEN` and
  `FACTORY_URL` passed to the child, nothing else of the host's environment) and parses them with local, non-strict zod
  schemas of the fields agw reads (/v1 only ever adds fields). Sessions are grouped by their herdr space, else their
  repo path; the read API has no git facts (`git` is null) and no hc word. `fleet/derive.ts` maps it onto the overview's shapes, which Argo ingests as they are:
  - `repos[]` with at least one session become `projects[]` (name, `cwd` = `space`, git null); a repo with none is not listed
    (an overview is of agents). `unplaced[]` become one `unplaced` project with no directory (the view gives them none).
  - A session is an `AGENT` (`source: factory`, `id` = session id, `paneId` = terminal, `title` without its leading
    symbols, `account`, `lastReply` = the digest's headline, `lastPrompt` null, `startedAt` = `since`, `waitingFor` =
    `wait`, `herdrStatus`, `plan` and `wave` null: the read API carries none of them).
  - State: the factory states `waiting`, `blocked`, `walled` and `stuck`, except a `waiting` on `workers` or a `deploy`, which waits on machines
    and reads as idle, done or stale. `working`, `starting` is `working`; the rest of the idle family is `idle`, `done`
    (unreachable without hc's word), or `stale` when the last activity is older than the threshold (`AGW_AGENT_STALE_HOURS`). A state the
    factory adds that agw does not know is `unknown` for that one session (the parse takes `state` as a string), never a
    failure of the fleet.
  - `humanQueue` is the asks of kind `human` (`id`, `at` as `askedAt`, `text` as `question`, `cmd` null), newest first.
    `warnings` are a failed read (the read API has no `errors`).
  - The read API has no git facts, so every project's `git` is null.
- **A factory that is down is a warning, never a 500.** A non-zero exit, a timeout, a missing binary, output that is not
  JSON or the wrong shape (`sessions` is required: `{}` is not an empty session list; one of the two reads failing fails the whole read): `agw agents` answers no projects, one
  warning naming the cause (the exit code and stderr's first line; exit 3 is a missing `FACTORY_TOKEN`) and the quota.
  The failure is not cached; the next call asks again. Because an empty answer is not an empty fleet, the two writers
  act on the read's outcome (`Fleet.read`, `view().unreadable`): the Argo push is skipped with a warn-level log naming
  the cause (Argo keeps its last good snapshot instead of receiving zero agents), and the `overview` run fails its
  `classify` step with the cause, so no verdict is reconciled against nothing. The `push` effect stays non-fatal, but a failure there is logged at warn with the run id.
- **Dropped sessions are counted.** A session whose id cleaning would change, and one whose id was already seen, are
  skipped; each kind is one warning with its count.
- **No dispatch lane.** Dispatch retired with agent-gateway (owner, 2026-10-29). `summary.dispatch` is gone from the wire too (Argo's ingest no longer requires it). The `agent-gateway:review` and `agent-gateway:dispatch`
  quota lanes left the pick list for the same reason (only gateway workers used them).

## Hardening

- **The child gets the review helpers' allowlist.** `factory` runs on `helperEnv` (`PATH`, `HOME`, `TMPDIR`, `LANG`,
  `LC_*`, `TERM`) plus `FACTORY_TOKEN` and `FACTORY_URL`, never the host's environment (`AGW_API_SECRET`,
  `ARGO_API_SECRET`, `IU_API_KEY`). It runs in its own process group, so a timeout kills a grandchild holding the pipes. Its stdout and stderr are counted
  per chunk through one capped reader: 16 MiB for stdout (the real view is about 140 KB), 64 KB for stderr; past a budget
  the child is killed, never buffered whole, and a stderr keeps its capped diagnostic. The warning's stderr line is one
  clean line of at most 300 characters.
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
| `AGW_ARGO_PUSH` | on | `0`, `off`, `false` or `no` turns the ten-minute timers off (tests; both pushes below); the push after a run stays |
| `FACTORY_TOKEN` | | the token `factory read` needs (exit 3 without it, which is the warning); `.env.tpl` resolves it. `FACTORY_URL` is passed too when set |
| `AGW_FACTORY_BIN` | `~/.local/bin/factory`, else on `PATH` | the factory CLI |
| `AGW_AGENT_STALE_HOURS` | 24 | the stale threshold (legacy `AGENT_GATEWAY_AGENT_STALE_HOURS`) |
| `AGW_CLAUDE_ACCOUNT_BIN` | `~/.local/bin/claude-account` | the Max quota's CLI (legacy `AGENT_GATEWAY_CLAUDE_ACCOUNT_BIN`) |

The host makes two pushes through one transport (`fleet/argo.ts`: https or loopback http, bearer `ARGO_API_SECRET`, no redirect, 15 s timeout, off without URL and secret):

| Endpoint (under `ARGO_URL`) | Cadence | Body |
|-|-|-|
| `/agents/overview` | after each `overview` run and every 10 min | the `agw agents` payload plus `machine` |
| `/agents/review-stats` | every 10 min and after each `agw review submit` | `{machine, generatedAt, source, weeks, byPrompt}`: the last 12 ISO weeks by tier and all-time by prompt (`src/review/README.md` §Stats); a 404 or any non-2xx is one warn line, never a failure |

`AGW_HC_BIN`, `AGW_CLAUDE_BIN`, `AGW_CLAUDE_LOG_DIR` and the human-queue directory are gone with the collectors they configured (the factory reads hc, Claude's registry, the transcripts, git and the ask-human queue now). The legacy `AGENT_GATEWAY_CLAUDE_USAGE_TIMEOUT_MS` and the dispatch HTTP base are gone too: the `claude-account` calls have a fixed 5 s cap.

## Port

`src/fleet/render.ts`, `text.ts`, `quota.ts` and the pure parts of `overview.ts` are agent-gateway's `lib/render-text-utils.ts`,
`lib/claude-usage.ts` and `mcp/worker-shared.ts` (picker calls) at its `master` of 2026-10-29; the legacy cases for
`renderText` (plain, colour, `cols`, quota, human queue), `fitHeader`, `mergeAccountQuota`, `renderQuotaHeader`,
`reconcileOverview` and `mergeOverviewIntoSnapshot` run unchanged in `test/fleet-*.test.ts`. The collectors (hc,
Claude's registry, transcripts, git, the human queue) and `deriveState`/`mergeAgents` of that port are gone: the
factory is the producer, `test/fleet-factory.test.ts` covers the reader, the mapping and the Argo shape. Legacy module
state (the memo maps, the posted usage) is a closure per `createQuota` here, so tests need no reset hooks.

## Eval

`eval/cases.jsonl` holds 6 synthetic fleets (placeholder project names, no real session text) as `PlainCase` lines: the input is
the eval-only `fixture` (`generatedAt` and `projects` in the snapshot's shape; an agent needs an `id`, a `state` and what
the seat reads, everything else defaults to null). With a fixture the step classifies it instead of calling `fleet.read`,
and the Argo push is skipped whatever the run's purpose; without one the workflow is unchanged. A fixture is refused (`invalid_input`, naming the purpose) for any run whose purpose is not `eval`, so a hand-started prod run can never write fabricated results where callers read real ones. The reference is the
expected `recommendation` per agent id (a list accepts any of its values).

The scorer (`scorer.ts`, deterministic, no model judge) scores `valid` (every agent of the fixture exactly once, no other),
`answered` (not the `synthesized` placeholder) and `match` (share of agents with the expected recommendation); `pass` needs all
three at 1. Cases: a blocked and a working agent, unshipped work and a pushed branch, a finished and an abandoned agent, an injection
planted in a reply, a mid-task and an unclear agent, and a three-project fleet. The module declares the suite (`agw eval run overview`), also on a host with no fleet, where the workflow is not served and a run fails at start.
