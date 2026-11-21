# factory-errand

Software-factory holds every Errand a lead raises ("I need the owner's hands") and has this workflow screen it before the
owner is paged. It answers `pass` (a person's hands, worth the owner's time) or `turn_away` (a CLI or token can do it, the lead
can route around it, or it is not worth a minute).

```
echo '{"errand":{"id":"e_7","summary":"Approve the sign-in prompt on the test device","detail":null},"issue":{"id":"issue_31","repo":"example-app","title":"Add a sign-in screen","kind":"feature"}}' | agw factory-errand
```

| | |
|-|-|
| Input (stdin JSON) | `{errand{id, summary, detail, command?, host?, need?}, issue{id, repo, title, kind}}`. `summary` (1..500), `detail` (at most 8000, or null) and `command` (at most 2000, optional) are untrusted data, as is `issue.title`. `host` is `mini` or `macbook`, `need` is `secret`, `hands`, `place` or `approval`; all three are optional, and an input without them behaves as before. The CLI reads it as the workflow's one `request` property, so the HTTP body is `{"request": {…}}`. An optional `case` carries the case file (`docs/factory-input.md` §The case file); a request without one is answered as before |
| Output | the run envelope's `output`: `{verdict, reason}`, nothing else. `reason` is one line of at most 240 characters; on a `turn_away` it is written to the lead and says what to do instead |
| Shape | one journaled step (`errand`), one tool-free call to the internal `factory.errand` capability, then `guardErrand` |
| Idempotency | the key `factory-errand:<errand>:<try>` is the caller's (`agw run`); the workflow implements nothing for it |
| Pending | exit 10 like every workflow (`agw run wait <runId>`) |

## Decisions

- **The call is a capability.** `factory.errand` builds the prompt, so nothing reachable over HTTP is a free prompt on the
  route; it is `internal`.
- **Data is fenced.** The instructions sit outside the fence; the summary, detail and Issue title sit inside one fenced block,
  every free-text field with its fence markers neutralized and the nonce computed over all of them.
- **Three questions.** Hands or a call a token can make; worth the owner's time; could the lead route around it. `pass` only
  when it needs hands and is worth them.
- **Typed fields, not prose.** `command` sits inside the fence with its markers neutralized (and in the nonce); `host` and `need` are enums and sit inside it as one line each. The MacBook rule (the mini cannot run a MacBook command, so a turn_away never tells the lead to run it itself) is part of the instructions, outside the fence, and appears only when `host` is `macbook`. The prose `summary` and `detail` stay accepted, so the caller can move its facts over at its own pace.
- **When unsure, pass.** A wrong turn-away costs the lead a round trip, a wrong pass costs the owner a minute.
- **Guard.** `guardErrand` runs in the workflow after the step, so a replay gets it too: the answer is exactly
  `{verdict, reason}` with the reason on one line and clipped to 240 (the model's own reason may be up to 2,000 characters before it is re-asked); a `turn_away` without a reason becomes a `pass`.
- **Fails open to a retry, not to a verdict.** There is no catch: a failed or invalid call fails the run and the factory
  retries with a backoff. Cancelled, InfraError and StepFailed propagate.

## Route

`factory.errand`: the `EASY` tier (Haiku high); the model lives only in the tier.

## Eval

`eval/cases.jsonl` (`PlainCase` lines of public placeholder material: CLI-only errands, a biometric prompt, device pairing, a
portal step, account recovery, typed twins of the prose cases and one MacBook sudo step (`typed-*`: `command`, `host`, `need`), a probe fixture, a hygiene check, injections in the detail, a vague one, one without detail).
Reference: `{verdict}`. The deterministic scorer (`scorer.ts`, 0/1 scores): `valid`, `verdict`, `safe` (no turn-away where the
reference is `pass`; a wrong turn-away is named in the feedback). `pass` is valid and verdict; a failed run scores 0
everywhere.
