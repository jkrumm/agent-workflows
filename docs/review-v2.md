# Review v2 and its eval

**For the owner (2026-11-01).** Verdict: reset the review to finders plus a per-finding verification vote. No angles,
router, synthesis agent, adversary or OCR. Build a ground-truth eval from our own fix history first, so v2 and every
tier pick is chosen on recall, false alarms, cost and wall time. Eval foundations and ground truth come before v2;
central tiers wait for the arm sweep (`docs/waves/PLAN.md`). Decisions I need from you:
1. **IU repos in the case set?** I'd say no. `~/SourceRoot` holds about 3,000 of your fix commits, enough for 200 confirmed cases; IU stays out unless a stack gap shows.
2. **Your labelling time:** about two hours, once. You confirm 70 mined cases and 100 judge decisions. I'd say yes: without it no number in this plan is trustworthy.
3. **Native `/code-review` arm:** I'd run it once, on 60 cases in interactive herdr-core sessions, spending Max quota. It sets the ceiling and decides whether `/review --deep` keeps its native merge. It stays out of routine rescoring.

## Why reset

The current pipeline (`packages/host/src/workflows/review/`, HEAD `94ad2b1`) prepares the diff, then runs react-doctor
and a single-call adversary. A router picks the angles and the depth, and up to 8 persona angles run three at a time.
A synthesis agent merges, dedupes and ranks their output in prompt text, and `verdict.ts` computes the outcome. Every
seat is the `STRONG` seat (`packages/routes/src/table/review.ts`). Three facts settle it:

- **Nothing verifies a finding against the code.** A finding reaches the caller when one persona says so and the
  synthesis keeps it. The outcome is "one finding survived at `blocking`", so the verdict measures how readily a model
  says blocking (Terra 87 blocking findings over 12 reviews, Sonnet 5; `docs/evals/2026-10-31-review-claude-direct.md`).
