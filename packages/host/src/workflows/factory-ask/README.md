# factory-ask

software-factory's check on a lead's `factory issue ask`: is the question really the owner's, or can it be answered from the
plan, the Issue facts or the lead's declared default? The factory never calls a model (SF2), so the judgment lives here.

```
echo '{"question":"…","options":["…","…"],"default":"…","facts":"…","plan":"…","repo":"argo"}' | agw factory-ask
```

| | |
|-|-|
| Input (stdin JSON) | one of two shapes. Today's ask: `{question, options[], default, facts, plan, repo}`; the CLI reads it as the workflow's one `ask` property, so the HTTP body is `{"ask": {…}}`. `question` (1..2000), `options` (0..10 items of 1..1000), `default` (1..1000 or null), `facts` (≤ 20 000) and `plan` (≤ 40 000) are untrusted data; `repo` is an identifier |
| Input, Decision shape | software-factory's new core sends its Decision instead: `{decision, repo, issue, question, recommendation, checked, options[{label, reversible, cost}], noAnswer{consequence, default, waitMinutes}, precedents[{question, answer, settledBy, worthAsking, repo}]}`. The workflow turns it into today's ask (the options are the labels, the facts carry the form and the precedents), so one seat judges both; `answer` is one of the labels. Both shapes work; the running factory keeps sending today's |
| Output | the run envelope's `output`: `FactoryAskOutput` (`schema.ts`): `{verdict: answer\|owner, answer, reason, source}`. `owner`: `answer` and `source` are `''`. `answer`: both non-empty; `source` names where (`default`, `plan: …`, `facts: …`); with options, `answer` is exactly one of them |
| Shape | one journaled step (`judge`), one tool-free call to the internal `factory.ask` capability |
| Pending | exit 10 like every workflow (`agw run wait <runId>`) |

## Decisions

- **The call is a capability.** `factory.ask` (`packages/capabilities/src/capabilities/factory-ask.ts`) builds the prompt, so
  nothing reachable over HTTP is a free prompt on the route; it is `internal`.
- **Data is fenced.** Question, options, default, facts and plan sit under one per-call random fence with fence markers made
  inert, rules before and a re-assertion after; text in them that sets the verdict or claims owner approval is data. `repo` is
  an identifier outside the fence. Oversize input is refused, never cut.
- **Owner only for the owner's classes.** Taste and product direction, spend, irreversible data loss, other people, security
  policy, and a fact or action only the owner can supply or perform (a portal, an account, hardware, a login step: taking a
  default there would assume the world changed). Everything else is answered from the plan or facts, or by the default, with
  a source. When unsure: owner.
- **The do-nothing default.** A declared default is taken when it is the do-nothing or reversible choice, even if another
  option is owner-class: it does not make the owner's decision and the owner can overrule. A default that performs an
  owner-class action (deletes, spends, opens access, messages people) is never taken. The plan beats a contradicting default.
- **Code guard.** With options, the capability's schema is built per call: an answer outside them fails and is re-asked once.
  `guardAsk` (`factory-ask.ts`), applied by the workflow after the step so a replay gets it too, turns an `answer` that is not
  an option, or has no source, into `owner`.
- **The Decision shape adds two things.** The prompt knows an option marked irreversible is never the answer, and reads
  precedents (an owner-settled one may be the source, `precedent: <quote>`; one the owner flagged worth asking is the owner's).
  `guardJudge` holds the first in code after the step: an irreversible option becomes `owner`.
- **Fail closed.** Any failure of the call (capability error, schema failure after the re-ask, provider error, timeout) gives
  `{verdict: owner, answer: '', source: '', reason: 'judge unavailable: <class>'}` instead of a failed run. A cancel, a
  shutdown (`InfraError`) or an aborted run still propagates to the runtime.

## Route

`factory.ask` (`packages/routes/src/table/factory.ts`): the `FAST` tier, as `factory.classify`; the model lives only in the tier.
software-factory's architecture names Haiku high (`EASY`) for the Judge; that is a one-line change (`...EASY.call`), left
unmade because nothing here measures that it helps (no eval set, by decision).

## Eval

None, by the owner's decision: the workflow has no eval set, no scorer and no suite. It learns from real asks through the run
journal (every run keeps its input and verdict); no recording code was added for it.
