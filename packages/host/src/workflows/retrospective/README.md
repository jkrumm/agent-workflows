# Retrospective and learnings (concept §7)

**`agw retrospective <workflow>`** (`src/workflows/retrospective/`) looks back on one workflow that runs agents.
Input: `workflow`, `window` (days, default 7), `sample` (runs, default 20), `fileSignals` (default false; the weekly schedule sets it, `AGW_RETRO_SIGNALS`).

| Step | Does |
|-|-|
| `sample` | Finished (`done`/`failed`) top-level runs of the workflow inside the window, `purpose <> 'eval'`, failed runs first, then a stable spread by id hash. Reads outcome, wall time, cost, tool calls, `friction` (null until `w5/friction` fills it; tolerated), and per step: kind, status, model, error, a 1 200-character output preview and the **tools by name** (count, failures, calls repeating an earlier call's exact arguments) where the host recorded them: only `research_tool_calls` exists, so a research step lists its tools and every other step shows just its tool-call count (the agent's instructions say so: a shape is never inferred from a count) **Never the run input** (it holds working directories and diffs) |
| `analyze` | One agent step (`agents/retrospective/`, route `retro.analyze`, a copy of `check`'s model and wire, no tools, edit denied) over the sample rendered as text (at most 120k characters; step previews shrink 600 → 300 → 120 → none before runs are cut; absolute paths become `<path>`). A JSON step: the answer comes back through the host's `submit_result` tool; one retry (`SUBMIT_RESULT_RETRY`) on invalid output, then the run fails |
| `record-learnings` | Candidate facts are stored as **`proposed`**; a fact already on file (same words, or worded alike) is a sighting of it, not a second row. The learnings rule below can activate it |
| `tidy-learnings` | The learnings rule applied to everything on file (folds duplicates, activates, retires the stale); the ids it touched are in the output |
| `file-signals` | Only with `fileSignals: true` and no fixture. Proposals ranked by cited runs (then confidence), the first **3** filed as factory signals, the rest `capped` |

Output (typed): `proposals[]` (kind `capability | agents-md | skill | cli`, target, title, change, evidence run ids,
confidence), `learnings[]` (agent, fact, evidence, learning id, `outcome` `new | repeat | activated | known`), `tidy` (merged, activated ids, retired ids),
`signals[]` (title, `filed | duplicate | refused | capped | failed`, reason) and `dropped[]`. Before anything is stored or filed the answer is checked in code: evidence must be run ids that were in the
sample, a learning must name an agent the workflow runs, a target must be an agent, an `agw` command or a path in this repo;
the rest is dropped with its reason, never repaired. Proposals are never applied.

**Signals and the public repo** (`signal.ts`, `signals.ts`, `tracked.ts`). A proposal leaves as a **factory signal**
(`factory signal file --from agent:agent-workflows --repo agent-workflows --title … --text …`): triage dedupes it and makes the
Issue, because a lead cannot file one itself. At most **3 per run** (`MAX_SIGNALS_PER_RUN`), most cited runs first, then
confidence, then the agent's order; a failed filing is reported in the output (`failed`) and never fails the run. Public by
construction, not by filtering: a signal is built from structured fields only: kind, **target** (must be a path tracked in
this repo: a file, a directory holding tracked files, or an agent name standing for `agents/<name>`), confidence, the evidence
**run ids and their count** (`3 of 20 sampled runs`), a marker `agw-retro:<sha256(kind + target + normalised change), first 16 hex>`
(case and whitespace of the change do not matter; the same proposal next week carries the same marker) and a fixed line
pointing at `agw run status <retroRunId>`. The model's free text (`change`, `title`, facts) never goes into a signal; it stays in
the run output (the private journal). A proposal whose target is not tracked is `refused` (it still appears in the output).
*What is tracked:* a release is a `git archive` of the commit plus `node_modules` (`scripts/deploy.sh`), so the release tree
minus `node_modules` is the tracked list; a dev checkout asks `git ls-files`. Read once per process, on the first filing. A
fixture (eval) run files nothing. The agent's *prompt* data is still scrubbed (`scrub.ts`: absolute paths of any shape, `~/…`,
Windows drive paths, single-segment paths like `/tmp`, token-shaped strings), as hygiene for what the model sees, not as a
boundary. Off with `AGW_RETRO_SIGNALS=0` (the CLI never files unless `--file-signals`).

**Weekly schedule** (`schedule.ts`, `boot.ts`). An hourly tick (and one at start) asks the journal which agent workflows had
finished non-eval runs in the last 7 days and starts one `retrospective` per workflow with the idempotency key
`retro:<workflow>:<ISO week>` (purpose `retro`). A week whose runs have **all failed** is retried under
`<key>:retry-<n>` (at most 3 per week, a lifecycle bound on re-starts and not a cap on the agent; a running, done or
cancelled run of the week stands, so a retry never doubles one). The `(workflow, idempotency_key)` constraint makes it once per workflow and
week however often it ticks or the host restarts; the first tick of a new week starts it, so a host down on Monday catches up.
Flipping `fileSignals` mid-week hits the same key with another input: that week's run stands (no error, no second run).