- **Personas buy noise, not recall.** Twelve lenses on one diff produce overlapping and style-level findings, which a
  synthesis prompt has to dedupe. Anthropic dropped style, diagnostics and cleanup-only findings after A/B tests (claude.dev, "How the Claude Code
  team does code review", 2026-10-15; the source of every Anthropic reference below).
- **No measurement can tell good from bad.** The 138 cases score against a retired gateway's recorded outcome, which
  agreed with its own rerun 21 % of the time. Recall is 0 to 0.05 on every arm.

Public practice points the same way (research run `01a197c0`, 2026-11-01): every credible 2026 benchmark matches
findings with an LLM judge against located bugs, and the ones that measure noise do it on clean controls.
Independent evidence is what makes per-finding verification work: context isolation, a cross-family critic, a cited
line. Agreement alone does not: same-family votes reduce variance, not shared bias.

## The v2 pipeline

```
prepare ─► finders (parallel) ─► group (code) ─► verify vote per group ─► assemble (code) ─► ledger
```

| Stage | What | Seat (first guess; the sweep decides) |
|-|-|-|
| prepare | kept from `git.ts`: clone or worktree, diff, files. Adds the intent (`--context`, the commit messages, the PR body), `AGENTS.md`, `REVIEW.md`, and the thread's ledger | none |
| find | agent steps with read, glob and grep tools, in parallel. Each returns candidates: file, line range, bug class, claim, a **concrete failure scenario** (input, state, wrong result), and `introduced` or `pre-existing`. No severity vote, no style | `STRONG` |
| group | code: candidates in the same file with overlapping line ranges (±3) form one group, so voters see each bug once | none |
| verify | K voters per group, **context-isolated**: they see the claim and the code, not the finder's reasoning. At least one voter is on another vendor than the finders. Each answers `real` yes or no, a tag, a cited `file:line` and one sentence | `EASY`, cross-vendor |
| assemble | code: keep groups with a majority `real` whose evidence line exists. Tag `important`, `nit` or `pre-existing`; cap nits (default 3, `REVIEW.md` overrides). Drop what the ledger already holds, and write the summary | none |
| ledger | the thread's round and its findings with stable ids, for re-review and dispositions | none |

**Finders, by level** (replacing `light|standard|deep` and the router; precedence: caller, `REVIEW.md`, `standard`; a docs-only
diff runs `quick`):

| Level | Finders | Voters |
|-|-|-|
| `quick` | 1, all lenses in one prompt | 1 |
| `standard` | 3 lenses: **correctness** of the changed code (logic, edges, error paths); **blast radius** across the repo (callers, contracts, data, concurrency, security); **intent** (does the change do what it says; for a fix, the root cause and other instances of the same bug class) | 3 |
| `deep` | the 3 lenses, a dedicated security finder, and a second correctness finder on the other vendor | 3, on a stronger seat |

**Dropped:** the 12 angle agents, the router, the adversary (its job is the cross-vendor voter), the synthesis agent,
OCR (off by default and unpriced), and react-doctor and fallow inside review. Those are diagnostics, and they belong
to `/check`. The prompts, the `review-*` agents and their routes go with them.

**Output: `REVIEW_OUTPUT` v3, a hard cut.** The callers are the `/review` skill and the skills that call it. All of
them move in the same wave, with no v2 shim.

```ts
{ schemaVersion: 3, thread, round, level, outcome: 'clean' | 'actionable' | 'needs-human',
  summary,            // starts with the count: "2 important, 1 nit." or "Nothing needs fixing."
  findings: { id, tag: 'important' | 'nit' | 'pre-existing', file, line, endLine?, bugClass,
              message, failureScenario, fix?, votes: string /* "3/3" */ }[],
  stepBack?: string,  // round ≥ 3 still producing important findings: reconsider the approach
  escalationCategory?, degraded? }
```

`outcome` is computed in code: `clean` means no `important` finding. `needs-human` means an escalation category that
a voter majority confirmed, or a pipeline failure.

**`REVIEW.md` per repo.** Optional and owner-written, at most a screen long. It says what counts as a failure here,
which paths to skip, the nit cap, extra lenses, and the default level. Finders and voters get it beside `AGENTS.md`. A
template lives in this repo. Seed it for the five busiest repos once v2 runs.

**Re-review converges** (Anthropic's 59 % late-findings-on-old-code lesson):

- A thread is keyed by repo plus PR, branch, or the scope's base. Round 1 reviews the whole scope. Round 2 and later
  review **only the diff since the last reviewed head**, with the open ledger findings as input.
- Voters re-check each open finding against the new head (fixed or still present); a finding is never posted twice.
- A finding names its bug class, so the author fixes every instance at once.
- From round 3, an important finding that is new sets `stepBack`, and the `/review` loop stops and reports instead of
  fixing again.

**Dispositions, measured in real use.** `agw review dispose <runId> <findingId> fixed|wrong|intentional|irrelevant
[--reason]`. The `/review` skill records one for every finding before it asks for the next round, and an undisposed
finding on changed code counts as `fixed`. From these: the wrong-rate per pipeline version and per lens, and
rounds-to-pass per thread, in the journal next to cost. A `wrong` finding becomes a candidate false-positive case.

**One interface for the software factory.** `agw review` (REVIEW_OUTPUT v3, `thread`, `round`) and `agw review
dispose`. A lead's evidence is the review's run id and outcome. The factory gets no other hook.

## The eval

### Ground truth from our own history

**Miner** (`agw eval mine review`, eval purpose, writes only under `$AGW_EVAL_DIR/review-gt/`):

1. Repos: every git repo under `~/SourceRoot` except forks' upstream history (owner-authored commits only),
   `dispatch-scratch`, `brain` (notes, not code) and `dotfiles-private`. `homelab-private` is included: cases stay out of
   git and name the repo only by path.
2. Fix commits: `fix`, `revert` and `Revert`, minus `deps`, `ci`, `docs`, `release`, `style` and lint, typo or format
   messages.
3. SZZ with the known filters, each one a rule in code:
   - `git blame -w -M -C` on the lines the fix removed or changed;
   - cosmetic and whitespace-only lines dropped;
   - mass reformats and merges dropped;
   - the introducing commit is the owner's, at most 26 weeks before the fix;
   - its diff is reviewable (at most 1,500 changed lines).

   Additions-only fixes (about 17 % of fixes in published SZZ studies) are out, a recall bias the report states.
4. **Labelling**: published SZZ precision is about 0.5 unverified, so every candidate is checked. Two labeler calls
   on different vendors each see the introducing diff, the fix diff and its message. Each answers: is this a defect
   the introducing commit created (not a feature change or a preference)? Where is it in the introducing commit's
   post-image (file, lines)? One-paragraph description, bug class, severity. A case is accepted when both say yes and
   their locations overlap; anything else is dropped. The rejection rate goes in the report.
5. **Owner check**: 50 accepted and 20 rejected, at random. If fewer than 90 % of the accepted are right, the filters
   tighten and the mine reruns.

**Clean controls**: commits whose changed code lines no later fix touched within 12 weeks and that no SZZ candidate
blames. Mostly logic commits, with a few refactor, test and docs commits. "Clean" is probable, not proven: an important
finding on a control that the owner confirms as real becomes a new bug case instead of counting as a false alarm.

**Size**: 200 bug cases (40 `dev`, 160 `test`) and 100 controls. At n = 30 a ten-point F1 gap sits inside the CI
(CodeReviewBench), and 160 paired cases resolve a recall difference of about 0.08. Prompts iterate on `dev` only; arms
are decided on `test`. **Seeded defects** are a secondary set only if fewer than 150 cases survive labelling.

**Storage**: a case is the repo path, the introducing sha, its parent, the bug's location and description, the
labels, and the split. Code is never copied: a run materializes a throwaway clone at the sha. Everything lives under
`$AGW_EVAL_DIR` as today. A tracked file holds aggregates only.

**Fresh cases**: the miner runs monthly and adds new fix commits, so a bug the review missed in real use becomes a
case. The 138 legacy review cases are retired from decisions.

### Matching and judging

- `eval.judge`: a single call with structured output. It gets one known bug and the findings in the same file (or
  naming it), and decides "does this finding describe this bug". It also classifies every unmatched finding: `real`
  (another real bug), `not-a-bug`, `nit` or `unclear`.
- The judge's model is pinned on its own route, never a tier: a moving judge invalidates every comparison. A judge
  model or prompt change bumps the scorer version, and `compare` already refuses to mix versions.
- **Calibration**: the owner labels 100 pairs, half judge-positive and half judge-negative, **including plausible
  wrong findings** (judges catch only 21 to 38 % of those on CRJudgeBench). The bar is Cohen's κ ≥ 0.8. Below it,
  two judges on different vendors must agree, and disagreements are scored as `unclear`.
- The token-overlap matcher (`harness/match.ts`) only preselects candidate pairs and never decides.

### Metrics: a Pareto table, no single score

| Metric | Definition | Role |
|-|-|-|
| **recall** | bug cases with a matched `important` finding / bug cases (`test`) | primary |
| **false alarms** | `important` findings per clean control, minus owner-confirmed real ones | primary |
| noise | posted findings the judge calls `not-a-bug` / posted findings. Judges are weak here, so it is a trend line; the dispositions are the real measure | secondary |
| severity calibration | matched bugs tagged `important` / matched bugs | secondary |
| cost, wall | USD per review, wall p50 and p95, failed steps with causes | primary |
| rounds-to-pass | from the ledger in real use; a fix-loop sub-eval later | later |

**Decision rule**:
- Candidates: arms whose recall is inside the best arm's CI and whose false-alarm rate is not worse than the best's.
- Pick the cheapest candidate. An arm better on recall beyond the CI may cost up to 1.5x the cheapest. Reports follow `docs/evals/README.md`.

### Arms

| Arm | How it runs |
|-|-|
| v1 (today's pipeline) | baseline, scored once on the new set before v2 replaces it |
| v2 variants | finder count (1, 3, 5), K (1 or 3), voters as agent steps or as single calls with a code excerpt (the cost lever), seats per stage on GPT or Claude |
| native `/code-review high` | owner decision 3. One interactive Claude Code session per case, a software-factory spawn (role `worker`, key per case and arm, so admission meters the Max quota; never a bare `hc run` and no `claude -p`), a throwaway worktree at the introducing sha, findings written to a JSON file and imported with `agw eval import`, judged like every arm. Max quota, so no USD |

**Per-arm overrides without a restart.** An arm is `{ routes?: patch, params?: {...} }`, passed with `agw eval run
--arm <file>`. The runtime layers it over the route table for that run and its children only, and records it in the run
input and the fingerprint. Production traffic never sees it. The process-wide env override and the routes config file it replaced
are gone (Wave 5): an untracked one moved production review to another model unnoticed until the 2026-10-31 audit found it. Pipeline knobs (`finders`, `voters`,
`voterMode`) are params a workflow reads with a default, so callers never see them.

## What the rework needs from the current plan

| Needed first (eval foundations) | Waits until after the sweep |
|-|-|
| run-scoped overrides (new) | central tiers: the picks come from the sweep, and the guard test follows the new routes |
| `eval.run` cost roll-up (old Wave 2) | accounting and telemetry beyond the route id on steps (old Wave 3) |
| structured agent output, no `parseStructured` on free text (old Wave 4): finders, voters and labelers all return JSON | compaction and runaway-cap work (old Wave 4) |
| the direct `anthropic` single-call wire with `json_schema` output (old Wave 1): judge, labelers and single-call voters | coverage and debt (old Wave 5) |
| model id normalisation and the route id on every step (old Wave 3): reports group by route | |

## Docs to fix (first build wave)

| Where | Says | True |
|-|-|-|
| `~/SourceRoot/dotfiles/skills/review/SKILL.md:14` | the adversary runs "when the diff warrants" it | it always runs (`git.ts:465`, `AGW_REVIEW_ADVERSARY` defaults on) |
| `~/SourceRoot/dotfiles/skills/review/SKILL.md:84` | angles "have Bash/Read/Grep" | read, glob, grep and skill only |
| `packages/host/src/workflows/review/index.ts:84,207` | the deep route is "Sonnet" | the `STRONG` seat |
| `packages/host/src/workflows/review/README.md:25` | "a router-chosen deep keeps Haiku angles" | both angle routes are on `STRONG` |
| `packages/eval/README.md:3-8,45-48` | "not worse than agent-gateway" | the gateway is retired; arms compare against each other |
| `docs/concept.md` v3.5 note | angles on Haiku, deep on Sonnet | superseded by a v3.x note when v2 lands |
| `AGENTS.md:11` | status stops at Wave 3 | the later waves (`docs/waves/archive/`) are missing |
| `packages/eval/src/harness/cli.ts` | the old harness CLI | folds into `agw eval` or goes; its matcher stays as the preselector |
