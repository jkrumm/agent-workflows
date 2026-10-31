# Review eval: Claude on the direct Anthropic API, Haiku by effort and Sonnet low (2026-10-31)

**Change measured:** `review.angle`, `review.angle.deep` and `review.synthesis` moved to `claude-haiku-5-5` (effort
`none`, `low`, `high`, `max`) and `claude-sonnet-5-5` (`low`) on the `anthropic-direct` OpenCode provider (commit
5e1a871), one arm at a time through `~/.config/agw/routes.json`. Every other review route stayed on the live table
(router, OCR, adversary: Terra). Baselines are the 2026-10-30 arms on IU.

**Cases:** the first 12 of `review/cases.jsonl` (`agw eval run review --limit 12 --args '{"depth":"deep"}'`), the same
12 ids for every arm. Scorer `2026-10-28.1`.

**Verdict:** no tier decision from this set. The scorer cannot tell review quality apart (below). What it does settle:
cost, wall time, tokens and failure modes per arm, and that effort reaches Claude only since 5e1a871.

## Results (per review, means over 12 cases; wall time p50 and max)

| Arm | Agreement | Recall | USD | Wall p50 / max s | Input k | Cache read k | Output k | Reasoning k | Failed steps |
|-|-|-|-|-|-|-|-|-|-|
| Haiku none (direct) | 0.08 | 0.00 | 0.039 | 36 / 55 | 383 | 214 | 12.8 | 1.7 | 0 |
| Haiku via IU, effort not applied (10-30) | 0.17 | 0.05 | 0.059 | 92 / 187 | 545 | 347 | 32.3 | 22.9 | 0 |
| Haiku low (direct) | 0.08 | 0.00 | 0.065 | 43 / 86 | 281 | 106 | 19.3 | 12.7 | 0 |
| Haiku high (direct) | 0.50 | 0.05 | 0.150 | 193 / 383 | 1858 | 1510 | 97.2 | 78.0 | 0 |
| Terra medium (IU, 10-30) | 0.67 | 0.00 | 0.434 | 83 / 144 | 1237 | 949 | 18.8 | 6.7 | 0 |
| DeepSeek flash default (IU, 10-30) | 0.67 | 0.05 | 0.511 | 576 / 1438 | 14751 | 14272 | 230.5 | 185.3 | 0 |
| Sonnet low (direct) | 0.08 | 0.00 | 0.522 | 41 / 98 | 372 | 199 | 10.0 | 3.6 | 1 |
| Haiku max (direct) | 0.08 | 0.00 | 1.166 | 1881 / 2232 | 6337 | 5496 | 427.6 | 388.6 | 23 |

Agreement = `outcomeAgreement`, recall = blocking-finding recall against the reference. Precision was 0 to 0.08 on
every arm. Not run (cancelled to free the host): Sonnet medium, DeepSeek flash at effort high.

Fingerprints: Haiku none `50c3872b`, low `666f0748`, high `139485ca`, max `27d3b7ea`, Sonnet low `05869e98`; 10-30:
DeepSeek `4ba5746d` (args `{"depth":"deep"}`), Terra `65e73bc6`, Haiku IU `a4508673`.

## Why the scorer cannot pick a model

- The reference is agent-gateway's recorded outcome, not ground truth: 110 of 138 cases `actionable`, 24
  `needs-human`, 4 `clean`. The gateway's own rerun agreed with it 21 % of the time (`packages/eval/README.md`).
- `actionable` means at least one finding survived at severity `blocking`. Agreement therefore tracks a model's
  readiness to say "blocking": Terra 87 blocking findings over the 12 reviews, DeepSeek 23, Haiku high 15, Sonnet low 5.
  Every arm's angles find issues; they differ in severity calibration.
- Recall and precision sit at 0 to 0.05 on every arm: no model reproduces the gateway's findings, so they carry no
  signal at n=12 either.

## What the runs did establish

- **Effort was never applied to Claude before 5e1a871.** OpenCode's Anthropic protocol ignores `reasoningEffort`; the
  variant now sends `effort` plus adaptive thinking (or `thinking: disabled` for `none`). Verified on the wire: messages
  carry provider `anthropic-direct` and the route's variant, reasoning tokens move with effort.
- **Haiku max is unusable for agent steps:** it reads until the context overflows. 23 failed steps, all
  `Compaction summary reached the output token limit`, angle success 0.76, a verdict on 1 of 12 reviews, 31 min p50.
- **Haiku high is the Haiku knee:** 2.3x the cost of low for the only Haiku arm whose verdicts move.
- **Sonnet low costs what DeepSeek costs** at a tenth of DeepSeek's wall time, with the fewest blocking calls.
- **Agent JSON output is parsed from the final text** (`parseStructured`): a reply with prose before an unfenced object
  comes back as a string and fails the step (`expected object, received string`, 1 Sonnet step). A harness weakness,
  not a model one.
- **Caching works on the direct wire:** cache reads are 50 to 87 % of input on every Claude arm.
