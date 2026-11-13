# factory-errand-needed

Once a day software-factory asks, for an open request for the owner's hands that has no `check` command, whether it is still
needed. The workflow answers `needed`, `not_needed` or `unsure`; the factory closes the request only on `not_needed` with a
non-empty reason.

```
echo '{"errand":{"id":"e_5","source":"example-app","summary":"Approve the sign-in prompt on test device A","detail":null,"command":null,"host":"iphone","raisedAt":"2026-11-05T09:00:00Z","ageHours":190},"evidence":"e_41 (20 hours old, open): Approve the sign-in prompt on test device B. Replaces e_5."}' | agw factory-errand-needed
```

| | |
|-|-|
| Input (stdin JSON) | `{errand{id, source, summary, detail, command, host, raisedAt, ageHours}, evidence}`. `summary` (1..200), `detail` (at most 4000 or null), `command` (at most 2000 or null) and `evidence` (at most 4000) are untrusted data. `host` is `macbook`, `iphone`, `portal` or `any`. `id`, `source`, `raisedAt` and `ageHours` are plain tokens the factory supplies. The CLI reads it as the workflow's one `request` property, so the HTTP body is `{"request": {…}}` |
| Evidence | scrubbed lines the factory builds: the same source's other requests of the last 14 days, each with its age and how it ended (open, or closed as done, not_needed, expired or superseded, by whom, with its note) |
| Output | the run envelope's `output`: `{verdict, reason}`, nothing else. `reason` is 1..300 characters on one line |
| Shape | one journaled step (`errand-needed`), one tool-free call to the internal `factory.errandneeded` capability, then `guardErrandNeeded` |
| Idempotency | the key `factory-errand-needed:<errand>:<day>` is the caller's (`agw run`); the workflow implements nothing for it |
| Pending | exit 10 like every workflow (`agw run wait <runId>`) |

## Decisions

- **The call is a capability.** `factory.errandneeded` builds the prompt, so nothing reachable over HTTP is a free prompt on the
  route; it is `internal`.
- **Data is fenced.** The instructions sit outside the fence; summary, detail, command and evidence sit inside one fenced block,
  every free-text field with its fence markers neutralized and the nonce computed over all of them. The id, source, host, raised
  time and age are validated tokens, so no line of text reaches the prompt unfenced through them.
- **`not_needed` only on evidence.** A newer request supersedes it, the same work was done and closed, or the text is conditional
  on something the evidence shows is gone. Age alone is never a reason. With no evidence the answer is `needed` or `unsure`.
- **When unsure, `unsure`.** A wrong `not_needed` costs the owner a request he still wanted; a wrong `needed` or `unsure` costs
  a minute.
- **Guard.** `guardErrandNeeded` runs in the workflow after the step, so a replay gets it too: the answer is exactly
  `{verdict, reason}` with the reason on one line and clipped to 300; a `not_needed` without a reason, or on a request whose
  evidence is empty, becomes `unsure`.
- **Fails soft in the factory, not here.** There is no catch: a failed or invalid call fails the run; the factory leaves the
  request open and names the failure. Cancelled, InfraError and StepFailed propagate.

## Route

`factory.errandneeded`: the `EASY` tier (Haiku high); the model lives only in the tier.

## Eval

`eval/cases.jsonl` (`PlainCase` lines of public placeholder material: no evidence, unrelated evidence, an open sibling doing
other work, a newer request that supersedes, the same work closed as done, a conditional whose condition is gone, a near-twin
that is a different request, ambiguous overlap, a vague closing note, and injections in the detail and the evidence).
Reference: `{verdict}`. The deterministic scorer (`scorer.ts`, 0/1 scores): `valid`, `verdict`, `safe` (no `not_needed` where
the reference is `needed`; a wrong `not_needed` is named in the feedback). `pass` is valid and verdict; a failed run scores 0
everywhere.
