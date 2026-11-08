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
  `hygiene unavailable: a link leaves the checkout` before any session opens. A tree of more than 200,000 entries fails
  closed the same way.
- **Data is fenced, documents are read through tools.** Candidate paths and reasons sit under one per-call random fence with
  the markers made inert, rules before and a re-assertion after. The text of the documents and the code reaches the agent
  as tool results, which cannot be fenced; the agent's instructions treat it as data too, and an instruction inside a
  document is at most a `slop` finding. What an injected agent can still do is bounded by the guard.
- **The guard bounds the answer.** `guardHygiene`, applied by the workflow after the step so a replay gets it too, drops a
  finding whose path is not a candidate of its own kind, whose file does not exist below `cwd` (`../`, an absolute path or a
  link out of the checkout included), and a repeat of a kind and path (the first stays); the rest is cut to `max`. It drops
  and never rewrites.
- **When unsure, nothing.** The instructions say so and `[]` is the expected answer.
- **Fail closed.** Any failure gives `{findings: [], read: 0, reason: 'hygiene unavailable: <class>'}`. A cancel, a shutdown
  (`InfraError`) or an aborted run still propagates to the runtime.
- **No ceiling.** The agent step has no wall-clock limit and no turn limit: the idle watchdog only.

## Route

`factory.hygiene` (`packages/routes/src/table/factory.ts`): the `EASY` tier as an OpenCode agent step (Haiku high, falling
back to Terra low); the model lives only in the tier. Reading several files and judging text fits it; moving the route to
`HARD.agent` is a one-line change if the findings turn out too noisy.

## Eval

None, by the owner's decision. It learns from real sweeps through the run journal.
