# review

`agw review --cwd <dir> [--scope …] [--pr N] [--branch b] [--depth …] [--context …]`: multi-angle code review of a diff, one
verdict. A port of agent-gateway's `review` (`server/jobs/handlers/review.ts` `runReview`, prompts `server/skills/review/*.md`):
the behaviour is carried over, the code is written against this runtime. The output is the legacy `REVIEW_OUTPUT` v2,
so today's callers read it unchanged: `{ schemaVersion: 2, outcome, blocking[], improvements[], discussions[], testGaps,
escalationCategory?, summary, degraded? }`, findings `{ file, line?, message, angle }`. `degraded` is additive and
`schemaVersion` stays 2: it is absent on every review that ran.

Input (strict): `cwd` (absolute path of a git work tree; anything else fails the run as `invalid_input`), `scope?`
(`uncommitted` default, `head`, a ref, a range or a file path), `pr?`, `branch?` (mutually exclusive, and exclusive with
`scope`), `depth?` (`light|standard|deep`), `context?`, `angles?`.

## Steps

Step ids are literals (`runtime/test/step-id-literal.test.ts`); the angle fan-out is a table with one literal id per angle.

| Step | Kind | What it does (legacy ref) |
|-|-|-|
| `prepare` | code | Validates `cwd` and the scope against the machine; for `pr`/`branch` makes the throwaway clone; gathers the diff, the changed files (untracked ones included for `uncommitted`), `package.json` and fallow's brief (60 s helper timeout). An empty diff ends the run `clean` here (`:1243`). The env switches are read here, so a resumed run decides the same way |
| `react-doctor` | code | The pinned, diff-scoped, advisory React scan, as legacy runs it (`server/lib/react-doctor.ts`). Starts at once and is awaited at synthesis, so it hides behind the router and the angles. A failure is named in the synthesis block, never read as "found nothing" |
| `adversary` | code | Capability `review.adversary`: one non-agentic call on route `review.adversary` (medium effort, one retry at low on an empty answer, diff capped at 200K chars), the cross-family critic (`:928`). Any failure becomes a `(review pipeline)` discussion; the review completes. `AGW_REVIEW_ADVERSARY=false` turns it off |
| `route` | code | Capability `review.route` on route `review.router` (prompt `agents/review-router`): extra angles plus a depth. Skipped when the caller passes `angles`. A failure adds no angles and no depth (`:869`) |
| `plan` | code | Records the decision in the run record: effective depth and where it came from, the angle set, whether the router failed, why OCR runs or not |
| `angle:<name>` | agent | One per angle, at most 3 in flight, each retried once, agent `review-<angle>` on route `review.angle`, output schema legacy `ANGLE_OUTPUT` (`:362`). The agent reads the repository through `spec.options.allowDirectories: [repo]`; the session policy is deny by default, so the angle has `read`, `glob`, `grep` and `skill` and nothing else |
| `ocr` | child workflow | the internal `review.ocr` workflow, see below |
| `synthesis`, `synthesis-retry` | agent | `review-synthesis` on route `review.synthesis`, the legacy placeholders `[ANGLE_RESULTS]`, `[FALLOW_RESULTS]`, `[REACT_DOCTOR_RESULTS]`, `[OCR_RESULTS]` filled in one pass (a `$&` in a finding stays literal). The answer comes back as text and is parsed here: invalid JSON → one retry (`synthesis-retry`) with the JSON-only suffix → the salvaged `needs-human` / `blocker` verdict that keeps the raw text (`:1636-1744`) |
| `cleanup` | effect | Removes the throwaway clone (`pr`/`branch` only), in a `finally`. A cancelled or crashed run skips it; the next `prepare` sweeps clones older than a day |

### Depth and angles (`:954-974`)

Depth: the caller's, else the router's, else `standard`. Gating is on by default (`AGW_REVIEW_DEPTH_GATING=0` turns it off).

| Depth | Angles | OCR |
|-|-|-|
| `light` | senior-dev + the router's angles + adversary | off |
| `standard` | floor + the router's angles + adversary | off |
| `deep` | floor + the router's angles + adversary | on, ≥ 100 changed lines |

The floor (`selectAgents`, `:778`): architect and senior-dev always; frontend for `.tsx/.jsx/.css`; backend for `.ts` under
`api/` or `server/`; typescript for `.ts/.tsx`; qa when `package.json` has a `test` script. At most 8 angles; the floor is
kept first. Explicit `angles` keep architect and senior-dev, drop unknown names, skip the router and are not gated by
depth (the depth then only decides OCR).

### The verdict is code (`:270-326`)

The synthesis agent proposes; code decides. Any failed reviewer (an angle that failed twice, the adversary) or any
discussion → `needs-human`; else any blocking finding → `actionable`; else `clean`. A failed reviewer always adds its
`(review pipeline)` discussion and a "Partial review" lead, with `escalationCategory: blocker` unless the model named an
owner reason. Improvements are capped at 5 (the rest is counted in the summary). All reviewers failed → `needs-human` /
`blocker` without a synthesis. A near-miss escalation category (`Data Loss`) is coerced, an unknown one dropped.

### `pr` and `branch`

`git clone --shared --no-checkout <cwd>` into `<stateDir>/review-clones/<hash of the prepare step key>`, `origin` re-pointed
at `cwd`'s own origin, `pull/N/head` (or `refs/heads/<branch>`) and the default branch's tip fetched there, the head
checked out detached. The diff is `<default tip>...HEAD`. `cwd` is only read: nothing is fetched into it, and its HEAD,
index, refs and worktrees are untouched (`test/review.test.ts`). Agents get the clone as their `allowDirectories`, so
they read the PR as it is, not whatever `cwd` has checked out.

### OCR: the `review.ocr` workflow

A child workflow with `optionalExpensive: true`. The wallet gate (`@agent-workflows/limits`) refuses it at admission while
IU 30-day spend is ≥ $400 or before 2026-11-02; that replaces legacy's date pause and spend gate. The parent keeps the
other gates (`ocr.ts:489-501` and the scope checks): depth `deep`, ≥ 100 changed lines (`AGW_REVIEW_OCR_MIN_LINES`), `ocr`
on PATH, IU credentials in the environment, a scope `ocr` has a mode for (not a file path), `AGW_REVIEW_OCR != 0`. A child
the runtime refuses or fails comes back from `ctx.workflow` as `null` (a refused admission ends the child `failed` /
`admission_refused`); the parent then writes "OpenCodeReview: skipped (…)" into the synthesis and goes on. Its liveness is
the step's idle watchdog (five minutes without output), never a wall-clock cap. Usage is recorded with an unknown price.
It is `internal` (`HostWorkflow.internal`): registered with the runtime, so the parent's `ctx.workflow` and a resume
find it, but never an HTTP route, a CLI command or an `agw schema` entry, so `review.ocr` does not collide with
`agw review`. The capabilities carry their own command names because they are public (`agw review-route`,
`agw review-adversary`). When `ocr` exits non-zero and its stderr is a provider-balance refusal (`isBalanceFailure`),
it runs once more on the route's fallback (OpenAI's own models over `OCR_LLM_PROTOCOL=openai-responses`, as
agent-gateway probed); a failing fallback reports the primary's failure.

## Provider balance degrade

The routes fall back once on a provider-balance failure (`packages/routes` README). When that is not enough, the
review answers a typed result instead of a failure or a `blocker`: every reviewer (angles and adversary) failed with a
balance error: "No review ran", `needs-human`, `escalationCategory: spend`, one `(review pipeline)` discussion
"provider balance exhausted — review in-session with /code-review on your own Claude", and
`degraded: "provider_balance"` for callers that branch on it. When the reviewers ran but the synthesis was refused on
balance (it is not re-asked then), their findings are salvaged unstructured into a `synthesis` discussion, with the
same hint, category and `degraded`. Mixed failures stay the `blocker` verdict.

## Hardening

- **Helper environment.** git, fallow and react-doctor run on an allowlist built from `ports.env`: `PATH`, `HOME`,
  `TMPDIR`, `LANG`, `LC_*`, `TERM` and exactly `GIT_CONFIG_GLOBAL`, `GIT_CONFIG_SYSTEM`, `GIT_CONFIG_NOSYSTEM`; nothing
  else (`GIT_DIR`, askpass, ssh commands, per-command config never pass). `SSH_AUTH_SOCK`, `XDG_CONFIG_HOME`, the proxy
  variables (`HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY`, both cases), `GIT_SSL_CAINFO` and `SSL_CERT_FILE` are added to the
  `fetch` and `ls-remote` calls only, never to a tool that reads the checkout. Helpers and `ocr` are spawned `detached`
  and a timeout or abort signals the whole process group (the check workflow's `killProcessGroup`). The API secret and the IU key never
  reach any helper (`test/review-git.test.ts`). `ocr` gets its own minimal env plus the IU credentials it needs, and is
  killed as a process tree.
- **One path.** `prepare` resolves `git rev-parse --show-toplevel` and realpaths it; everything after uses that spelling
  (prompts, the agents' grant, the clone source). A subdirectory `cwd` reviews the whole repository and the prompts say
  where it was started; a `cwd` with glob or control characters, or that is no work tree, is `invalid_input` before any paid step.
  The grant is a glob on the path, which OpenCode matches as named, not as resolved.
- **Symlinks.** In a `pr`/`branch` clone every symlink whose realpath leaves the clone is deleted right after checkout
  (OpenCode follows a link out of an allowed directory, see the opencode-host README). The live `cwd` is not edited: a
  symlink there is an accepted risk.
- **Scopes.** A scope git resolves as a commit is a ref (`v2.0`); only what it does not resolve is a path, and a path that
  matches no file is `invalid_input`, never an empty-diff `clean`. A path scope (`.` is the whole tree; an absolute one must lie inside the root) is `git diff HEAD -- <path>` plus the
  untracked files under it, like `uncommitted`: a staged or new file is a review.
- **Prompt data.** Changed file names sit inside a nonce data fence with control characters escaped; the diff likewise.
- **Siblings.** Every step started beside the pipeline (react-doctor, adversary, OCR, the angle fan-out) is tracked: a
  rejection is handled at once, and the cleanup awaits them all before it removes the clone. The runtime cannot cancel a
  sibling step, so an all-failed verdict is computed without waiting but the run ends only after they settle.
- **Resume.** The clone's path is deterministic (a hash of the `prepare` step key). If a sweep removed it before a
  resume, `run` rebuilds it at the same path from the journaled head and base commits (by id if the ref moved) before
  any step reads it; if that fails the run fails with a clear error.
- **Salvage.** The raw text kept is the last non-empty synthesis answer of the two attempts.

## Agents

`agents/review-<angle>/{AGENTS.md,agent.json}` for the twelve angles and `review-synthesis` are the legacy prompts, adapted
to a session with no shell: the diff is in the task message, paths are absolute under the repository root the message
names, and the steps that reached outside the repository (a user rules directory, a URL) are marked as skippable.
`review-router` and `review-adversary` are not OpenCode agents: they carry the prompts of the two single-call
capabilities, so the run fingerprint hashes them like any definition. `agents` on the `HostWorkflow` lists all fifteen
with their routes.

## Differences from legacy

- `uncommitted` is `git diff HEAD` (staged and unstaged together) for every reviewer. Legacy showed the router, the
  adversary and the file list the staged changes only when any were staged, and the angles `git diff HEAD`.
- No `model` input (route overrides go through `AGW_ROUTES`), no Max fallback, no research-gateway block in the angle prompts.
- OCR speaks the OpenAI chat protocol for the primary (route `review.ocr` is on the `iu-openai` wire) and Responses for a `gpt-` fallback, as legacy does for GPT ids.
- react-doctor reads the install agent-gateway keeps (`AGW_REACT_DOCTOR_BIN` overrides it) until the platform owns an install.
- Helpers run as argv, not `bash -c`: a scope can no longer reach a shell, and a fallow timeout is reported as `fallow failed`.
- The OCR route is not part of the run fingerprint (it is no agent definition); a model change there does not move it.

## Token effect / cache effect

- The angle agents' `AGENTS.md` is static, so its prefix caches across runs of the same angle; the task message follows it
  and puts the per-review parts (repo, files, context) before the diff. All angles get the same task text, but each has its
  own head, so the diff is read once per angle, not shared between them.
- The diff goes inline (capped at 200K chars for the angles, the router and the adversary) instead of through a `git diff`
  tool call, which saves a round trip per angle; an agent that needs more reads the file. The repository is read, never
  written (`edit` denied), so a retried angle repeats only its own reads.
- Replay costs nothing: a finished step is read from the journal, and a resumed agent step re-attaches to its session
  instead of prompting again (the one run that crossed a deploy re-sends no angle prompt).
- A retried angle opens a fresh session: a full prompt and a cold cache, which is why only the second attempt is allowed.
- The OCR child's tokens are mostly cache reads of its own loop (~1.5-3M a run); it is the one reason the wallet gate exists.

## Tests

`packages/host/test/review.test.ts` (Postgres, `FakeAgentHost`, fake IU transports, real git): empty diff, the gating table,
failed angles, adversary failure, OCR admitted / refused by the wallet gate / skipped by each parent gate / falling back
on balance, the provider-balance degrade, synthesis retry and salvage, verdict overrides, resume after a crash, `pr`/`branch`. `review-git.test.ts`: scopes, untracked files, the
clone and its housekeeping. `review-agents.test.ts`: the agent definitions. The permission option is proven live in
`packages/opencode-host/test/live.test.ts`.
