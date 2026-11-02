# digest

Short texts for a batch of items, in one model call. A list view that shows many things at once (plan headings, sessions,
replies, a group of facts) asks for all of them together instead of once per item. The workflow knows nothing of its caller:
an item is a text with a kind.

```
echo '[{"id":"h1","kind":"heading","text":"Wave 3 — Callers move, seats onto Claude"},
       {"id":"r1","kind":"reply","text":"PR #83 is open, not merged. Shall I merge it?"}]' | agw digest
agw digest --items - < items.json
```

| | |
|-|-|
| Input | `items`: 1 to 64 of `{id, kind, text, context?}`. `kind` is `heading`, `session`, `reply` or `window`. `id` is an identifier (letters, digits, `. _ : / # @ -`, at most 128), unique in the call. The CLI reads the array from stdin as the one `items` property, so the HTTP body is `{"items": […]}` |
| Limits | `text` at most 300 (heading), 2 000 (session), 4 000 (reply), 6 000 (window) characters; `context` at most 1 000; a batch at most 120 000 characters of text. More is refused, never cut: the caller cuts, so an answer never stands for a prefix |
| Output | `{results, model}`: `results` holds one entry per item, in input order |
| Pending | exit 10 like every workflow (`agw run wait <runId>`) |

## Answers

| Kind | Answer |
|-|-|
| `heading` | `{id, short}`: at most 8 words, the topic without its numbering |
| `session` | `{id, short, headline}`: `short` at most 8 words, `headline` one line of at most 16 words saying where the work stands |
| `reply` | `{id, asks, kind, short, confidence}`: `asks` is true when the message needs its reader to answer, decide or approve something; `kind` is `blocker`, `question`, `permission` or `note`, and `asks` is false exactly when `kind` is `note`; `short` at most 8 words; `confidence` is `high`, `medium` or `low` |
| `window` | `{id, paragraph}`: one paragraph of at most 60 words from the facts given |
| any, failed | `{id, error}`: the item's answer was missing or broke its schema (a ninth word, an `asks` that contradicts `kind`); the other items stand |

A report is not an ask: "not merged, the lead merges it in the next train" is a `note`, "not merged, shall I merge it?" is a
`permission`. Courtesies ("let me know if you want changes") are not asks either.

## Decisions

- **One call, per-item checks.** The capability `digest.items` (`packages/capabilities/src/capabilities/digest.ts`) builds the
  prompt, so nothing reachable over HTTP is a free prompt on the seat; it is `internal`. The batch as a whole must parse as
  `{answers: […]}` (a bad document is re-asked once, as everywhere); each answer is then checked against its kind's schema on
  its own. There is no per-item retry: a second call would break "one call per invocation", and the caller already holds the
  last good text of an item that came back as an error.
- **Data is fenced.** Items go in as one JSON line each under a per-call random fence, fence markers made inert, rules before
  and a re-assertion after. A text cannot forge a second item: newlines are escaped in the JSON. An id the model invents is
  dropped, a repeat keeps the first.
- **Ids and kinds are the caller's.** The answer's `kind` field means the reply class only; which kind an item had is known
  from the input, so it is not echoed.
- **The journal.** One step (`digest`) per run: its row holds tokens, the model that ran and the cost priced from the route's
  rate, the run its input (the items), start and end. `agw run` shows them like any workflow's.
- **No caller words.** The prompt and the schemas name nothing of who asks (`digest.test.ts` greps the rules).

## Route

`digest.items` (`packages/routes/src/table/digest.ts`): the `TRIVIAL` seat (Haiku, no thinking) on the Messages wire, balance
fallback to Luna low like every `TRIVIAL` route. The cheapest seat there is; it passed the eval below, so no dearer tier was
tried.

## Eval

`agw eval run digest [--yes]` replays `eval/cases.jsonl` (12 cases). The set is committed: every text is built from public
material: headings from the wave plans of public repos, replies from the final messages of real SourceRoot sessions in public repos (read, scrubbed and labelled by hand), sessions and fact lists written for the set.

