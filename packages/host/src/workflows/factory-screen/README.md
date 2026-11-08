# factory-screen

The Judge of software-factory screens a held signal and answers one of three things: `promote` (it is the repo's work),
`dismiss` (spam, a probe, a duplicate of an open Issue) or `leave` (unclear: the owner decides).

```
echo '{"signal":{"id":"sig_7","source":"feedback:example-app","kind":"feedback","origin":"feedback","repo":"example-app","title":"…","text":"…","link":null,"receivedAt":"2026-11-08T09:12:00.000Z"},"openIssues":[{"id":"issue_31","title":"…","kind":"bug","state":"working"}],"projects":["example-app","example-api"]}' | agw factory-screen
```

| | |
|-|-|
| Input (stdin JSON) | `{signal{id, source, kind, origin, repo, title, text, link, receivedAt}, openIssues[], projects[]}`. `openIssues` are `{id, title, kind, state}` (at most 40): the open Issues of `signal.repo`, empty without a repo; `projects` (at most 60) are the known projects that are not work repos. The CLI reads it as the workflow's one `request` property, so the HTTP body is `{"request": {…}}`. `source`, `title`, `text` and `link` are untrusted data |
| Output | the run envelope's `output`: `{verdict, reason, repo, duplicateOf, recommendation}`. `repo`: only on a `promote` of a signal without a repo, one of `projects`. `duplicateOf`: only on a `dismiss`, an id from `openIssues`. `recommendation`: only on a `leave`, one sentence for the owner. `reason` and `recommendation` are 1..300 characters |
| Shape | one journaled step (`screen`), one tool-free call to the internal `factory.screen` capability, then `guardScreen` |
| Idempotency | the key `screen:<signal>:<attempt>` is the caller's (`agw run`); the workflow implements nothing for it |
| Pending | exit 10 like every workflow (`agw run wait <runId>`) |

## Decisions

- **The call is a capability.** `factory.screen` builds the prompt, so nothing reachable over HTTP is a free prompt on the
  route; it is `internal`.
- **Data is fenced.** The instructions sit outside the fence; the signal's fields and the Issue and project lists sit inside
  one fenced block, every free-text field with its fence markers neutralized and the nonce computed over all of them.
- **When unsure, leave.** Promote only a concrete bug or request about the project; dismiss only what is clearly not work.
- **Guard.** `guardScreen` runs in the workflow after the step, so a replay gets it too, and fails closed to `leave`; it never
  rewrites a claim into another acting verdict. A promote of a signal with a repo clears `repo` (the factory uses the
  signal's own); a promote without one must name one of `projects`; a dismiss with `duplicateOf` must name an Issue it was
  shown; a `leave` always carries a recommendation (the reason when the model gave none). A downgraded `leave` carries the
  guard note plus the model's reason, on one line, as reason and recommendation. The factory re-checks the repo and the
  duplicate id before it acts.
- **Fails open to a retry, not to `leave`.** There is no catch in the workflow (unlike `factory-triage`): a failed or invalid
  call fails the run. The factory records a failed call with a backoff and retries; a fake `leave` would mark the signal
  screened for good. Cancelled, InfraError and StepFailed propagate.

## Route

`factory.screen`: the `EASY` tier (Haiku high); the model lives only in the tier.

## Eval

`eval/cases.jsonl` (14 `PlainCase` lines of public placeholder material: probes, duplicates, a near-miss, spam, bugs and
requests with and without a repo, vague and ambiguous signals, a support question, an injection, a GitHub bug). Reference:
`{verdict, duplicateOf, repo}`. The deterministic scorer (`scorer.ts`, 0/1 scores): `valid`, `verdict`, `safe` (no acting
verdict that differs from the reference's; a wrong act is named in the feedback), `duplicate` (the exact id for a dismiss
reference with one), `repo` (for a promote reference, `signal.repo` else the answer's repo). `pass` is valid, verdict,
duplicate and repo; a failed run scores 0 everywhere.
