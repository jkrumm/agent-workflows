# Lead handoff — Wave 5 (evals and self-improvement; P2), rotation

Lead `agent-workflows-w1` (same pane as Wave 4) 2026-10-28 ~15:00 → ~18:45, rotated at the context limit. The Wave 4
close-out is in git at `8581501`. Briefs: `~/.local/state/agent-workflows/briefs/w5/` on the mini (not in git: they
name local paths). Master `c22cf6f` (#23, #24 merged), deployed, `make verify` PASS, host on the personal key.

## State (next actions, in order)

|Step|State|Next|
|-|-|-|
|First experiment on review (owner's ask: angle shell)|**done, answered with numbers** (below)|Remove the arms in a cleanup PR (see "Cleanup PR")|
|Reproducibility check for eval sets|**merged, #23** (`self-agreement` mode, `reproducibility.jsonl`, recall only on reproducible cases when every case has a row)|Live run: `bun packages/eval/src/harness/cli.ts self-agreement review --side legacy --runs 2` (legacy reruns: personal key, about $6 for 20 cases)|
|Wave 4 leftovers|**merged, #23**: `agw schema review` typed (live: `output` has properties), `--resume` takes an absolute path or a path under `<evalDir>/reports`, the 11 unpriced calls explained (prompts 104K–146K tokens, the vendor's long-prompt tier the `Rate` cannot model; documented in the eval README); `roles/worker.md` gained the background-shell rule (dotfiles `d5a91ab`)|none|
|Retrospective workflow + learnings store|**merged, #24**, deployed. The weekly schedule is on (`AGW_RETRO_WEEKLY`), so the first `retrospective` runs for `review` and `check` start within an hour of the `c22cf6f` deploy; `fileIssues` off|Read those two runs (`agw run status`), judge the proposals, then decide on `AGW_RETRO_FILE_ISSUES=1` (issues carry only structured fields: kind, a tracked target path, confidence, sampled run ids; free text stays in the journal)|
|Friction counters|**PR #25, fix round 1 in progress** (worker `agent-workflows-friction`): lead `/code-review high` found 10; the blocker is the nudge. Per the repo's fake, a synthetic input sent mid-turn is queued as a separate turn whose prose could replace the step's JSON. The worker measures that live on 2.0.32 and either keeps an in-turn nudge or records `nudgesDue` only|Lead read of the fix round (each fix round needs its own review), `rd merge`. `AGW_FRICTION_REPO` must be set in the host env or no issue is ever filed|
|Scorer API + `agw eval run\|compare`|**PR #26, fix round 1 in progress** (worker `agent-workflows-scorers-eval`, Opus): lead `/code-review high` found 10, all sent back (cancel orphans, resume re-materializes, infra scorer errors stored as verdicts, unbounded reads, drift candidate scan, small-n verdicts, unpriced cost drop, spec overwrite, duplicate ids)|Lead read, `rd merge` (expect a small rebase on `packages/runtime/test/infra.test.ts`: 0004 vs 0005). Then live: `agw eval run review --ids <5 ids> --yes`, `agw eval compare`|

## Experiment: does review find more with a caller instruction or a read-only git shell?

Question (the Wave 4 close-out's first candidate): legacy angles had a read-only shell; do agw's angles find more stale
call sites and broken tests with (a) an instruction to check callers of changed exports, (b) that plus a read-only git
shell? Arms chosen per run by a review input (`angleVariant`), so all three ran side by side on one deploy (`3490b50`),
20 paired cases (the Wave 4 side-by-side set), same depth, judge on, team key. Reports:
`reports/2026-10-28T16-34-3{2-480Z,3-749Z,4-806Z}` (baseline, callers, shell).

|Arm|Blocking|Recorded blockers recovered|New-only blocking|Improvements|clean/actionable/needs-human|Cost|Wall median|grep / read calls per angle session|
|-|-|-|-|-|-|-|-|-|
|Wave 4 run (same code, earlier)|11|4/30|8|94|12/4/4|$1.53|261 s|n/a|
|baseline|13|5/30|10|94|8/8/4|$1.13|252 s|1.4 / 1.0|
|callers|14|5/30|10|93|11/6/3|$1.42|286 s|3.5 / 1.7|
|shell|10|5/30|7|96|12/4/4|$1.27|206 s|3.0 / 1.7, shell 0.3 (8 of 25 denied)|

**Answer: neither lever changes the findings.** The two baseline runs differ by 2 blocking findings, 4 `clean`
outcomes and $0.40; every arm sits inside that noise on blocking, recall, improvements and outcomes. The caller
instruction is followed (grep calls ×2.5, reads ×1.7) and costs about +25 % and +13 % wall for no measurable gain.
The shell is barely used: the angles already have OpenCode's grep tool on the repository, which covers what `git grep`
would, and the history verbs (`log`, `show`, `blame`) were almost never called. So legacy's recorded blockers did not
come from its shell. What differs is the model: the recorded corpus is from Sonnet angles (before 2026-10-15), and
today's angles are Haiku.

**Recommended next experiment (the PLAN's "model question"): Sonnet angles on the same 20 cases.** It needs an IU
Sonnet model id and rate in `packages/routes/src/table.ts` (ids from `agw-legacy routing` / the IU catalogue, never
from memory) and a way to select it per run: `AGW_ROUTES` is not plumbed into the host by `scripts/launch.sh`.
Estimate $4–6 on the team key.

Also measured: the shell rules (live probe, 12 commands on 2.0.32). Allowed `git -C <repo> grep -n -e <token>|show|log|blame|ls-files`
ran; `cat`, chaining, pipes, `-O`/`-nOcat`, quotes, `blame --contents`, `diff` outside the tree, `--outp=` and another
directory were refused; a refused call does not end the turn. Open hole: OpenCode's glob cannot match a backslash, so
`--o\utput` passes the text rules. The variant was opt-in, refused with `pr`/`branch`, and used only on eval trees.

## Cleanup PR (after #25 lands: both touch `packages/opencode-host/src/host.ts`)

- Remove `angleVariant` (schema, plan field, prompts, tests, README paragraph) and revert the 12 angle `AGENTS.md`
  sentences to "you have no shell". Remove `repoShell` from opencode-host (no consumer left; the live probe and its
  measurements stay in this handoff and git history). Keep the harness `--agw-args` (general).
- **Security, found during the experiment:** agw's sessions start from OpenCode's allow-all base policy, so angles and
  synthesis keep `webfetch`, `websearch` and `subagent` (the eval runs show a completed `webfetch` of a public
  GitHub raw URL from an angle). Legacy denied all three (agent-gateway `opencode-server.ts:250-262`, catch-all deny
  with named allows). `execute` (code mode) is not a bypass: it proxies through the same gates (agent-gateway
  measurement on 2.0.25). Bring agw to legacy's posture: deny `webfetch`, `websearch`, `subagent` unless an agent
  opts in, measured on 2.0.32 with the live probe (the tool list a session sees).

## Live state and spend

- Deploys this lead: `3490b50` (experiment, team key), `c22cf6f` (#23, #24, personal key). `make verify` PASS on both.
- The wallet gate refuses `review.ocr` until 2026-11-02 (IU cap cooldown, threshold $400): OCR was skipped in every arm,
  equally. Expected behaviour of the gate, not a fault.
- IU spend: athena-team $3.82 for the three arms (60 review runs) plus the judge calls, and one `agw review` a worker
  ran during the window. The personal key covered everything outside the window. athena-mother's pane was gone
  (`rd say` found no agent of that name), so the window was not announced there; nothing about the key went elsewhere.
- Worktrees: `w5-scorers-eval` and `w5-friction` are live with their workers; `w5-eval-leftovers` and
  `w5-retro-learnings` can go with `rd fan --clean` once the batch lands.

## Reviews this lead

|PR|Review|
|-|-|
|experiment (direct to master, `f377b87..3490b50`)|lead read found three shell escapes (`diff` as no-index, `blame --contents`, `-nOcat`/abbreviations/quotes) before any eval; `/code-review high` r1 (8: 5 fixed, 3 skipped with reason: baseline prompt change is fair inside one deploy, `ls-files --exclude-from` prints no contents, the diff cap is equal across arms)|
|#23 eval leftovers|`/code-review high` r1 (10: 9 fixed, quadratic judge pairs documented), lead read r2, merged|
|#24 retrospective + learnings|`/code-review high` r1 (10): the public-issue deny-list leaked (invented `packages/<name>` paths, unlisted TLDs, tokens), redesigned to structured fields only; learnings ordering, retired facts, fence, weekly retry, scrub fixed; lead read r2 of the issue builder and evidence validation, merged after a rebase|
|#25 friction|`/code-review high` r1 (10), fix round in progress|
|#26 scorers + eval|`/code-review high` r1 (10), fix round in progress|

## Retro notes

- An experiment that changes nothing is still an answer: the tool-call counts showed why (the built-in grep already
  covers `git grep`), which saved building a typed git-history capability.
- Reading the allowlist before the eval found three ways out of a "read-only" shell; text-matched shell rules are
  a cost-raising boundary at best (backslash, abbreviations, flag clusters). A typed capability running argv is the
  only shape worth shipping.
- `/code-review high` with a PR target and an explicit "never check out a branch in the main checkout" worked on all
  four PRs.
- Load average 30–40 from parallel `make check` runs made 5 s test timeouts flake in two workers; reruns passed.