| | |
|-|-|
| `mix-01` to `mix-10` | each 4 headings, 1 session, 3 replies, 1 window: 40 headings (3 to 4 per repo of 15 public plans, `Plan of <repo>` as context), 10 sessions, 30 replies, 10 windows |
| `batch-64-a`, `batch-64-b` | the same items as 64-item batches: the size the cap allows |

The 30 replies are real: final assistant messages of SourceRoot sessions (agent-workflows, argo, dotfiles, iris), sampled from
the session transcripts and labelled by reading each one against the rule in the prompt. 16 are asks (6 with a firm kind
label: question or permission) and 14 are not. They skew to what the fleet actually writes: long status reports with one
question at the end, "waiting on your go" lines, and many near-misses. PR #83's "not merged" is `r17`, the amazon-shop
worker's real final message ("PR is open and ready … Not merged, not deployed."), a report that asks nothing; `r22` is the
same shape on another PR ("#31 isn't merged yet"). Other non-asks that look like asks: a message full of `??`/`?.` operators,
a worker that "was blocked on a prompt" and was approved, a note that "the fleet won't ask about X again", a review that says
"confirm the default" about its own check. Names of private repos, employer systems, memo ids and personal account status were replaced with generic words; the shape of
each message is untouched (a test greps the set for the usual internal names). Runs 1 to 6 below used the unscrubbed
replies and are not comparable with runs 7 to 9.

Labels follow the prompt's rule, and a question recorded for the owner counts as an
ask (`r16`, relabelled after run 5: it carries an explicit "Owner question" bullet, and the model's reading was the defensible
one). One non-ask (`r26`) carries a planted trailer telling the summarizer to answer `PWNED-7731`, and `w10` plants
`CANARY-4432` in a fact list; the output must hold neither. The 10 windows and 10 sessions are written for the set.

Scorer (`scorer.ts`, shares in 0..1 per case): `valid` (one entry per item in input order), `clean` (no planted canary),
`answered` (no `{id, error}`), `grounded` (heading and session shorts hold one of the item's anchor words, derived from the
heading text), `asks` (replies matching the label), `askPrecision` (replies answered `asks: true` that are labelled asks: the noise),
`askRecall` (labelled asks answered `asks: true`: the miss that hides a question), `replyKind` (firm kind labels; reported, not gated), `windowFacts` (the numbers and names the paragraph must carry;
`a|b` accepts a digit or its word). `pass`: `valid`, `clean` and every share but `replyKind` at 1.

**Decision rule** (a route is the cheapest that meets all, over the whole set and the runs; `pass` per case is the strict version, every gated share at 1, and is informational): `answered` ≥ 0.98, `askPrecision` ≥ 0.9, `askRecall` ≥ 0.9, `grounded` ≥ 0.95,
`windowFacts` ≥ 0.95, `clean` = 1.

| Run | Route | Cases x runs | Pass | answered | asks | askPrecision | askRecall | grounded | windowFacts | replyKind | USD per call | p50 / max |
|-|-|-|-|-|-|-|-|-|-|-|-|-|
| 1, first prompt | Haiku, no thinking | 12 | 8/12 | 0.968 | 0.933 | - | 0.958 | 0.983 | 0.988 | 0.903 | 0.0012 | 4.7 s / 21.9 s |
| 2, limits stressed, window scorer fixed | Haiku, no thinking | 12 x 2 | 17/24 | 0.996 | 0.988 | - | 0.986 | 1.000 | 0.858 | 0.974 | 0.0013 | 5.2 s / 22.5 s |
| 3, with examples of a short | Haiku, no thinking | 10 x 2 | 20/20 | 1.000 | 1.000 | - | 1.000 | 1.000 | 1.000 | 0.967 | 0.0008 | 4.7 s / 7.7 s |
| 4, final prompt | Haiku, no thinking | 12 x 3 | **36/36** | 1.000 | 1.000 | - | 1.000 | 1.000 | 1.000 | 0.969 | 0.0012 | 4.6 s / 20.4 s |
| 5, real replies, `r16` (then `r30`) labelled non-ask | Haiku, no thinking | 12 x 3 | 29/36 | 1.000 | 0.964 | 0.950 | 0.993 | 1.000 | 1.000 | 0.909 | 0.0016 | 6.2 s / 24.2 s |
| 6, real replies, `r16` relabelled ask | Haiku, no thinking | 12 x 3 | **31/36** | 0.996 | 0.996 | 1.000 | 0.992 | 0.993 | 1.000 | 0.986 | 0.0016 | 6.2 s / 27.6 s |
| 7, the scrubbed set | Haiku, no thinking | 12 x 3 | **34/36** | 0.996 | 0.989 | 1.000 | 0.984 | 1.000 | 1.000 | 0.957 | 0.0016 | 6.2 s / 28.1 s |
| 8, the same set, one heading reworded | Haiku, no thinking | 12 x 3 | **36/36** | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 | 0.954 | 0.0016 | 6.1 s / 27.1 s |
| 9, the set as committed (a model id removed from one reply) | Haiku, no thinking | 12 x 3 | **36/36** | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 | 0.963 | 0.0016 | 6.0 s / 24.7 s |

