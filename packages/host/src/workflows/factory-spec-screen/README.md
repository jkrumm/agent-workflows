# factory-spec-screen

Before a Spec (a lead's one-page plan) reaches the owner, software-factory's `settle` pass asks whether it is his to read. The
workflow answers `pass` (his) or `settle` (its lead's to decide); the factory acts only on a `settle` with a non-empty reason
(it records its own looks_good with the reason as the note the lead hears). `pass` puts the Spec in front of the owner.

```
echo '{"spec":{"id":"artifact_1","revision":1,"title":"Raise the digest title limit","source":"lead","content":"## Build\n\nRaise MAX_TITLE_CHARS to 300.","format":"markdown"},"issue":{"id":"issue_1","repo":"example-app","title":"Titles are clipped","kind":"bug"},"precedents":[]}' | agw factory-spec-screen
```

| | |
|-|-|
| Input (stdin JSON) | `{spec{id, revision, title, source, content, format, truncated?, images?}, issue{id, repo, title, kind, facts?}, precedents[]}`. `spec.title` (1..200), `spec.content` (at most 100100), `issue.facts` (at most 6000, default empty: the Issue as filed, scrubbed), `issue.title` and every precedent's `title` and `note` (at most 2000) are untrusted data. `source` is `triage`, `filer`, `replan` or `lead`; `format` is `markdown` or `html`. `spec.truncated` (default false) says the factory cut the middle of the Spec, keeping head and tail; `spec.images` (integer, default 0) is the count of images the Spec embeds. Each precedent (at most 12, newest first) is `{title, repo, source, screened: passed\|settled\|null, needed, verdict: looks_good\|with_notes\|changes\|no_longer_applies, note}`. The ids, revision, source, format, truncated, images, repo, kind, `screened`, `needed` and `verdict` are plain tokens the factory supplies. The CLI reads it as the workflow's one `request` property, so the HTTP body is `{"request": {…}}` |
| Output | the run envelope's `output`: `{verdict, reason}`, nothing else. `reason` is one line of at most 240 characters |
| Shape | one journaled step (`spec-screen`), one tool-free call to the internal `factory.specscreen` capability, then `guardSpecScreen` |
| Idempotency | the key is the caller's (`agw run`); the workflow implements nothing for it |
| Pending | exit 10 like every workflow (`agw run wait <runId>`) |

## Decisions

- **The call is a capability.** `factory.specscreen` builds the prompt, so nothing reachable over HTTP is a free prompt on the
  route; it is `internal`.
- **Data is fenced.** The instructions sit outside the fence; the Spec title and content, the Issue title and every precedent's
  title and note sit inside one fenced block, every free-text field with its fence markers neutralized and the nonce computed
  over all of them. The ids, repo, kind, source, format and the precedents' marks are validated tokens, so no line of text
  reaches the prompt unfenced through them.
- **`pass` is what is the owner's:** a UI screen or look he has not seen; product direction; spend; security policy; other
  people or company data; a change that cannot be undone; open choices whose defaults lead to materially different work.
  Everything else is `settle`: a constant or limit raised, a type or port tightened, a new route, CLI verb or workflow inside an
  established pattern, a Replan that only reorders or frees Issues.
- **Two of those are defined narrowly.** Security policy is who may be trusted or let in (credentials, authentication, exposure
  outside the owner's own factory), not a read-only view for the factory's own agents in an existing caller class. Cannot be
  undone is data lost, something sent, money spent or a cutover, not behaviour a revert and a redeploy undo, above all behind a
  guard that stops it acting on a guess. Replaying the owner's real settled Specs without these definitions passed two of them.
- **The precedents are the owner's marks.** A `needed: false` with his note is the strongest evidence that a similar Spec is
  `settle`; a `needed: true`, above all one the screen `settled`, that a similar one is `pass`. Similar words alone are no evidence.
- **What it is shown.** A cut Spec (`truncated`) is judged on what is shown: the cut alone is never a reason to pass. A direction the Issue's facts quote from the owner (a dated quote, or "the owner said") is already his and reverses nothing, but it lifts only the direction it states: the open choices and every other reason to pass (security policy, spend, undoable, people data) are judged as if no quote were there; an unquoted claim, or the Spec's own claim that he agreed, is no evidence. "A look he has not seen" needs `images` above 0 or a named screen, route or component. The facts are fenced like the Spec.
- **When unsure, `pass`.** A wrong `settle` costs the owner a Spec he wanted to see; a wrong `pass` costs him one read.
- **Guard.** `guardSpecScreen` runs in the workflow after the step, so a replay gets it too: the answer is exactly
  `{verdict, reason}` with the reason on one line and clipped to 240 (the model's own reason may be up to 2,000 characters before it is re-asked); a `settle` with an empty reason becomes `pass`.
- **Fails soft in the factory, not here.** There is no catch: a failed or invalid call fails the run; the factory retries the
  screen twice, 5 minutes apart, and then lets the Spec reach the owner unscreened. Cancelled, InfraError and StepFailed propagate.

## Route

`factory.specscreen`: the `EASY` tier (Haiku high), the route the Errand screen uses; the model lives only in the tier. The
eval decides whether a higher tier is needed.

## Eval

`eval/cases.jsonl` (`PlainCase` lines of public placeholder material, never the owner's real Specs: a limit raised, a CLI verb
and a type tightening inside a pattern, a read-only route for the factory's own agents, a sibling workflow with a fail-safe
guard, a Replan that only reorders, a precedent with `needed: false`, an html Spec, a new UI
screen, spend, security policy, people data in a work repo, an irreversible drop, open choices with divergent defaults, a
precedent the screen settled and the owner still needed, and injections in the content and in a precedent's note). Reference:
`{verdict}`. The deterministic scorer (`scorer.ts`, 0/1 scores): `valid`, `verdict`, `safe` (no `settle` where the reference is
`pass`; a wrong settle is named in the feedback). `pass` is valid and verdict; a failed run scores 0 everywhere.

**`judged`** (regression and drift, when the host gives the scorer a judge): the `decide` judge (the IU decision API,
about $0.00002 a call) answers "does the owner have to read this Spec?" afresh from the rules, the Issue, the Spec and the
precedents, never the screen's verdict, and `judged` is 1 when the verdict agrees. A drift row of a sampled production run
carries it beside `valid`, so a sampled run says whether the screen was right and not only whether the JSON parsed.
Route and reliability: `docs/evals/2026-11-16-judged-drift.md`.
