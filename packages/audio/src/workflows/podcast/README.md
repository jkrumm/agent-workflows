# `podcast`: the writers' room

audio-gateway's podcast pipeline up to the locked script (research, editorial, outline, segments, lint, review,
revision, metadata), ported as one workflow of journaled steps in the audio process (concept §8). After the script it
hands off to `podcast.produce`, an internal child (synth, mastering, cover, publish, brain note) built separately; its
input type is `produce-input.ts`. Legacy: `~/SourceRoot/audio-gateway` (`src/podcasts.ts`, `src/podcast-*.ts`,
`docs/podcast-editorial-room.md`), frozen.

## Input and output

Input is legacy's `POST /v1/podcasts` body with the same clamps (`schema.ts`): `source` (≤ 200k chars, may be blank
when `sourcePaths` name notes), `sourcePaths` (≤ 20 vault paths), `brief`, `title`, `language` (`de`|`en`), `minutes`
(clamped to 3..60, default 20), `series` (blank → the default show), `publish`, `cover`, `research`, `pinMinutes`,
`brainNote`. Legacy coerced a wrong-typed flag to its default; here it is an `invalid_input`.

Output: `title`, `description`, `chapters` (with start times from the produce result), `profile` (legacy
`EpisodeProfile`, `durationSeconds` from the produce result), `cost` and `produce` (the child's output).

**Decision: cost has one source, the journal.** The `cost` step reads the step records of this run (`steps.cost`,
`steps.unpriced_calls`), of the host `research` runs it started (found by their idempotency-key prefix
`podcast:<runId>:`) and of its `podcast.produce` child (`history.ts` `postgresCosts`). Nothing is summed in memory or
carried through step outputs, so failed attempts, retries and resumed steps count as the runtime recorded them. A
request that left and came back without usage is recorded unpriced (`cost: null`), never priced at $0; a call that
never sent one records nothing. Output: `scriptUsd`, `researchUsd` (+ `researchRuns`, `researchPending`),
`produceUsd`, `totalUsd`, each with its unpriced count, and `complete`: false whenever a call was unpriced or a research
run (or a step of it) had not ended when the cost was read, so the figure is a lower bound, never an exact one. The
profile's `researchUsd` carries `researchUnpriced` beside it and is null while a research run had not ended.

## Steps

Step ids are literals; a fan-out adds its index. A **best-effort** step catches its own failure and journals its
fallback (so a resume never retries it), unless the step was aborted (cancel, lease loss, shutdown), which rethrows. A
**required** step's failure fails the run (concept §3).

| Step id | Kind | Failure | What |
|-|-|-|-|
| `house` | code | required | show bible (`show-bible.md`), the owner's voice guide (`voice.md` at the vault root), the hosts, the start time; fixed for the run |
| `source` | code | required | `source` plus the raw `sourcePaths` notes (`source.ts`); > 200k chars is `invalid_input` |
| `research` | code | best-effort → empty dossier | tool loop: `brain_search`, `brain_read`, `past_episodes`, `past_transcript`, `research` (quick depth only) |
| `history` | code | required | the last `PODCAST_HISTORY_DEPTH` (8) episodes of the series, for the editor |
| `editorial` | code | best-effort → default brief | one call: format, roles, tone, humor, length, asks, load-bearing facts |
| `research:fact:0..2` | code | best-effort | one step per load-bearing fact the editor named (duplicates once, at most 3), standard depth; answered open questions dropped |
| `outline` | code | required | one call; unrequested devices pruned, targets normalised, asks assigned; capped at 9 segments before targets and asks |
| `segment:0`..`segment:8` | code | required | three at a time; the agentic writer, the single-shot call as its fallback |
| `lint` | code | required | deterministic lint (`lint.ts`), rendered for the reviewers; its unambiguous findings become notes |
| `review:<role>:<a\|b>` | code | best-effort → no notes | dramaturge, conversation coach, fact editor on each reviewer route, all six in parallel |
| `revise:<i>` | code | best-effort → the draft stands | every segment with a note, three at a time |
| `tighten:<i>` | code | best-effort → the draft stands | segments still over length after revision |
| `metadata` | code | best-effort → the outline's drafts | title, description, cover prompt, genres, topics, chapter titles |
| `script` | code | required | the locked script (legacy `script.json`) and its profile: the transcript of `past_transcript` |
| `produce` | workflow | required | `podcast.produce` with `ProduceInput`; skipped (output `produce: null`) while no produce workflow is wired |
| `cost` | code | required | the episode's recorded cost, read from the journal |

A kill or deploy between segments resumes at the first unfinished step: finished segments replay from the journal and
are never re-run (`podcast.test.ts`). A change to a step's meaning or output shape takes a new step id.

## Models and wires

Every model id is in the route table (`packages/routes/src/table/podcast.ts`; `AGW_ROUTES` applies, resolved per
call): `podcast.research`, `podcast.editorial`, `podcast.outline`,
`podcast.write`, `podcast.review.a`, `podcast.review.b`, `podcast.metadata`. Defaults are legacy's: the cheap seat at
effort high for research, editorial, outline and metadata; Gemini flash and the cheap seat as reviewers; the GPT-6.1
Sol writer at effort high. The writer's rollback is one table line to the Opus 5.5 entry on `iu-anthropic` (the
comment in the table file). Effort is the route's: a route without one sends none (the Gemini reviewer).

