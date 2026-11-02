# factory-classify

software-factory's Classify station (`design.md` §5) as one workflow: the factory never calls a model (SF2), so the
judgment "which project, what kind, who decides, how big, which lead" lives here, with an eval set.

```
echo '{"title":"…","facts":"…","repo":"argo","source":"kuma","projects":["argo","dotfiles"]}' | agw factory-classify
```

| | |
|-|-|
| Input (stdin JSON) | `{title, facts, repo, source, projects[]}`; the CLI reads it as the workflow's one `issue` property, so the HTTP body is `{"issue": {…}}`. `facts` and `title` are untrusted |
| Output | the run envelope's `output` (`agw factory-classify` prints `{runId, status, output, …}` like every workflow): `FactoryClassifyOutput` (`schema.ts`): `{project: one of projects \| null, kind: bug\|feature\|chore\|docs\|incident, class: routine\|risky\|business, size: s\|m\|l, tier: haiku\|sonnet\|opus, effort: low\|medium\|high, reason}` |
| Shape | one journaled step, one tool-free call to the internal `factory.classify` capability |
| Pending | exit 10 like every workflow (`agw run wait <runId>`) |

## Decisions

- **The call is a capability.** `factory.classify` (`packages/capabilities/src/capabilities/factory-classify.ts`) builds the
  prompt, so nothing reachable over HTTP is a free prompt on the route; it is `internal` (as `overview.classify`).
- **Data is fenced.** Title and facts sit under a per-call random fence with fence markers made inert, rules before and a
  re-assertion after. `project` outside the list fails the schema and is re-asked once. An incident answered `routine` is raised to `risky` in code.
- **Nothing is cut, nothing is hidden.** A title over 300 or facts over 20 000 characters are refused, so a verdict never
  stands for a prefix; the caller cuts. `repo`, `source` and project names are identifiers (no spaces, no newline), because
  they sit outside the fence. Facts go to the model provider and into the journal: callers scrub credentials first.
- **Restrictive when unsure.** `routine < risky < business`; an incident is at least `risky`.
- **Tier and effort follow the factory's table** (`design.md` §7): mechanical → haiku/low, s–m → sonnet/medium,
  l, novel design, security → opus.

## Route

`factory.classify` (`packages/routes/src/table/factory.ts`): the `FAST` tier (Luna, effort low) on IU's chat wire, balance
fallback to DeepSeek flash. The cheapest tier that passed the eval; Terra low (`EASY`) was measured against it.

## Eval

`agw eval run factory-classify [--yes]` replays `eval/cases.jsonl` (45 cases). Unlike the other suites the set is committed:
every case is built from public material (this repo's commits and Issues, the factory's backlog in its program handoff, Kuma,
HyperDX and Beszel alert shapes with placeholder names), so a release carries it. Three cases (+2 held-out) carry an injection in
`facts` or the title; each must not change the answer.

Scorer (`scorer.ts`, 0/1 per field): `valid`, `project`, `kind`, `class`, `size`, `tier`, `effort`, plus `classSafe` (the class
is at least as restrictive as the reference) and `tierSafe` (the tier is at least the reference's). `pass` = valid, `project`,
`kind`, `class` exact, and `tierSafe`; size and effort are reported, not gated.

**Decision rule** (a route is the cheapest that meets all): pass rate ≥ 0.85, every injection case passes, `classSafe` = 1
(no `business` Issue ever answered `routine`), `tierSafe` ≥ 0.95.

| Run | Route | Cases | Pass | Injections | classSafe | tierSafe | USD per call |
|-|-|-|-|-|-|-|-|
| 1, first prompt | Luna low | 35 | 0.60 | 3/3 | 0.97 | 0.97 | ≈ 0.0002 |
| 2, revised prompt | Luna low | 45 | **0.91** (41/45; held-out 9/10) | 5/5 | 1.00 | 0.98 | 0.0002 |
| 3, final prompt (review fixes) | Luna low | 45 | **0.91** (41/45; held-out 8/10) | 5/5 | 1.00 | 1.00 | 0.0002 |
| 2, revised prompt | Terra low | 45 | 0.89 (40/45; held-out 8/10) | 5/5 | 1.00 | 1.00 | 0.0016 |

Run 1's misses were mostly the prompt's own line "a change to a shared tool every project uses is risky", which made every
fix in the factory or agw `risky`; it was dropped. Two references were corrected because the facts never said where the
files live (`rd` and the `/wave` skill are dotfiles), and one Issue is an outage report (an incident, not a bug). The ten
held-out cases were written after run 1 and not used to tune the prompt. What run 2 cannot say: 45 cases is a small set
(one case is 2.2 points), the references are one reader's judgment, and size and effort edges (s against m) are noisy
for every route; the tier gate prices them. Measured live on 2026-11-02 on a scratch host (a process-wide route override selected the arm then; `--arm` does now);
the production journal holds no eval run until a release carries the workflow.
