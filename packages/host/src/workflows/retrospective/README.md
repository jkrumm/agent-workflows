# Retrospective and learnings (concept §7)

**`agw retrospective <workflow>`** (`src/workflows/retrospective/`) looks back on one workflow that runs agents.
Input: `workflow`, `window` (days, default 7), `sample` (runs, default 20), `fileIssues` (default false).

| Step | Does |
|-|-|
| `sample` | Finished (`done`/`failed`) top-level runs of the workflow inside the window, `purpose <> 'eval'`, failed runs first, then a stable spread by id hash. Reads outcome, wall time, cost, tool calls, `friction` (null until `w5/friction` fills it; tolerated), and per step: kind, status, model, error, a 1 200-character output preview. **Never the run input** (it holds working directories and diffs) |
| `analyze` | One agent step (`agents/retrospective/`, route `retro.analyze`, a copy of `check`'s model and wire, no tools, edit denied) over the sample rendered as text (at most 120k characters; step previews shrink 600 → 300 → 120 → none before runs are cut; absolute paths become `<path>`). One JSON-only retry on invalid output, then the run fails |
| `store-learnings` | Candidate facts are stored as **`proposed`**, never active |
| `file-issues` | Only with `fileIssues: true`. Per proposal: filter, find an issue with the same title, else create one |

Output (typed): `proposals[]` (kind `capability | agents-md | skill | cli`, target, title, change, evidence run ids,
confidence), `learnings[]` (agent, fact, evidence, stored id), `issues[]` (title, `filed | duplicate | refused`, url or reason)
and `dropped[]`. Before anything is stored or filed the answer is checked in code: evidence must be run ids that were in the
sample, a learning must name an agent the workflow runs, a target must be an agent, an `agw` command or a path in this repo;
the rest is dropped with its reason, never repaired. Proposals are never applied.

**Issues and the public repo** (`issue.ts`, `tracked.ts`, `gh.ts`). Public by construction, not by filtering: an issue is
built from structured fields only: kind, **target** (must be a path tracked in this repo: a file, a directory holding
tracked files, or an agent name standing for `agents/<name>`), confidence, evidence run ids and a fixed line pointing at
`agw run status <retroRunId>`. The model's free text (`change`, `title`, facts) never goes into an issue; it stays in the run
output (the private journal). A proposal whose target is not tracked is `refused` (it still appears in the output). *What is
tracked:* a release is a `git archive` of the commit plus `node_modules` (`scripts/deploy.sh`), so the release tree minus
`node_modules` is the tracked list; a dev checkout asks `git ls-files`. Read once per process, on the first filing. The same
function builds the title (`retro(<workflow>): <kind> change for <path> [<hash8>]`) and a marker
`<!-- agw-retro:<sha256(kind + target + normalised change), first 16 hex> -->` (case and whitespace of the change do not
matter). **Dedupe** searches the marker (`gh issue list --state all --search '"agw-retro:<hash>" in:body'`) and verifies it
against the issue's own body; two proposals with one hash in a run collapse. **Known window:** GitHub's search index lags a
new issue by seconds to minutes, so a second run in that window can file a duplicate; the weekly cadence and the retry bound
keep that rare, and no lock closes it. Without `AGW_RETRO_FILE_ISSUES` the port is never called. The agent's *prompt* data is
still scrubbed (`scrub.ts`: absolute paths of any shape, `~/…`, Windows drive paths, single-segment paths like `/tmp`, token-shaped
strings), as hygiene for what the model sees, not as a boundary.

**Weekly schedule** (`schedule.ts`, `boot.ts`). An hourly tick (and one at start) asks the journal which agent workflows had
finished non-eval runs in the last 7 days and starts one `retrospective` per workflow with the idempotency key
`retro:<workflow>:<ISO week>` (purpose `retro`). A week whose runs have **all failed** is retried under
`<key>:retry-<n>` (at most 3 per week, a lifecycle bound on re-starts and not a cap on the agent; a running, done or
cancelled run of the week stands, so a retry never doubles one). The `(workflow, idempotency_key)` constraint makes it once per workflow and
week however often it ticks or the host restarts; the first tick of a new week starts it, so a host down on Monday catches up.
Flipping `fileIssues` mid-week hits the same key with another input: that week's run stands (no error, no second run).

**`agw learnings list|add|activate|retire`** (`src/learnings/`). Per-agent facts in `<schema>.learnings`
(migration `0005_learnings.sql`: agent, fact, source = run id or `manual`, evidence, status `proposed | active | retired`,
`created_at`, `activated_at`, `retired_at`; one row per fact and agent, **retired rows included**: a retired fact is a rejected
one and a retrospective never proposes it again (the add returns the retired row). A human brings it back with
`agw learnings add` (source `manual`), which reuses the row. A fact containing the learned-facts fence tag is refused on add and
on activate and skipped when rendering). Decision: each command is a
one-step workflow rather than a new operation kind, so it appears in the generated CLI through the existing workflow path,
carries the platform contract and leaves a run record of who changed what; the cost is a journal row per command.
`add` proposes (`--activate` for the human path), `activate` makes a proposed fact live, `retire` ends any fact.

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
