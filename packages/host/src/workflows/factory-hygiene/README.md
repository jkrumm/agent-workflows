# factory-hygiene

software-factory's hygiene loop sweeps each project weekly. Its deterministic part (`make check`, links, retired words,
outdated dependencies, co-change) stays in the factory; two judgments need a model that reads files, and they live here
because the factory never calls a model (SF2): which living documents have gone stale against the code, and which recently
edited documents carry filler. The factory picks the candidates and fingerprints each finding's title for dedup.

```
echo '{"repo":"app","cwd":"/path/to/checkout","ref":"3f9c2ab41d7e","stale":[{"path":"docs/architecture.md","why":"12 commits touch src/ since the document was last edited"}],"slop":[{"path":"README.md","why":"edited 2 days ago"}],"max":5}' | agw factory-hygiene
```

| | |
|-|-|
| Input (stdin JSON) | `{repo, cwd, ref, stale[], slop[], max}`. `cwd` is an absolute, read-only checkout of `ref`; a candidate is `{path, why}` with `path` relative to `cwd` (at most 20 of each kind), `max` 1 to 10. The CLI reads it as the workflow's one `hygiene` property, so the HTTP body is `{"hygiene": {…}}`. Paths and reasons are untrusted data |
| Output | the run envelope's `output`: `{findings[{kind, path, title, evidence, fix}], read, reason}`. `kind` is `stale` or `slop`; `title` is a stable one-liner (no counts, dates or line numbers); `evidence` names `path:line` on both sides (stale) or quotes the lines (slop); `findings: []` is the common answer; `read` is the number of candidates the agent read |
| Shape | two journaled steps: `scan` (code) and `review` (one agent step, one retry on an invalid answer) |
| Pending | exit 10 like every workflow (`agw run wait <runId>`) |

## Decisions

- **Read-only by construction.** The agent (`agents/factory-hygiene`) has `read`, `glob` and `grep` and no `agent.json`
  permissions: no shell, no edit, no write, no network, no subagent. The step's `allowDirectories` is `[cwd]`, so the
  checkout is the only directory outside its own location it may read (`packages/opencode-host/README.md` §Permissions).
- **A link cannot lead out.** The host matches the grant against the path the agent names, not where a link points, so the
  `scan` step walks `cwd` (not `.git`, not `node_modules`) and a symlink whose target leaves it gives
  `hygiene unavailable: a link leaves the checkout` before any session opens. A tree of more than 200,000 entries fails the run.
- **Data is fenced, documents are read through tools.** Candidate paths and reasons sit under one per-call random fence with
  the markers made inert, rules before and a re-assertion after. The text of the documents and the code reaches the agent
  as tool results, which cannot be fenced; the agent's instructions treat it as data too, and an instruction inside a
  document is at most a `slop` finding. What an injected agent can still do is bounded by the guard.
- **The guard bounds the answer.** `guardHygiene`, applied by the workflow after the step so a replay gets it too, drops a
  finding whose path is not a candidate of its own kind, whose file does not exist below `cwd` (`../`, an absolute path or a
  link out of the checkout included), and a repeat of a kind and path (the first stays); the rest is cut to `max`. It drops
  and never rewrites.
- **When unsure, nothing.** The instructions say so and `[]` is the expected answer.
- **A failure fails the run.** A step that fails after its retries (two invalid answers included), a cancel and a shutdown
  (`InfraError`) end the run as failed or cancelled; there is no neutral answer, so the factory can tell an outage from `[]`.
- **No ceiling.** The agent step has no wall-clock limit and no turn limit: the idle watchdog only.

## Route

`factory.hygiene` (`packages/routes/src/table/factory.ts`): the `EASY` tier as an OpenCode agent step (Haiku high, falling
back to Terra low); the model lives only in the tier. Reading several files and judging text fits it; moving the route to
`HARD.agent` is a one-line change if the findings turn out too noisy.

## Eval

`agw eval run factory-hygiene --yes` replays three cases (`eval/cases.jsonl`) over one committed fixture checkout,
`eval/fixture/`: a fictional `example-queue` project (five `.js` sources, eleven documents; plain files, no links, no
`.git`; `.js` because the repo's `tsc` skips it). It costs model calls: `--yes` confirms the spend.

- **Plants.** Five stale documents, each a line that is false against a named code line, of five kinds: a wrong default
  (the port), a wrong count (retries), a flag the CLI does not parse, a removed module, a renamed function. Three
  filler documents (empty marketing, throat-clearing, a restated heading). Controls: three stale candidates whose every
  claim is true, two of them also listed as slop candidates and tight.
- **Cases.** `all-plants-and-controls` (every plant and control, `max` 10), `controls-only` (only the controls: the
  answer is `findings: []`) and `mixed` (two stale plants, one filler plant, one control of each kind, `max` 5).
- **The input.** `cwd` and `ref` are not in the file: the module's `hygieneSuite` fills `cwd` with the fixture directory of
  the running release and `ref` with a placeholder sha.
- **Scorer** (`scorer.ts`, deterministic, no model, `FACTORY_HYGIENE_SCORER_VERSION`). Reference per case:
  `{plants[{kind, path, claim{path, line, text}, code{...} | quote}], clean[]}`. Scores, each a share from 0 to 1:
  `valid` (the output parses; 0 zeroes the rest), `recall` (plants with a finding of the same kind and path),
  `anchored` (of the plants found: a stale finding names the claim and the code as `path:line` within two lines, a slop
  finding quotes the planted phrase), `precision` (findings on a plant over all findings), `cleanKept` (clean candidates
  with no finding of any kind). `pass`: recall, precision and cleanKept all 1; `anchored` is reported, not gated. The
  feedback names each miss and false positive by path. Without a reference only `valid` is scored.
- **Keeping it honest.** `test/factory-hygiene-scorer.test.ts` proves every plant's claim and code line exists in the
  fixture and holds its recorded text, and every candidate and clean path exists. Edit a fixture line and the reference
  together.