**`agw learnings list|add|activate|retire|tidy`** (`src/learnings/`). Per-agent facts in `<schema>.learnings`
(migrations `0005_learnings.sql`, `0022_learnings_sightings.sql`: agent, fact, source = first run id or `manual`, `sources` = every
run that proposed it, `weeks` = their ISO weeks, `last_seen_at`, evidence, status `proposed | active | retired`, `created_at`,
`activated_at`, `retired_at`). A fact containing the learned-facts fence tag is refused on add and on activate and skipped when
rendering. Each command is a one-step workflow, so it appears in the generated CLI, carries the platform contract and leaves a
run record of who changed what; the cost is a journal row per command.

**The rule** (`store.ts`, `similarity.ts`; the README of record):

| Situation | Result |
|-|-|
| A run proposes a fact **worded like** one of the agent's rows (shared content words: at least 3, Jaccard ≥ 0.22 and ≥ 0.4 of the shorter fact) | Not stored twice: a **sighting** (the run joins `sources`, its week joins `weeks`, evidence merges). Matching is by words, not meaning, so a restatement with other words is a second row until `tidy` or a later sighting joins them |
| Seen by **two independent runs in two different ISO weeks** (`ACTIVATE_AFTER_WEEKS`) | `proposed` → **`active`**, automatically; read back from the agent's next run. The same run again (a resumed step) or a second run in the same week changes nothing |
| A proposed fact a retrospective made and nothing saw again for **4 weeks** (`RETIRE_AFTER_WEEKS`) | **`retired`** |
| A **retired** fact (a rejected one) | Never proposed again; the add returns the retired row. A human brings it back with `agw learnings add` (source `manual`) |
| A human's `agw learnings add` | Exact-text match only (as before); a human's proposal never ages out |

`agw learnings tidy` applies the rule to what is on file: proposed rows worded alike fold into the oldest (sources, weeks and
evidence kept, the duplicates deleted), facts in two weeks by two runs activate, stale ones retire. The weekly retrospective
runs it after storing its own facts (`tidy-learnings`), so the rule needs no other schedule.

**Read-back.** `RuntimeOptions.agentPrompt` (runtime, additive) lets the host append to an agent step's task message right
before the session is opened or prompted (not on a re-attach to a prompted session). The host appends the agent's active facts
(the 25 most recently *activated*, in activation order, so a late activation of an old fact is not lost) as a fenced
`<learned_facts>` block after the task and before the step's `tail` (a retry directive such as "answer with JSON only",
which `AgentSpec.tail` keeps last; the retrospective uses it, `check` and `review` still append theirs to the prompt and could
adopt it); with no active facts the message is unchanged. A
lookup failure is logged and the plain task is sent. `withLearningsFingerprint` wraps the fingerprint source: an agent with
active facts gets a `learnings/active` pseudo-file holding the digest of its set, so activate and retire change the fingerprint
of every workflow that runs the agent, and an agent without facts keeps the fingerprint it has today. The fingerprint is read at
admission and the facts at the step's prompt, so a fact changed during a run shows in that run's output but in the next run's
fingerprint (a window of minutes). Retire takes effect on the next run.

## Route

Model and rate: `packages/routes/src/table/retrospective.ts` (the only home of model ids). Source seat: agent-gateway
`GET /api/routing`, 2026-10-27, unless noted.

| Route | Source seat | Wire |
|-|-|-|
| `retro.analyze` | none (new; copied from `check`, concept §7) | opencode |

Token effect: one Terra-medium agent step on `retro.analyze`'s model and wire, no new cache group beyond its own agent.

## Token effect / cache effect

The learnings read-back adds tokens only where a fact is active: the fenced block is appended **after the task message**, never
into `AGENTS.md`, so the agent's cached prefix (system prompt, skills) is untouched; the block costs its own tokens
(at most 25 facts of at most 400 characters, in practice a few hundred) on every step of that agent, and a changed fact set
changes the message tail only. Activating or retiring a fact changes the run fingerprint (one new fingerprint group, no
cold prompt cache: the prefix is unchanged). The retrospective is its own spend: one Terra-medium agent step per workflow and week
over at most ~30k input tokens of sampled records, no tools, plus at most one JSON retry; nothing runs when a workflow had no runs.

## Eval

`eval/cases.jsonl` holds 5 cases of made-up journal runs. The input is the eval-only `fixture` (`runs`, in the shape
`sample.ts` reads from the journal, with what a run leaves out defaulting to null). With a fixture the sample step returns
those runs instead of reading Postgres, no learning is stored (`learningId` is null), the learnings rule does not run and no signal is filed even with
`fileSignals`; without one the workflow is unchanged. A fixture is refused (`invalid_input`, naming the purpose) for any run whose purpose is not `eval`, so a hand-started prod run can never write fabricated results where callers read real ones. `workflow` must still be one that runs agents (the cases use `check` and `review`).

Cases: five failed runs that reinstall dependencies until the idle timeout, four reviews that pass an option the CLI lacks,
five reviews that rebuild the same diff-parsing script, a healthy sample (the right answer is none or one proposal) and a
failed run whose error text tries to steer the analysis beside a real pattern. The reference lists planted patterns (the runs
that show them, words of the pattern, the kinds that fit), a proposal limit and a canary.

The scorer (`scorer.ts`, deterministic, no model judge) scores `valid` (the output parses, `sampled` is the fixture's size),
`grounded` (every item cites a run of the sample), `found` (share of planted patterns a proposal of a fitting kind, or a
learning, cites and names), `restraint` (at most `maxProposals`), `clean` (no canary, URL or absolute path) and
`undropped` (the share the host kept; reported, not gated). The module declares the suite (`agw eval run retrospective`), also on a host with no database, where the workflow is not served and a run fails at start.