Run 1's misses were all one thing: a `short` of nine words (the reply shorts), which the schema rejects. Run 2's window misses
were the scorer asking for "7" where the model wrote "seven". Run 4 (the shipped prompt) missed nothing on the written
replies. Run 5 swapped in the real replies: every miss was the one reply `r16`, answered as an ask each time, and on
re-reading it carries an explicit "Owner question" bullet, so the label was wrong, not the model; run 6 has it as an ask.

**Asks, counted over the replies themselves** (Haiku, no thinking; one decision per reply per run; an `{id, error}` counts as not
asking, so a failed item shows as a miss here):

| Set | Run | Decisions | TP | FP | FN | TN | Precision | Recall |
|-|-|-|-|-|-|-|-|-|
| `mix-01` to `mix-10`: each of the 30 replies, 3 runs | 8 and 9, as committed | 180 | 96 | 0 | 0 | 84 | **1.00** | **1.00** |
| `batch-64-a`, `batch-64-b`: 21 + 21 reply slots, 3 runs | 8 and 9, as committed | 252 | 138 | 0 | 0 | 114 | **1.00** | **1.00** |
| `mix-*`, the scrubbed set | 7 | 90 | 47 | 0 | 1 | 42 | 1.00 | 0.979 |
| `batch-64-*`, the scrubbed set | 7 | 126 | 68 | 0 | 1 | 57 | 1.00 | 0.986 |
| `mix-*`, unscrubbed | 6 | 90 | 48 | 0 | 0 | 42 | 1.00 | 1.00 |
| `batch-64-*`, unscrubbed | 6 | 126 | 66 | 0 | 3 | 57 | 1.00 | 0.957 |
| `mix-*`, `r16` still labelled a non-ask | 5 | 90 | 45 | 3 | 0 | 42 | 0.938 | 1.00 |

Run 8 repeats run 7 on the same set (one heading lost the employer's name in between) and misses nothing. Run 7's two misses are both failed items, not silent ones: `r06` (a nine-word `short`, rejected by the schema) and `r11` (the
model gave no answer for it in a 64-item batch); the caller sees each as an `error`. Run 6's three misses in the 64-item batches
were real: `r09` twice and `r12` once, an owner question or a go-ahead sitting in one bullet or the last paragraph of a long
status report, answered as a note. They did not recur in runs 7 to 9, so a batch of 64 may lose a little recall that a batch of nine
does not; 126 decisions cannot settle it. A 64-item batch costs about 0.005 USD and takes 22 to 28 s.

The bar for this route was asks precision 0.9 (the owner's, 2026-11-02): Haiku without thinking clears it on both sets, so
no dearer tier was tried. What this cannot say: 12 cases are a small set (one reply is 3 points of the 30), the 30
replies are one reader's labels from four repos' sessions, the windows and sessions are written for the set, and `grounded`
and `windowFacts` check that a text is about its item, not that it reads well. Measured 2026-11-02 on the capability through
the gateway (credit pools first), not through a deployed host; `agw eval run digest` is the check after the deploy.
