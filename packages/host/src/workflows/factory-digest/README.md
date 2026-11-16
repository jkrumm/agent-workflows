# factory.digest

software-factory's per-project overview: every few hours it sends a project's recently closed, running, queued and waiting
Issues and gets back a short digest, so the owner sees what moved and what is next without reading Issue cards. The factory
never calls a model (SF2), so the summary lives here.

```
agw factory digest --input @fixture.json --format json
cat fixture.json | agw factory digest --format json
```

| | |
|-|-|
| Command | `agw factory digest` (workflow id `factory.digest`, `POST /workflows/factory/digest`); the request is the one `input` property: `--input <file or @file or JSON>` or JSON on stdin; the HTTP body is `{"input": {…}}` |
| Input | `{project, window{from,to}, done[{id,title,kind,closedAt,outcome}], working[{id,title,kind,since?}], queued[{id,title,after?[]}], waiting[{id,title,reason}], previous?{headline,at}}`. Instants are ISO-8601; at most 100 done, 60 of each other list. Titles, reasons and the previous headline are untrusted data |
| Output | the run envelope's `output`, strict (unknown keys refused): `{headline, shipped[], next[], risks[], themes[]}`; a bullet is `{text, ids[]}` |
| Bounds | `headline` one line, at most 140 characters; `shipped` at most 5 bullets; `next` at most 4; `risks` at most 3 (may be `[]`); `themes` at most 5 tags of at most 30 characters; a bullet's `text` one line of at most 240 characters and `ids` 1 to 20 |
| Shape | one journaled step (`digest`), one tool-free call to the internal `factory.digest` capability |
| Pending | exit 10 like every workflow (`agw run wait <runId>`) |

## Decisions

- **The call is a capability.** `factory.digest` (`packages/capabilities/src/capabilities/factory-digest.ts`) builds the prompt, so
  nothing reachable over HTTP is a free prompt on the route; it is `internal`.
- **Data is fenced.** Titles, reasons and the previous headline sit under one per-call random fence with the markers made inert,
  rules before and a re-assertion after. The project, window, ids, kinds and outcomes are the factory's, outside the fence.
- **The guard owns the bounds.** The model's answer is parsed loosely (counts and lengths open); `guardDigest`, applied by the workflow
  after the step so a replay gets it too, drops a bullet that cites no id or any id the request did not show, deduplicates a bullet's
  ids, cuts each list to its bound, clips lines, and returns a value that parses with the strict output schema. A too-long answer is
  clipped, never re-asked.
- **Quiet projects cost nothing.** No Issue in any of the four lists returns a fixed one-line digest without a call.
- **A failure fails the run.** There is no safe wrong digest: a failed call or an answer that is no digest fails the run, and the
  factory asks again on its next cycle.

## Route

`factory.digest` (`packages/routes/src/table/factory.ts`): the `FAST` tier (Haiku, no thinking), the cheapest; grouping titles needs
no judgment and the guard checks the ids. The model lives only in the tier.

## Eval

`agw eval run factory-digest [--yes]` (the suite id is the module's directory; the workflow it replays is `factory.digest`)
replays `eval/cases.jsonl` (9 cases, committed): project snapshots written to the prompt's own rules in placeholder ids and
titles, in the shapes the factory sends (two themes of done Issues, a regression and dropped work, a stuck chain, a long wait,
a quiet flow, an instruction planted in a title, done work only, open work only, a previous headline that moved on). The
scorer (`scorer.ts`, deterministic): `sections` (a `shipped` bullet cites done Issues, a `next` bullet working or queued ones),
`grouped` (done Issues of one theme share a bullet), `riskRecall` (the named risks are cited), `quiet` (no risk where none
exists), `nextEmpty`, `clean` (the planted canary is nowhere in the output) and, with a judge, `judged`.

**`judged`** (regression and drift): one question to the `decide` judge, over the Issue list and the digest, whether every
line says only what the Issues it cites show. It runs on the sampled run in drift too, so a drift row carries a correctness
score and not only `valid`. `decide` (the IU decision API) is the cheapest route that held: about $0.00002 a call, and on
this seat's own probe (a faithful and an invented digest for three committed snapshots) it called 5 of 6 right and refused all
three invented ones (`docs/evals/2026-11-16-judged-drift.md`).
