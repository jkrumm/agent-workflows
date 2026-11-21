# factory-spec-look

software-factory pages the owner for a gate's Spec (a lead's one-page plan). Before it does, the Spec gets the look a Decision
gets, once: the Judge answers `ready` (the owner can read it and give his verdict) or `back` (to its lead, with a note of what
to sharpen). The Judge never gives a gate its verdict: there is no pass and no settle here, and `factory-spec-screen` (pass or
settle, no case, no checkout) stays what it was. The factory sends a Spec back once; the type of the back and the page after
it are the factory's.

```
echo '{"spec":{"id":"artifact_1","revision":1,"title":"Switch the worker to pino","source":"lead","content":"## Build\n\nUse pino.","format":"markdown"},"issue":{"id":"issue_1","repo":"example-app","title":"Worker logging","kind":"feature"},"precedents":[],"checkout":"/abs/path/to/checkout"}' | agw factory-spec-look
```

| | |
|-|-|
| Input (stdin JSON) | the spec screen's request (`spec{id, revision, title, source, content, format, truncated?, images?}`, `issue{id, repo, title, kind, facts?}`, `precedents[]`: `factory-spec-screen/README.md` has every limit) plus two optional fields: `checkout`, the absolute path of the repo's checkout the Judge reads (plain path characters only), and `case`, the case file (`docs/factory-input.md` §The case file). The CLI reads it as the workflow's one `request` property, so the HTTP body is `{"request": {…}}`. The Spec, the Issue's title and facts, the precedents and every text of the case are untrusted data |
| Output | the run envelope's `output`: `{verdict: ready\|back, reason, note?}`. `reason` is one line of at most 240 characters. `note` is on `back` only: one line of at most 600 characters, what the lead sharpens |
| Shape | with a checkout, a `scan` step (no link may leave it); then one agent step (`look`, agent `agents/factory-spec-look`, route `factory.speclook`) and one retry (`look-retry`) on an answer of the wrong shape; then `guardSpecLook` |
| Pending | exit 10 like every workflow (`agw run wait <runId>`) |

## Decisions

- **A new workflow, not a mode of the screen.** The screen's answer (`pass` or `settle`) is a call the factory acts on; the look
  has other verdicts and other inputs, and callers outlive a release (`factory-spec-screen`'s shape does not change).
- **An agent that looks.** The task message is built in code (`buildFactorySpecLookPrompt`,
  `packages/capabilities/src/capabilities/factory-spec-look.ts`), so nothing reachable over HTTP is a free prompt on the route. The
  agent has read, glob and grep over the checkout the request names and nothing else; no turn limit and no wall-clock limit,
  the idle watchdog is the one stop. A checkout with a link that leaves it, or one too large to scan, is not handed over (the
  same rule as `factory-ask`, `lookOf`): the Judge then judges from the request, and its prompt says why.
- **Data is fenced.** Spec title and content, the Issue's title and facts and the precedents sit under one per-call random
  fence, the case file in its own CASE block under the same token; `repo`, ids and the precedents' marks are validated tokens.
- **`back` is for a defect the lead can fix in one revision and the Judge can name:** something the Spec says about the repo that
  is false; an open choice the plan, AGENTS.md, the docs or a quoted owner direction already settles; a choice with no default
  or no cost of changing it later; more than three choices; a look or surface with nothing to look at; a build too vague to say
  yes to; a contradiction of the repo's standards. Length, tone, a different design and a default it disagrees with are not.
  What the owner may decide himself is `ready`: the gate is his. When unsure: `ready`.
- **Guard.** `guardSpecLook` runs in the workflow after the step, so a replay gets it too: reason and note on one line each
  (the note at most 600 characters), a note only on a `back`; a `back` whose note is empty becomes `ready` (the owner reads
  the Spec, as without a look).
- **A failure fails the run.** There is no catch: a failed or invalid look (agent error, schema failure after the retry)
  fails the run, and the factory then pages the owner as it did before there was a look.

## Route

`factory.speclook` (`packages/routes/src/table/factory.ts`): the `HARD` tier's agent seat (`HARD.agent`, OpenCode), the seat
`factory.ask` uses; the model lives only in the tier. About one call per gate Spec.

## Eval

`eval/cases.jsonl` (`PlainCase` lines of public placeholder material): a concrete Spec with defaults, a spend Spec that is the
owner's and still ready, an open choice the plan and AGENTS.md settle, choices with no defaults and four of them, a look with
nothing to see, a Spec too vague to say yes to, a cut Spec, an injection in the content and a precedent where the owner asked
for a screenshot. Reference: `{verdict}`. The deterministic scorer (`scorer.ts`, 0/1 scores): `valid`, `verdict` and
`noNeedlessBack` (a `back` where the reference is `ready` costs the lead a revision and is named in the feedback). The set is
small and unscored so far: run `agw eval run factory-spec-look` before moving the seat.
