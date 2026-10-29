# Research three-way: engine vs agent vs agent on the engine

**Ported:** the winner, one agent with the platform's web tools (`agents/research`), runs as workflow `research`; the engine, pilot and focused arms, the `design`/`profile` inputs and the comparison harness are deleted (Wave 6, `w6/research-port`).

**Status:** design and decision rule fixed (2026-10-28), before the first live run. Results follow in §Results after
the live window; the rule in §Decision rule does not change after that.
**Inputs:** concept §11 P3, D4, §3's research example; dotfiles `docs/factory/design/gateways.md` §9; research-gateway
at `ee267b1` (frozen, read-only).

## Question

Research ports in one shape. Which one: research-gateway's code-led pipeline (plan → N workers → synthesize →
consistency → ground), one OpenCode agent with web tools, or an OpenCode agent that drives the pipeline's stages as
tools? Decide by numbers on research-gateway's golden set, then port only the winner.

## Arms

Every arm runs `deepseek-v4.1-flash` (research-gateway's lead and worker model; route `research.agent` for the agent
arms), so the arms differ only in design. An arm is the `research` workflow's input `design` + `profile` (like Wave 5's
`angleVariant`; both are removed after the decision, concept §0).

| Arm | `design` | `profile` | What runs | Tools |
|-|-|-|-|-|
| E | `engine` | — | research-gateway's pipeline as it is, one job over its REST API (`POST /research`, `GET /research/:id`), on a separate eval instance | the engine's own |
| A-yolo | `agent` | `yolo` | agent `research-agent-yolo`, one OpenCode session, writes the report | `web_search`, `web_fetch`, `web_docs`, `web_package` |
| A-focused | `agent` | `focused` | agent `research-agent-focused`: one search, read the 1-2 primary sources, stop | `web_search`, `web_fetch` |
| P-yolo | `pilot` | `yolo` | agent `research-pilot-yolo`: decomposes, runs each sub-question as an engine quick job, fills gaps itself, writes the report | `engine_research` + the four web tools |
| P-focused | `pilot` | `focused` | agent `research-pilot-focused`: decomposes, engine quick jobs only | `engine_research` |

