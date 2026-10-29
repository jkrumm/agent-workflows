# Research three-way: engine vs agent vs agent on the engine

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

Pending the live window.