**Decision: an own model port (`llm.ts`, `iu.ts`) instead of the platform transports.** The capabilities transports are
single-call text wires; the room needs function tools on both OpenAI APIs (chat completions, and `/v1/responses`,
which IU requires for the GPT-6.1 family's tools), and on the Anthropic wire a cached system block and a response
schema. The port keeps the platform's conventions: IU credentials from `IU_API_KEY` / `IU_BASE_URL`, every call priced
against its route (`costFromUsage`: IU's `usage.cost` first, else the route's rate) and reported to the step's
`addUsage`, so the run record carries every call, failed ones included; a provider-balance failure moves the call once
to the route's fallback (concept v3.3); streaming with an idle watchdog for single answers, a 30-minute hang guard on a
non-streamed tool round (rules/agent-limits.md); a stalled stream or a fired hang guard is terminal, never retried
(the wait is spent and the abandoned request may still bill). Agent loops journal counters only (rounds, rejections,
tool calls per tool, fell back), never the tool arguments (whole segment drafts). No transport file changed.

Ported specifics: the tool loop echoes the assistant message exactly as received (provider state such as reasoning
or Gemini's `thought_signature` must round-trip), appends tool results and never rewrites the head; a round cut at its
budget or empty retries once at double; no round cap. On the Anthropic wire: adaptive thinking with
`output_config.effort`, `max_tokens` floored at 32k (thinking counts against it), the segment schema as
`output_config.format`, and the episode-constant system prefix as an ephemeral cache block.

### Token and cache effect

- The tool loops (research, the agentic writer) append and never edit, so every round's prompt is the previous
  round's prompt plus new messages: the provider's automatic prefix cache hits on all but the new tail. Cache reads are
  recorded per call (`tokens.cacheRead`) and priced at the route's cache rate.
- On the Anthropic rollback writer, the base system prompt (house rules, show bible, voice guide, the brief) is
  identical across an episode's segment and revision calls and is sent as its own `cache_control: ephemeral` block:
  after the first call, repeat calls read it at 0.05x input price within the 5-minute TTL (refreshed on every hit).
  A prefix that does not lead the system prompt is sent uncached with a warning.
- Budgets are legacy's (`writerBudget`): visible tokens plus 16k reasoning headroom, doubled on retry, at most 64k.

## Tools, memory, research

- **Vault, agent side**: `brain_search` / `brain_read` go through the platform's vault capabilities in-process
  (`brain.ts`): only `wiki/`, `Areas/` and `Projects/`, no dotfiles, real path inside the vault.
- **Vault, source side** (decision): `sourcePaths` keep legacy's contract, read by the podcast's own reader
  (`source.ts`): any non-hidden `.md` inside the vault (an `Inbox/` draft included), symlink-safe, the path
  NFC-normalised, raw with frontmatter. The rule holds for the symlink's target as well as the name asked for. The source is the owner's choice of notes, the agent's reads are the model's,
  so only the agent gets the narrower allowlist. A note above 200k characters fails the run; nothing is cut silently.
- **Memory** (`history.ts`): finished `podcast` runs of purpose `prod` (title, description, profile from the run's
  output, the transcript from its `script` step) plus the legacy episodes in `podcast_episodes` (runtime migration
  0010), imported once by `scripts/import-podcast-history.ts` (dry run by default; `--commit` writes). Only done legacy
  jobs are imported: 19 of the 20 recorded jobs (one failed before mastering).
- **Research**: the `research` tool runs the host's `research` workflow over its HTTP API (`research-client.ts`,
  `AGW_URL` and `AGW_API_SECRET` from the process env), quick depth only, identical queries answered once, the optional
  `PODCAST_RESEARCH_MAX_CALLS` valve as on legacy. Standard depth runs only for the editor's load-bearing facts, one
  step each (a fact the quick pass already asked still runs at standard depth, as on legacy: the editor names a fact
  because the quick answer was too thin). Every host run starts under an idempotency key
  `podcast:<runId>:<stepId>:<hash of depth and query>`; a transient error while starting or waiting retries the same
  request. The host keeps a key's run for good (a repeat of the key gets that run, ended or going), so: a resumed or
  retried step re-attaches to the run it already paid for; only a cancel of the podcast run cancels the host run (a
  shutdown, a lease loss or a step timeout leaves it going for the resume); a question whose run ended failed or
  cancelled runs once more under `<key>:2` (the host's attempt-key convention) and no more. Which runs a step already
  started is read from the journal at the step's start, so the `PODCAST_RESEARCH_MAX_CALLS` valve and the repeat rule
  hold across attempts, not per attempt. An unknown run status fails the call rather than polling on.

**Privacy.** As on legacy, the notes the room reads (the source, `sourcePaths`, brain reads) go to the research,
editorial, writer and reviewer models: they are the episode's source. The voice guide is journaled in the `house` step.
Every tool result and tool error that carries outside text (vault notes and search hits, past episodes and
transcripts, research reports, host and vault errors), and the research loop's SOURCE, reach the model inside an
untrusted-data fence with a per-loop random token (`fence.ts`), and the loop's
system prompt says what the fence means and forbids copying private note content into research queries: a note that
reads like an instruction cannot steer the agent into reading other notes and sending them out.

## Configuration

| Variable | Default | |
|-|-|-|
| `PODCAST_HOST_NAMES` / `PODCAST_VOICES` / `PODCAST_SPEEDS` | `Jonas,Lena` / `Charon,Erinome` / `0.94,1` | the two hosts in speaker order |
| `PODCAST_HISTORY_DEPTH` | 8 | episodes shown to the editor |
| `PODCAST_RESEARCH_MAX_CALLS` | 0 (none) | valve on research runs per episode |
| `PODCAST_AGENTIC_WRITER` | `on` | `off`: the single-shot writer only |
| `PODCAST_MULTISPEAKER_MAX_CHARS` | 3000 | synth unit size the writer measures against |
| `AGW_BRAIN_DIR` | `~/SourceRoot/brain` | the vault (`voice.md` at its root) |

## Registration

`module.ts` registers the workflow in the audio process's tree (host `workflows/registry.ts`, discovered by directory).
Beyond `HostDeps` the process passes `journal: { db, schema }` (its journal pool) for the show's memory and the cost
step; the module fails at build without it. It is a `last`-phase module so it picks `podcast.produce` up from the
modules built before it when one is registered; neither imports the other. Research runs carry purpose `prod`.

## Validation

- `bun test packages/audio/src/workflows/podcast`: the room on a fake transport (`testing.ts`), resume after a kill,
  fallbacks, clamps, history on Postgres, plus the legacy unit cases ported.
- `bun scripts/eval-legacy/podcast-lint.ts`: the ported lint against legacy's own on the recorded scripts (rule 1 of
  `docs/research/2026-10-29-wave8-ports.md` §podcast), and the rule-6 baseline (findings per 10 turns).
