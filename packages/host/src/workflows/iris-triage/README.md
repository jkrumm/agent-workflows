# iris-triage, iris-gist

Two eval-only workflows (`internal`: no command, no route) that replay the two model calls Iris waits on, so `agw eval run --arm`
can run their routes at another reasoning effort. Iris keeps calling `agw triage` and `agw llm summarize`.

| Suite | Replays | Route under test | Input of a case |
|-|-|-|-|
| `iris-triage` | the `triage` capability: headline, detail and spoken line of a notification | `triage` | `{destination, transcript, reply}` |
| `iris-gist` | the `llm.summarize` call behind `transcriptGist`: 30 words, a paragraph | `cheap.summarize` | `{text, maxWords}` |

`cheap.summarize` also serves `shop.item`'s summary: an arm on it moves the gist only, a change to the route moves both.

## Cases

Real Iris memos, so they never enter the repo. `make eval-mine-iris` reads the journal (runs of purpose `iris`, read-only) and
writes `$AGW_EVAL_DIR/iris-triage/cases.jsonl` and `iris-gist/cases.jsonl` (mode 0600), one case per distinct input, the ids
`<suite>-<first 8 of the input hash>`. Triage takes every transcribe-only memo up to 14 (the path whose latency Iris waits on)
and fills to 30 with memos that have a reply, spread over the whole history; the gist takes up to 30. A mined case has no
reference (`{}`); a hand-written one may add `mustMention` terms (`a|b` accepts either) and `forbid` strings.

## Scores

Every score is 0 or 1 unless said; when `valid` is 0 so is every other score.

| Score | Both / suite | Measures |
|-|-|-|
| `valid` | both | the output parses; a gist is not empty |
| `language` | both | the text is in the memo's language (German or English by stopwords; 1 when too short to tell) |
| `spoken` | triage | at most two sentences, no markup a voice would read out |
| `words`, `fits`, `plain` | gist | at most `maxWords` words; at most 240 characters (Iris cuts there); one line, no markup, no opening about the task |
| `clean`, `mentions` | both | the reference's `forbid` and `mustMention` (1 with none) |
| `faithful` | both | judged: nothing in the text is invented, changed or contradicted |
| `headline`, `detail`, `spokenOk` | triage | judged: the headline names the topic, the detail matches the reply (or what the memo asks), the spoken line says the same outcome briefly |
| `gist` | gist | judged: the summary states the main point of the text |
| `oneCall` | triage | the answer came on the first call; reported, not gated |

The judge is the `decide` capability (the IU decision API, input-priced): one call per case, boolean questions over the
transcript, the reply and the answer. A question it cannot answer is left out of the case, never a 0. `pass` is every score
(but `oneCall`) at 1. A text that fails a judged question carries the question in the case's `feedback`.

## Arms

```
agw eval run iris-triage --yes                                                       # high: the route today
agw eval run iris-triage --yes --arm <(echo '{"routes":{"triage":{"effort":"low"}}}')  # file with {"routes":{"triage":{"effort":"low"}}}
agw eval compare iris-triage --a <fingerprint of high> --b <fingerprint of low> --b-args '{...}'
```

`--arm` takes a JSON file's content; the efforts are `none` (thinking disabled), `low`, `medium`, `high`. The case's cost,
wall time and tokens are in `agw eval compare` as spend metrics; the call's own latency is in each run's output (`latencyMs`).
