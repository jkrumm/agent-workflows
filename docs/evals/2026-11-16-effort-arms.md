# Effort arms for cheap.extract, factory.queue and factory.triage (2026-11-16)

Issue 1594. The question: do the three `EASY`-tier calls that the ledger showed spending most of their output on
reasoning (`cheap.extract` 47 % of output tokens on `cap.web.read`, `factory.queue` and `factory.triage` 358 and 606
tokens per call) hold their quality at effort `low` or `none`, and what does it buy.

**Decision: all three stay on `EASY` (Haiku, effort high).** Queue and triage hold at both lower efforts but there is
nothing to win (background loops, cents), and the tier set is the owner's. Extraction does not hold: it keeps its facts
but loses completeness, by an amount the CI separates from zero. The price of moving it is stated below; it is one line
(`cheap.extract: { wire: 'anthropic', ...FAST.call }`) if the owner takes that trade.

## Method

- **Arms:** `high` (the route today), `low`, `none`, applied as route patches on the one route under test
  (`ctx.arm.routes`, the same mechanism `agw eval run --arm` uses), against the gateway on the eval reserve (purpose
  `eval`). `none` runs on the code of this change, which sends `thinking: disabled` (`docs/gateway.md` §Thinking at effort
  none); before it a `none` arm thought by default and was not an arm.
- **Harness:** a throwaway script calling `complete`/`registry.call` with the production prompts, one call in flight at a
  time (so wall time is the call's own); raw `usage.output_tokens_details.thinking_tokens`
  read from each response. The script is not committed: `cheap.extract` and `factory.queue` have no eval suite
  (`factory-queue` by the owner's decision RS13), so there is nothing to register an arm on, and the wired suite for triage
  runs the production scorer.
- **`web.read` has no suite either.** 12 public pages of 3 to 60 k characters (docs, reference and encyclopedia pages:
  Bun spawn, SQLite, MDN `AbortSignal.timeout` and `fetch`, PostgreSQL `CREATE INDEX`, Mac mini, GitHub runners, Claude
  extended thinking, the Bun README, Cloudflare, Kubernetes pods, SQLite WAL), each with one concrete question, read once
  through `agw web fetch` and extracted with the route's own system prompt. Two passes of 12 per arm (24 calls).
  Scoring: the `eval.judge` seat reads page, request and extract and scores `complete` (nothing relevant missing) and
  `faithful` (nothing added or softened) 1 to 5. One judge, no human check.
- **Queue:** 14 synthetic public cases (unrelated Issues, related topics that need no edge, a migration then its consumer,
  a refactor then an edit of the same file, a fix then its test, a running Issue on the same file, a prio tie, an existing
  edge, a chain of two edges, an injection in a title, six small unrelated), two repetitions per arm, 28 calls per arm. The
  reference is the exact edge set a careful reader proposes; 8 of 14 expect none.
- **Triage:** the committed suite (`packages/host/src/workflows/factory-triage/eval/cases.jsonl`, 16 settle cases) with the
  production scorer (`2026-11-14.1`), two repetitions per arm, 32 calls per arm.

## cheap.extract (web.read), 24 calls per arm

| Arm | wall p50 | wall mean | output tokens | thinking tokens | complete | faithful |
|-|-|-|-|-|-|-|
| high | 4.30 s | 4.80 s | 1,223 | 493 | 4.61 | 4.39 |
| low | 2.40 s | 2.69 s | 688 | 65 | 4.21 | 4.29 |
| none | 2.17 s | 2.40 s | 627 | 0 | 4.33 | 4.33 |

Paired difference to `high` (23 pairs with both judged):

| Arm | complete | 95 % CI | faithful | 95 % CI |
|-|-|-|-|-|
| low | -0.43 | -0.68 to -0.19 | -0.09 | -0.36 to +0.19 |
| none | -0.30 | -0.50 to -0.11 | -0.09 | -0.45 to +0.28 |

Reading: faithfulness holds at both arms. Completeness does not: both lose 0.3 to 0.4 points, and the interval excludes
zero both times. Most of it is length: `high` writes about twice the tokens (1.2 k against 0.65 k), and the judge rewards
detail around the request. Whether a reader misses that detail was not measured. `low` is worse than `none` and no
faster, because at `low` the model still thinks a little (65 tokens) and the 0 to 28 reasoning tokens the Sonnet arms
spent in the 2026-11-02 sweep show that `low` is "adaptive decides", not "off".

**The latency a move would buy.** Extraction wall p50 falls from 4.3 s to 2.2 s (`none`). The ledger's fresh direct
`cap.web.read` p50 of 5.6 s sits about 1 s above this harness's extraction p50 at `high` (the fetch, the run envelope and
larger pages), so `none` predicts about 3 s: at the edge of the issue's "median under 3 s" line, not clear of it. That
and the completeness loss are why the route did not move.

## factory.queue, 28 calls per arm (14 cases x 2)

| Arm | edge set exact | false edges | missed edges | lawful order | wall p50 | output tokens | thinking tokens |
|-|-|-|-|-|-|-|-|
| high | 55 / 56 | 1 | 1 | 28 / 28 | 2.81 s | 343 | 239 |
| low | 56 / 56 | 0 | 0 | 28 / 28 | 2.0 s | 208 | 102 |
| none | 56 / 56 | 0 | 0 | 26 / 28 | 1.9 s | 107 | 0 |

Edge counts are over two runs of the 28 calls (56 per arm); the order check was fixed after the first run, so it covers the
second run only (28 per arm). The one `high` error was a false edge and a missed one on the same-file refactor case, once.
The two `none` order errors are one case twice: `running-same-file` lists the running Issue in `order`, which holds only
the queued ones. Empty answers: 57 % of calls in every arm (the cases that expect none). Every arm answers the injection
case with no edge.

Reading: quality holds at `low` and at `none` within what 14 cases can show (one slip in 56 for `high`, two order slips in
28 for `none`). The gain is 0.8 s on a background loop and about 130 to 240 output tokens per call; the loop's calls are
cents a month. Not moved: nothing to win, and the effort `none` tier (`FAST`) would also swap the fallback to Luna.

## factory.triage, 32 calls per arm (16 cases x 2)

| Arm | pass | checkpoint | wall p50 | output tokens | thinking tokens |
|-|-|-|-|-|-|
| high | 30 / 32 | 30 / 32 | 2.53 s | 329 | 226 |
| low | 31 / 32 | 31 / 32 | 1.82 s | 135 | 34 |
| none | 30 / 32 | 30 / 32 | 1.86 s | 105 | 0 |

Misses: `high` fails `inject-precedent` twice and `low` once (the owner's mark on a similar screen is read as "no Spec"),
`none` fails `architecture` twice (flags a Spec on an architecture choice, which the rule says is not one). Different
cases, the same count: the suite cannot separate the arms. Not moved, for the queue's reason.

## Limits

One judge for the extraction, no human check; 12 pages of reference material, not the bot-walled and shop pages the
fetch chain also feeds `cheap.extract` (`shop.item` and `shop.find` share the route, so a move would reach them unmeasured);
14 synthetic queue cases and a 16-case triage suite are small. The numbers say where the arms are indistinguishable and
where extraction completeness drops; they do not rank queue and triage arms.