Same for all: depth directive and length target per depth (the engine's own, `prompts.ts`), the report rules of the
engine's synthesis prompt (`agents/research-*/AGENTS.md`), one JSON re-ask in the same session, research-gateway's
output shape.

## Design decisions

1. **How an agent reaches the web: an OpenCode plugin and a tool gate, no shell, no API secret.** Each research agent
   carries one plugin (`agents/research-*/plugins/agw-tools.ts`, identical in all four). OpenCode 2.0.32 discovers it in
   the location's `.opencode/plugins/` (measured: the 1.x `.opencode/tool/` directory and an `opencode.json` `plugins`
   entry do not load); a tool needs `options: { codemode: false }` to be offered to the model and returns
   `{ output, content }`, of which the model reads `content` (measured on a fake model). The plugin forwards each call
   with its `sessionID` to the **tool gate** (`packages/host/src/workflows/research/gate.ts`): a loopback HTTP server
   in the host process that serves exactly five verbs (`web_search`, `web_fetch`, `web_docs`, `web_package` → the
   `web.*` capabilities; `engine_research` → one engine quick job), only for a session of a research step that is
   running now (the workflow grants the step before its agent step and revokes after; the session id is matched to the
   step by the OpenCode host's deterministic ids, `isStepSession`), and only the tools that arm is granted.
   - *Credential and its scope.* The gate's key is random per host process and lives in `<stateDir>/research/gate.json`
     (0600), outside every location. The agent cannot read it: research agents have no shell, and the session's `read`
     is refused outside its location (`external_directory` denied; `research-opencode.test.ts` asserts the key is not
     in the answer of a `read` on that file). The key opens nothing but the gate: no workflow, no run operation, no
     other capability; it is not the host's `AGW_API_SECRET`. Even holding it, a caller can only make the web calls a
     live research session may already make.
   - *Why not `agw web …` from a skill:* that needs a shell, and a shell reaches the API secret on disk (concept v3.2's
     accepted risk); an agent that reads untrusted pages must not hold one.
   - *Two outputs per call, kept apart.* **Cost** is booked on the research run as each call reports it: the run's
     `tools` step lives as long as the agent's turns and the gate books into it, so a cancelled or failed run keeps
     its spend (a failed engine job at the cost the engine reported, or unknown, never 0). **Evidence** is written as
     it happens to Postgres (`research_tool_calls`, keyed by run and step, rows go with their run: tool, a
     canonical-JSON argument digest, URLs retrieved and seen, ok or error, the engine job id and its reported cost), so
     grounding never comes from the model and survives a step retry and a host restart; `tools` reads it after the
     grant has drained (never consumes it). A ledger write is retried and logged and never fails a call that worked.
     The engine's cost has one source: its job's ledger row. The run's `engine.costUsd` sums the rows (each job once,
     null when any is unknown). The ledger decides the booking: the row that claims a job (migration 0008, one claim
     per run, step and job, atomic) books its cost on the run; a repeated question or an adopted job books nothing, and
     a retried write recognises its own claim. Grants are in memory and end with their step on every path out, a cancelled run included. When the agent ends, its calls in flight are served first (bounded, 10 s; not on a cancel), so a last engine job finishes, books and writes its row; one still running at the bound is abandoned and recorded as a failed job of unknown cost, booked as such.
   - *One key rule* for the engine's jobs and the judge's calls (`attempt-keys.ts`): a key whose job or run is done is
     adopted, and so is a failure that is an answer (`judge.ts` `answerOf`: the source answered a client error,
     4xx: a page gone, forbidden, paywalled or rate-limited, a package not found; or a refused URL); an outage (5xx, timeout, network, `NOT_CONFIGURED`, `CANCELLED`, an internal error), an
     engine `error` or a cancel throws and is stepped past (`key:2`, …) on the retried scoring. Judge keys carry the score source, the scorer version and the scored run; drift keys
     also the pass (its UTC day), so each drift pass fetches fresh.
   - *Transport:* the gate's server has no idle timeout (`engine_research` holds a request for a whole job; Bun's
     default cuts at 10 s), refuses a body over 64 KiB by its length or while it streams, and the host closes it on
     shutdown (`gate.json` removed).
2. **OpenCode's own `webfetch` and `websearch` are not in any profile (D4's "yolo" measured).** On 2.0.32 with our keys
   `websearch` hangs (no result in 60 s); `webfetch` works but fetched a loopback URL and handed the body to the model
   (no SSRF guard): a prompt injection in a page could read loopback and tailnet services. Wave 5 denied both by
   default for that reason. `yolo` therefore means "every platform web tool, broad directive", `focused` "search and
   fetch only, narrow directive".
3. **P's cut: engine quick jobs as the tool.** The engine is frozen and its REST surface serves whole jobs only; a
   quick job is one worker (≤ 2 searches, read the best page) plus synthesis, consistency and the grounding gate, i.e.
   the engine's worker stage with its verification attached. The pilot plans (1 / 2-4 / 4-8 sub-questions by depth)
   and synthesizes; the engine researches. Exposing its worker stage alone would need engine code changes.
4. **The grounding gate applies to every arm.** The engine drops a citation whose URL its ledger never retrieved and
   marks the report `partial` at ≥ 10 % dropped. The agent arms get the same rule in code from the gate's ledger
   (`assemble`), so `supported` compares like with like and the gate is not what separates designs (any design ports
   with it). `grounded` is counted before the gate in every arm (engine: `citationsKept / (kept + dropped)`).
5. **Cost.** Engine: its own `cost.totalUsd` (LLM + search) on the step. Agent arms: the OpenCode session's messages
   priced with the route's rate (`research.agent` carries research-gateway's measured DeepSeek rate, OpenCode never
   sees IU's `usage.cost`), plus the gate's capability usage and engine job costs, booked on the `tools` step as each call reports it. All on
   the run record, `purpose: eval`.
