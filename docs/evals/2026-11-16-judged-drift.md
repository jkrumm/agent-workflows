# Judged drift scores for `digest`, `factory.digest` and `factory-spec-screen` (2026-11-16)

Drift scored a sample of production runs of `digest` (52 rows) and `factory-spec-screen` (2 rows) with `{valid: 1}` only: a
scorer with no reference had nothing to say but "the JSON parsed", so 100 % on drift meant nothing about whether an answer was
right. Each scorer now asks a judge on the sampled run itself, and the three workflows below carry a `judged` score beside
`valid`. `factory.digest` had no scorer at all.

## What is judged

| Workflow | Question to the judge | `judged` is |
|-|-|-|
| `factory-spec-screen` | "Does the owner have to read this Spec?", from the rules, the Issue, the Spec and the precedents; never the screen's verdict | 1 when the verdict agrees (`pass` = true) |
| `factory.digest` | "Does every line of the digest say only what the Issues it cites show?", over the Issue list and the digest | 1 when yes |
| `digest` | per item (the first of each kind, at most four): heading, session and window faithful to the item's text; a reply's `asks` equal to the judge's reading of whether it asks | the mean over the items the judge answered |

A judged score is reported and never gates `pass` on a case with a reference; without a reference (drift) `pass` is false
only when the judge disagrees (spec-screen, factory.digest) or the mean is under 0.5 (digest). A judge that cannot answer
leaves the score out: a drift row then keeps `valid` alone, never a 0.

## The route: `decide`, the cheapest that held

`decide` is the IU decision API (`decision-1`, input-priced, boolean questions with a probability); the research scorer already
judges citations with it. A call costs about $0.00002 for a spec-sized state, against $0.006 for a Sonnet call
(`2026-11-11-factory-ask-judge.md`). No dearer route was tried: the probes below left no error to fix with one.

Probe 1, the 17 committed spec-screen cases (6 owner-labelled `settle`, 11 `pass` including two injections), the judge given the
Spec and nothing else of the screen: 17 of 17 with the precedents in its state, 16 of 17 without them (the one miss,
`pass-precedent-settled-needed`, is a case the owner's mark decides, which only the precedents carry). Cost of all 17: $0.0004.

Probe 2, `factory.digest`: three committed project snapshots, each with a faithful digest and one with an invented outcome, cause
or count (6 digests): 5 of 6. The judge refused every invented claim (3 of 3 `false`, probability 0.00); it also refused one
faithful digest (`stuck-chain`, which states a count of four from the queue list and "open five days" from a wait reason), so it errs toward
"unfaithful": `judged` under-reports and never over-reports on these.

## What it cannot say

- The judge is one model's reading, with no human check. The first probe's reference is the owner's labelling of the committed
  cases; the second is written by this change.
- `decide` reads at most 60 000 characters of state (the scorer keeps to 40 000); a digest request is far under it, a Spec's
  content is cut by the factory before it reaches the screen.
- The `digest` (item) judge asks a different question per kind and was not probed beyond the unit tests: its first real figures
  are the first drift rows after this change and the `judged` mean of `agw eval run digest`.

## Reproduce

```
agw decide --state "$(cat state.txt)" --questions '{"ownerReads":{"type":"boolean","instructions":"..."}}'
agw eval run factory-digest --yes     # judged is in each case's scores
```
