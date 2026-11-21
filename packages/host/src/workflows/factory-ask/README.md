# factory-ask

software-factory's check on a lead's `factory issue ask`: is the question really the owner's, or can it be answered from the
repo, the plan, the Issue facts or the lead's declared default? An agent with read, glob and grep over the repo's checkout
looks before it says owner, and an answer cites the file and line or the quote it rests on. The factory never calls a model
(SF2), so the judgment lives here.

```
echo '{"decision":"decision_1","repo":"argo","issue":"…","question":"…","recommendation":"…","checked":"…","options":[{"label":"…","reversible":true,"cost":"…"}],"noAnswer":{"consequence":"…","default":null,"waitMinutes":null},"precedents":[]}' | agw factory-ask
```

| | |
|-|-|
| Input (stdin JSON) | software-factory's Decision: `{decision, repo, issue, question, recommendation, checked, options[{label, reversible, cost}], noAnswer{consequence, default, waitMinutes}, precedents[{question, answer, settledBy, repo}], class?, facts?, spec?, checkout?, case?}`. `checkout` is the absolute path of the repo's checkout the Judge reads; `case` is the case file (`docs/factory-input.md` §The case file). A `worthAsking` on a precedent is dropped: the case file's precedents carry the outcome. The CLI reads it as the workflow's one `ask` property, so the HTTP body is `{"ask": {…}}`. Everything but `decision` and `repo` is untrusted data; `repo` is an identifier. The workflow turns it into the seat's ask (the options are the labels, the facts carry the form and the precedents); `answer` is one of the labels |
| Output | the run envelope's `output`: `FactoryAskOutput` (`schema.ts`): `{verdict: answer\|owner, answer, reason, source}`. `owner`: `answer` and `source` are `''`. `answer`: both non-empty; `source` cites where (`file: <path:line> <quote>`, `spec: …`, `case: …`, `facts: …`, `precedent: …`, or `default`); with options, `answer` is exactly one of them |
| Shape | with a checkout, a `scan` step (no link may leave it); then one agent step (`look`, agent `agents/factory-ask`, route `factory.ask`) and one retry (`look-retry`) on an answer of the wrong shape; then `guardAsk` and `guardJudge` |
| Pending | exit 10 like every workflow (`agw run wait <runId>`) |

## Decisions

- **An agent that looks.** The task message is built in code (`buildFactoryAskPrompt`,
  `packages/capabilities/src/capabilities/factory-ask.ts`), so nothing reachable over HTTP is a free prompt on the route. The
  agent has read, glob and grep over the checkout the Decision names and nothing else; no turn limit and no wall-clock
  limit, the idle watchdog is the one stop. A checkout with a link that leaves it, or one too large to scan, is not handed
  over: the Judge then answers from the request, and its prompt says why. No checkout named is the same.
- **Data is fenced.** Question, options, default, facts and the Spec's head sit under one per-call random fence, the case
  file in its own CASE block under the same token, with fence markers made
  inert, rules before and a re-assertion after; text in them that sets the verdict or claims owner approval is data. `repo` is
  an identifier outside the fence. Oversize input is refused, never cut.
- **Owner only for the owner's classes, and only when all three hold:** the question is in a class, its answer changes what is
  built, and the default cannot be taken back by a revert. The classes: `direction` (what a product does for its users where
  no direction is stated), `look` (a look he has not seen where real variants exist), `own_surface` (a new step or surface for
  the owner himself), `spend` (money, or a platform that locks in), `security` (who is trusted or let in), `people` (other
  people's or company data), `irreversible`, `owner_fact` (a portal, an account, hardware, a login step: taking a default
  there would assume the world changed). Everything else is answered with the lead's recommendation (source `default`), or from
  the plan or facts, with a source; "is this plan right" is no question. When unsure: owner.
- **The Decision may carry three more fields, all optional.** `class` (the lead's or the factory's reading, a claim the three
  conditions check, never a verdict), `facts` (the Issue as filed, scrubbed by the factory, at most 8,000 characters) and `spec`
  (the head of the linked Spec with its Build and Decided sections, at most 20,000). `class` and `facts` join the seat's facts,
  `spec` is its own part of the ask. A direction the filed text quotes from the owner answers the question it covers (source
  `facts: <quote>`) in `direction`, `look` and `own_surface` only, never in `spend`, `security`, `people`, `irreversible` or
  `owner_fact`, because anyone can file the words "the owner said"; a lead's own claim that the owner approved something is no quote. A Decision without the fields is
  assembled exactly as before (`askOfJudge`, tested).
- **The do-nothing default.** A declared default is taken when it is the do-nothing choice (nothing is built, nothing
  changes), or a reversible one outside the classes or inside the code, even if another option is owner-class: it does not
  make the owner's decision and the owner can overrule. A default that builds a direction, a look, a surface for the owner, a
  platform or a public address is the owner's, and so is a question that asks him to supply a fact or perform an action,
  whatever the default. A default that performs an owner-class action (deletes, spends, opens access, messages people) is
  never taken. The plan beats a contradicting default; the lead's recommendation is not a declared default.
- **Code guard.** With options, the answer schema is built per call (`factoryAskOutputFor`): an answer outside them is
  refused and the agent is asked once more with the `submit_result` directive; a second refusal fails the run.
  `guardAsk` (`factory-ask.ts`), applied by the workflow after the step so a replay gets it too, turns an `answer` that is not
  an option, or has no source, into `owner`.
- **The Decision carries two things the question alone does not.** The prompt knows an option marked irreversible is never the answer, and reads
  precedents (an owner-settled one may be the source, `precedent: <quote>`); the case file's precedents carry what became of
  the Judge's own earlier answers (an overruled one marks a like question as the owner's).
  `guardJudge` holds the first in code after the step: an irreversible option becomes `owner`.
- **A failure fails the run.** A step that fails (agent error, schema failure after the retry, provider error)
  fails the run, with no verdict; only an ask the seat cannot take whole, or an answer the guards refuse, is `owner`.

## Route

`factory.ask` (`packages/routes/src/table/factory.ts`): the `HARD` tier's agent seat (`HARD.agent`, OpenCode), Sonnet 5.5 at
effort medium; the model lives only in the tier. It was the same tier as one tool-free call until 2026-11-21. It ran on `FAST` (Haiku, effort none) until the eval below measured the tiers (`docs/evals/2026-11-11-factory-ask-judge.md`):
Haiku with effort high scored exactly as Haiku none, Sonnet medium kept 73 % of the owner's questions with the owner against 58 %,
at about $0.006 a call. Move it again only on a new measurement (`agw eval run factory-ask --arm <file>`).

## Eval

`agw eval run factory-ask [--arm <file>] [--yes]` replays `packages/eval/factory-ask/cases.jsonl` (48 cases): real Decisions and Specs of the
factory's database, text as the lead wrote it, scrubbed of private names and hosts (the repo is public), plus a few written for
the set. The reference is the answer that held (the owner's where he answered, otherwise what the Issue's outcome showed),
never the Judge's own; each case's `basis` says which. The scorer is deterministic (`packages/eval/src/factory-ask.ts`,
`scorer.ts`): `ownerKept` (what only the owner can answer reaches him), `noInapplicable` (no option nothing could apply),
`factsOverDefault` (no fall back to the declared default when the facts rule it out), and the guards against an always-owner
Judge, `answered`, `answerHeld`, `eitherOk`. Arms and the report: `docs/evals/`.