6. **DeepSeek wire rules hold on the OpenCode route** (concept §8; `research-opencode.test.ts`, real OpenCode, fake
   model): the reasoning of a tool-call turn is sent back verbatim on the next turn, cache-read tokens are recorded and
   priced.

## Scorer (`research`, concept §6, v3.4 API)

| Score | How | Model |
|-|-|-|
| `valid` | the output parses as the report shape | no |
| `complete` | status `ok`, not `partial` | no |
| `grounded` | share of the run's citations whose URL it retrieved or saw as a search result (left out without citations) | no |
| `golden` | the case's `expect` on the report text and its `maxChars`, `evals/lib.ts` semantics exactly (`any`/`all` case-insensitive regex, `live:` a literal substring of the registry's latest version, fetched via `web.package` at scoring time, `v`/`bun-v` stripped for GitHub releases) | no (`live` needs the judge) |
| `supported` | up to 3 citations with distinct URLs, in report order: the judge fetches the page (`web.fetch`, 20k chars) and asks `decide` whether it supports the claim; the share over the citations the judge could score. A page the judge cannot read (a 4xx from the source, a refused URL, an empty page) or a `decide` without a boolean leaves a citation unscored, never unsupported; a fetch or `decide` outage throws and the scoring is retried; `judgedShare` (in [0, 1]) is the share the judge could score; none scored leaves `supported` out; no citation at all scores 0 | judged |

`pass` = valid and golden passed. A `live:` case whose package the registry does not have, or answers without a usable version, leaves `golden` unscored (`pass` false, feedback says why); a registry outage throws through the judge, and the runtime retries the scoring. Cases: the 28 golden questions (19 quick, 8 standard, 1 deep) as plain eval cases in
`$AGW_EVAL_DIR/research/cases.jsonl` (outside git): `{id, input: {query, depth}, reference: {expect, maxChars?}}`.

## Decision rule (pre-registered by the lead, fixed 2026-10-28 before the first live run)

3 runs per question per arm (`agw eval run research --args '{"design":…,"profile":…}' --yes`, three times per arm).

1. **Eligible:** paired by question against E, the bootstrap 95 % CI of the difference (arm − E) in golden pass rate
   AND in supported-citation rate both have a lower bound above −0.10.
2. **Among eligible arms** (E always is): the cheaper median cost per run on standard+deep questions wins if it is at
   least 20 % cheaper; within 20 %, the faster p50 wall time wins if at least 20 % faster; else the simpler design
   wins (fewer lines to own after the port: A < P < E).
3. **yolo vs focused:** yolo, unless focused is better on supported or golden with a CI excluding 0 (D4: focused is
   an opt-in quality lever).

Operationalized in `packages/host/src/workflows/research/decision.ts` (tested), before any data:

- Per question, an arm's score is the mean of its runs; a failed run counts as golden 0 and supported 0, a done run
  the judge left unscored on a score (no citation it could judge, no live value) is left out of that score, never
  counted as 0 (amended in review round 1, before any live run). A run that never ended (cancelled, still running) is
  no result: listed and counted in the report, left out of quality, medians and the rule (review round 5, before the
  full run). `judgedShare` is reported per arm, so a lean toward easy-to-fetch citations shows. A 429 from a source is an answer
  too, adopted as final: a rate-limited citation lowers `judgedShare` rather than being retried. The paired difference is taken over questions both arms ran; the bootstrap resamples
  questions with replacement, 10,000 iterations, seed 20261028, percentile interval.
- Rule 3 runs first, per agent design (focused − yolo, paired), and picks the one A arm and the one P arm that enter
  rules 1 and 2.
- Rule 2's cost and wall time are medians over all runs on standard and deep questions (failed runs included: they
  cost too). With three eligible arms, they are ordered by median cost and the running winner meets each next arm
  under rule 2.
- Reported beside the verdict, not part of it: everything per depth, `grounded`, tool calls, tokens and cache-read
  share, partial and failed runs, failure modes (`compare.ts`).

## Known limits (experiment-only)

This PR is the comparison's harness: the losing arms are deleted after the live window and the winner is re-ported
cleanly. These edges are known and left as they are, because none of them bends the numbers on the normal path:

- **A host restart in the middle of an agent step** loses that execution's booked-but-unrecorded tool spend (usage
  lives in the `tools` step until it records). The evidence survives in the ledger; an engine job adopted after the
  restart is not booked again (its ledger row exists), so that run's cost reads low while `engine.costUsd`, summed
  from the ledger, stays right.
- **Late calls:** a tool call that reaches the gate after its grant closed is refused; a usage report that arrives
  after the `tools` step ended is not booked.
- **A lost write acknowledgement** that the claim token cannot settle (the evidence row landed, the retry then failed
  for good) leaves a duplicate unbooked row; `evidence` counts each job once, so only the call count reads high.
- **A resumed step** gets a fresh grant under the same run and step: a job adopted in it finds the earlier claim and
  books nothing, but that earlier booking's usage was lost with the interrupted execution (as above).
- **The database down for every write retry** books an engine job without checking its claim (logged as
  `booked unchecked`): a repeated question could then be booked twice.
- **`stateDir`:** the gate writes `gate.json` under the host's default state directory, where the OpenCode host
  compiles locations too (boot passes neither a different one). A host given another `stateDir` must give it to both.
- **Search results count as grounded,** as in the engine (`citationsKept`: "a page this run actually retrieved or
  saw as a search snippet"), so the agents' rule matches the engine's.
- **The plugin is copied into the four research agents** (a test asserts they are identical); the port keeps one.

## Cost estimate

Prior, before the smoke (the smoke's measured cost replaces it):

| Arm | per run, quick / standard / deep | 84 runs |
|-|-|-|
| E | ≈ $0.05 average (its last eval) | ≈ $4 |
| A (each profile) | ≈ $0.02 / $0.08 / $0.30 (DeepSeek at $0.30/M in, ~80 % cache reads, 3-15 searches) | ≈ $4.5 |
| P (each profile) | ≈ $0.04 / $0.15 / $0.50 (1 / 3 / 6 engine quick jobs + the pilot session) | ≈ $8 |
| judge | `decide` ≈ $0.0002, page fetches ≈ free; its own `cap.*` runs (purpose `eval`), never in an arm's cost | < $0.5 |

Full run ≈ $30 (± 2×), on the Athena team key. Smoke: every arm once on 3 questions (`rfc9110-413` quick,
`npm-hono-latest` quick/live, `bun-serve-idle-timeout` standard) ≈ $1.

Smoke, measured (2026-10-29, deploy `fa5e07d`, team key): 15 of 15 runs done, golden 15 of 15, every research run
priced.

| Arm | 2 quick | 1 standard | Per full pass (19 quick, 8 standard, 1 deep at 3× standard) |
|-|-|-|-|
| E | $0.0071 | $0.1098 | $1.28 |
| A-yolo | $0.0083 | $0.0279 | $0.39 |
| A-focused | $0.0079 | $0.0300 | $0.41 |
| P-yolo | $0.0114 | $0.0333 | $0.47 |
| P-focused | $0.0093 | $0.0419 | $0.55 |

Full run (3 passes × 5 arms) ≈ $9.3 plus the judge (≈ $0.2: `decide` measured $0.0053 for 38 calls) ≈ $10; one
standard run per arm makes the range ≈ $5–20. The judge's 38 `web.fetch` runs carry no cost: each was a direct fetch, which reports no usage (free); only the Tavily fallback is priced.

## Live window (the lead's)

1. Merge `w6/web-capabilities`, rebase this branch on `origin/master`, merge it; the lead switches the host to the
   team key and deploys.
2. `~/.local/state/agent-workflows/research-eval/engine.sh start` (untracked): research-gateway HEAD exported to a
   throwaway directory on `127.0.0.1:7795`, team key, own job DB and usage file, human-solve and brain off; it writes
   `<stateDir>/research/engine.json`, which the engine and pilot arms read.
3. Smoke: `agw eval run research --ids rfc9110-413,npm-hono-latest,bun-serve-idle-timeout --args '{…}' --yes` per arm;
   fix what breaks; report the measured cost and the full-run estimate.
4. Full run (after approval): 3 × 5 arms. Then `bun packages/host/src/workflows/research/compare.ts <evalRunIds>`
   → §Results.

## Results

Full run, 2026-10-29 (deploy `5025eec`, team key, `deepseek-v4.1-flash` in every arm): 3 passes × 5 arms × 28
questions, the five arms of a pass side by side, so they share the host's load. 420 research runs, all done, none
failed or incomplete, every one priced.

**Verdict: A-yolo.** Of the two arms rule 3 lets through (A-yolo, P-yolo) only A-yolo is eligible. On supported citations it beats E by +0.19 (CI 0.07 to 0.32),
and on golden it is level with E. Its median cost on standard and deep questions is $0.028 against E's $0.138, about
5× cheaper, and its p50 wall time is a quarter of E's (39 s vs 171 s on standard).

- **Profile:** focused never beat yolo with a CI excluding 0, so yolo stays the profile in both designs.
- **P is not eligible:** P-yolo's golden CI against E reaches −0.12, below the −0.10 bound, and its supported-citation
  gain (+0.06) is not significant. It also costs about twice A and is about 3× slower.
- **E's weak spot is citations:** it is grounded (0.99), but the judge holds only 0.73 of its citations supported,
  against 0.91 for A-yolo. Its standard and deep questions cost about 5× those of A.
- **Unscored and partial:** E leaves 3 runs unscored (all standard). A-focused leaves 5 unscored and has 11 partial, the most of any arm.
  P-focused's judged share drops to 0.87 on standard.
- **Engine tokens:** E shows 0 tokens and n/a cache reads because the engine reports its cost only. Its token and
  cache-read columns mean n/a, not zero.
- **Deep is indicative only:** one deep question gives n=3 runs per arm. A-yolo's 0.78 supported there is three runs,
  not a trend.

Spend on the team key: **$12.57** in total, against an estimate of about $10 (range $5–20).

| Arm | 84 runs |
|-|-|
| E | $4.97 |
| A-yolo | $1.18 |
| A-focused | $1.08 |
| P-yolo | $2.55 |
| P-focused | $2.50 |
| judge (`cap.decide` $0.16, `cap.web.fetch` $0.14, `cap.web.package` $0) | $0.30 |

The judge figure covers every purpose-`eval` capability run in the window. Six `cap.web.package` runs carry no
price.

`compare.ts` output:

#### All questions

| arm | runs | failed | incomplete | unscored | partial | golden | supported | judged share | grounded | median $ | p50 wall s | tokens (median) | cache read share | tool calls (median) |
|-|-|-|-|-|-|-|-|-|-|-|-|-|-|-|
| engine | 84 | 0 | 0 | 3 | 5 | 0.99 | 0.73 | 0.97 | 0.99 | 0.0101 | 22 | 0 | n/a | 0 |
| agent-yolo | 84 | 0 | 0 | 0 | 8 | 0.98 | 0.91 | 0.99 | 0.97 | 0.0063 | 9 | 14964 | 0.82 | 3 |
| agent-focused | 84 | 0 | 0 | 5 | 11 | 0.97 | 0.93 | 0.99 | 0.94 | 0.0054 | 8 | 11695 | 0.73 | 2 |
| pilot-yolo | 84 | 0 | 0 | 4 | 5 | 0.97 | 0.79 | 0.99 | 0.98 | 0.0135 | 30 | 11163 | 0.76 | 2 |
| pilot-focused | 84 | 0 | 0 | 4 | 0 | 1.00 | 0.75 | 0.96 | 1.00 | 0.0128 | 34 | 7134 | 0.59 | 1 |

#### quick

| arm | runs | failed | incomplete | unscored | partial | golden | supported | judged share | grounded | median $ | p50 wall s | tokens (median) | cache read share | tool calls (median) |
|-|-|-|-|-|-|-|-|-|-|-|-|-|-|-|
| engine | 57 | 0 | 0 | 0 | 1 | 1.00 | 0.69 | 0.97 | 0.99 | 0.0075 | 18 | 0 | n/a | 0 |
| agent-yolo | 57 | 0 | 0 | 0 | 5 | 0.98 | 0.89 | 0.99 | 0.97 | 0.0041 | 7 | 11361 | 0.69 | 2 |
| agent-focused | 57 | 0 | 0 | 3 | 8 | 0.98 | 0.94 | 0.99 | 0.94 | 0.0047 | 7 | 7017 | 0.70 | 1 |
| pilot-yolo | 57 | 0 | 0 | 2 | 2 | 0.98 | 0.76 | 0.99 | 0.99 | 0.0099 | 24 | 7979 | 0.77 | 1 |
| pilot-focused | 57 | 0 | 0 | 1 | 0 | 1.00 | 0.73 | 0.99 | 1.00 | 0.0099 | 28 | 6786 | 0.70 | 1 |

#### standard

| arm | runs | failed | incomplete | unscored | partial | golden | supported | judged share | grounded | median $ | p50 wall s | tokens (median) | cache read share | tool calls (median) |
|-|-|-|-|-|-|-|-|-|-|-|-|-|-|-|
| engine | 24 | 0 | 0 | 3 | 3 | 0.95 | 0.81 | 0.98 | 0.99 | 0.1331 | 171 | 0 | n/a | 0 |
| agent-yolo | 24 | 0 | 0 | 0 | 3 | 0.96 | 0.97 | 1.00 | 0.96 | 0.0260 | 39 | 79924 | 0.80 | 10 |
| agent-focused | 24 | 0 | 0 | 2 | 3 | 0.95 | 0.90 | 0.98 | 0.94 | 0.0180 | 35 | 50746 | 0.72 | 6 |
| pilot-yolo | 24 | 0 | 0 | 2 | 3 | 0.95 | 0.86 | 0.98 | 0.95 | 0.0479 | 104 | 52244 | 0.75 | 8 |
| pilot-focused | 24 | 0 | 0 | 3 | 0 | 1.00 | 0.81 | 0.87 | 1.00 | 0.0455 | 91 | 13135 | 0.46 | 3 |

#### deep

| arm | runs | failed | incomplete | unscored | partial | golden | supported | judged share | grounded | median $ | p50 wall s | tokens (median) | cache read share | tool calls (median) |
|-|-|-|-|-|-|-|-|-|-|-|-|-|-|-|
| engine | 3 | 0 | 0 | 0 | 1 | 1.00 | 1.00 | 1.00 | 0.99 | 0.4833 | 417 | 0 | n/a | 0 |
| agent-yolo | 3 | 0 | 0 | 0 | 0 | 1.00 | 0.78 | 1.00 | 1.00 | 0.0882 | 174 | 740783 | 0.90 | 30 |
| agent-focused | 3 | 0 | 0 | 0 | 0 | 1.00 | 1.00 | 1.00 | 1.00 | 0.0587 | 185 | 338675 | 0.77 | 17 |
| pilot-yolo | 3 | 0 | 0 | 0 | 0 | 1.00 | 0.89 | 1.00 | 1.00 | 0.2037 | 279 | 196267 | 0.77 | 20 |
| pilot-focused | 3 | 0 | 0 | 0 | 0 | 1.00 | 0.89 | 1.00 | 1.00 | 0.2246 | 351 | 55705 | 0.58 | 9 |

#### Verdict by the rule

- **profile**: agent: focused − yolo golden 0.000 [0.000, 0.000] (n=28), supported 0.018 [-0.048, 0.089] (n=28) → agent-yolo
- **profile**: pilot: focused − yolo golden 0.012 [0.000, 0.037] (n=27), supported -0.033 [-0.101, 0.033] (n=27) → pilot-yolo
- **eligible**: agent-yolo − engine: golden 0.012 [-0.036, 0.071] (n=28), supported 0.185 [0.065, 0.321] (n=28) → eligible
- **eligible**: pilot-yolo − engine: golden -0.012 [-0.119, 0.095] (n=28), supported 0.060 [-0.019, 0.149] (n=28) → not eligible
- **cost**: agent-yolo $0.0279 vs engine $0.1383 → agent-yolo

**Winner: agent-yolo**
