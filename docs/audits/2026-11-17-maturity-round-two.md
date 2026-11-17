# agent-workflows maturity audit, round two (2026-11-17)

Issue 1803. Round one is `2026-10-31-maturity-round-one.md` (moved here from outside the repo, at the owner's ask). This round
asks what the platform costs per route, which routes nobody calls, where evals are missing, and what the factory's seven
judging workflows got wrong. Read-only except for the changes listed under "Done in this change".

> **TLDR.** 14 days cost **$135.62** in the journal ($118.81 production, $16.81 eval). Research is two thirds of it:
> `research.agent` $68.50 plus its Sonar calls $21.58, which no route line carries. The cost alert of 2026-11-16 was real
> spend, not a defect: 119 research runs between 11:00 and 22:00 UTC, 48 production ($20) and 71 from the research-budget eval
> ($11), before the call budget (`5130c28`, 14:47 UTC) cut the cost of a production run from $0.28–0.48 to $0.17–0.26. One route had no caller (`factory.classify`) and is removed. Three factory suites (screen,
> errand, errand-needed) have cases and were never run. The cheap seat is level with the standard seat on every measured agent job
> except the Judge, and unmeasured where the owner asks (code reading). Ten proposals with defaults are at the end; none needs a
> decision today.

## Method and limits

- **Journal:** `agw.steps` joined to `agw.runs`, steps started in the 14 days to 2026-11-17 01:00 UTC (12,624 runs; 10,690 not
  eval, of which 444 failed: 131 `door.speech` (empty `input`, a caller bug), about 280 web, hdx and shop capability runs failing
  on the page, 21 `factory.digest` (Anthropic 502 and 503), 3 research). Cost is the journal's
  (`steps.cost`, priced by the route's rate). Duration is a step's `finished_at - started_at`.
- **Gateway:** `usage.records`, lane `agw_workflow`: $117.36 over 23,173 rows. It sits $18 under the journal, mostly because it prices a
  Sonar row at about $0.00004 where the journal books $0.056 (the request fee); `eaa2de3` (#178) fixed the gateway's pricing on
  2026-11-16, so rows before it are low.
- **Route id on a step** exists only where the middleware sets it. Podcast, the audio door, `eval.label.*`, `eval.judge` and
  `image.enhance` write none, so their cost sits in 32.6 of the 135.6 dollars with no route (below). Hermes calls the gateway
  itself and appears only in `usage.records` (lane `hermes`).
- **Failed** counts steps with status failed, not runs. **Fallbacks:** no step records that its fallback seat answered. The gateway
  writes `fallback: passthrough` for Claude-Code-shaped passthrough (5,747 rows) and `claude-code` (181); no row says "credit
  drained, GPT answered". A route falls back on a balance failure only (`isBalanceFailure`), and none happened: the only `gpt-6-luna`
  calls of the window are 12 Hermes calls on 2026-11-03 and 04. So fallbacks: 0 observed.
- The 14 days start at 2026-11-03: older steps carry no route id, and `steps` begins 2026-10-27.

## Per-route table

Sorted by 14-day cost. `n/a*`: no route id on the step (see notes). `Calls`, `Cost`: production / eval.

|Route|Seat|Calls prod / eval|Tokens in / out (M)|Cost prod / eval (USD)|Failed|p50 / p95 (s)|Caller|Eval set|
|-|-|-|-|-|-|-|-|-|
|`research.agent`|Haiku high|309 / 100|1060.74 / 14.00|59.62 / 8.88|0|136.5 / 423.8|agw research (every lead, `/research`)|research 32|
|`image.sunburst`|gpt-image-2.5-sunburst|40 / 0|0.06 / 0.18|5.70 / 0.00|0|33.7 / 49.9|`agw image`|image 8|
|`cheap.extract`|Haiku high|2580 / 0|19.56 / 4.27|4.14 / 0.00|1|5.8 / 16.6|`agw web read`, `shop item/find`|ad hoc only (12 pages, not committed)|
|`factory.ask`|Sonnet medium|164 / 683|2.57 / 0.20|0.47 / 3.05|0|2.3 / 5.0|software-factory Judge|factory-ask 34|
|`narrative`|Sonnet medium|70 / 5|1.36 / 0.07|3.34 / 0.10|0|8.1 / 15.1|argo narrative page|narrative 6|
|`factory.hygiene`|Haiku high|64 / 3|61.20 / 0.57|1.86 / 0.01|7|32.9 / 114.1|software-factory hygiene|hygiene 3|
|`prose.review`|Terra medium|148 / 20|0.80 / 0.22|1.63 / 0.17|0|11.7 / 21.5|`agw prose`, narrative-polish|prose 10|
|`prose.write`|Sonnet medium|54 / 0|0.46 / 0.06|1.48 / 0.00|0|5.7 / 8.9|`agw prose-polish`|prose-polish 8|
|`factory.triage`|Haiku high|1488 / 32|6.10 / 0.77|0.98 / 0.01|0|3.1 / 6.8|software-factory triage|triage 16|
|`eval.judge.b`|Terra medium|1 / 0|0.41 / 0.03|0.55 / 0.00|0|75.7 / 75.7|eval scorers (dual judge)|none|
|`retro.analyze`|Sonnet medium|12 / 4|0.72 / 0.01|0.47 / 0.06|1|10.2 / 20.7|weekly `retrospective`|retrospective 5|
|`factory.queue`|Haiku high|629 / 10|2.14 / 0.44|0.43 / 0.01|0|4.2 / 8.0|software-factory queue loop|queue 10|
|`otel.agent`|Haiku high|22 / 36|14.71 / 0.35|0.24 / 0.19|0|25.3 / 69.0|`agw otel`|otel 8|
|`factory.digest`|Haiku none|392 / 9|1.77 / 0.46|0.41 / 0.00|0|5.6 / 10.4|software-factory digest|digest 9|
|`image.flare`|gpt-image-2.5-flare|16 / 0|0.00 / 0.01|0.39 / 0.00|0|13.3 / 15.9|`agw image`|image 8|
|`factory.fixclasses`|Haiku high|234 / 9|1.23 / 0.51|0.38 / 0.01|0|5.8 / 31.5|software-factory Improve|fix-classes 9|
|`digest.items`|Haiku none|462 / 0|1.22 / 0.32|0.28 / 0.00|0|3.6 / 6.9|`agw digest` (Console, argo)|digest 12|
|`factory.steward`|Haiku high|149 / 126|0.85 / 0.34|0.16 / 0.10|0|7.4 / 10.7|software-factory steward|steward 14|
|`factory.classify`|Haiku none|227 / 90|1.08 / 0.11|0.13 / 0.03|0|2.6 / 4.9|**none since 2026-11-07**|factory-classify 45|
|`check`|Haiku high|39 / 0|4.29 / 0.09|0.13 / 0.00|0|58.3 / 827.5|`agw check`|check 7|
|`image.vectorize`|recraft-ai/recraft-vectorize|5 / 3|0.00 / 0.00|0.05 / 0.03|0|5.9 / 7.5|`agw image`|none|
|`decide`|decision-1|146 / 315|1.40 / 0.00|0.01 / 0.04|0|0.3 / 0.5|judge of `research`, `eval.*`, `agw decide`|none|
|`factory.specscreen`|Haiku high|52 / 34|0.32 / 0.03|0.04 / 0.01|0|2.8 / 5.8|software-factory Spec screen|spec-screen 17|
|`brain.agent`|Haiku high|4 / 0|1.59 / 0.02|0.04 / 0.00|0|21.1 / 51.5|`agw brain`|brain 10|
|`factory.errand`|Haiku high|75 / 0|0.13 / 0.05|0.04 / 0.00|0|4.1 / 6.9|software-factory errand screen|errand 14, never scored|
|`triage`|Haiku high|71 / 0|0.09 / 0.04|0.03 / 0.00|0|3.6 / 5.9|`agw triage` (dictated memo)|none|
|`diagram.agent`|Haiku none|3 / 13|0.33 / 0.03|0.00 / 0.02|0|6.3 / 15.6|`agw diagram`|diagram 6|
|`image.cutout.recraft`|recraft-ai/recraft-remove-background|0 / 2|0.00 / 0.00|0.00 / 0.02|0|3.3 / 3.9|`agw image --file` cutout|none|
|`cheap.summarize`|Haiku high|14 / 0|0.03 / 0.01|0.01 / 0.00|0|4.1 / 6.3|`agw llm summarize`|none|
|`cheap.title`|Haiku none|384 / 0|0.03 / 0.01|0.01 / 0.00|0|0.8 / 1.2|`agw llm title`, smoke|none|
|`image.upscale`|nightmareai/real-esrgan|0 / 2|0.00 / 0.00|0.00 / 0.00|0|1.6 / 1.7|`agw image`|none|
|`overview.classify`|Haiku high|0 / 6|0.02 / 0.00|0.00 / 0.00|0|2.8 / 3.2|`agw agents`/overview|overview 6|
|`factory.screen`|Haiku high|5 / 0|0.01 / 0.00|0.00 / 0.00|0|3.0 / 4.0|software-factory Judge (signals)|screen 14, never scored|
|`factory.errandneeded`|Haiku high|2 / 0|0.00 / 0.00|0.00 / 0.00|0|3.2 / 4.5|software-factory daily errand look|errand-needed 14, never scored|
|`vision.describe`|Haiku none|3 / 0|0.00 / 0.00|0.00 / 0.00|0|0.7 / 1.7|`agw image-read`, shop|none|
|`audio.tts.gemini-flash-lite`|gemini-3.8-flash-lite-tts|n/a*|n/a*|n/a*|n/a*|n/a*|Hermes TTS, audio door|none|
|`audio.tts.gemini-flash`|gemini-3.8-flash-tts|n/a*|n/a*|n/a*|n/a*|n/a*|`agw podcast`, audio door|none|
|`audio.tts.elevenlabs-flash`|elevenlabs/flash-v2.5|n/a*|n/a*|n/a*|n/a*|n/a*|audio door option, unused in 14 d|none|
|`audio.tts.elevenlabs-turbo`|elevenlabs/turbo-v2.5|n/a*|n/a*|n/a*|n/a*|n/a*|audio door option, unused in 14 d|none|
|`audio.tts.elevenlabs-v3`|elevenlabs/v3|n/a*|n/a*|n/a*|n/a*|n/a*|audio door option, unused in 14 d|none|
|`audio.tts.prep`|Haiku none|n/a*|n/a*|n/a*|n/a*|n/a*|audio door (speech)|none|
|`audio.tts.summary`|Haiku none|n/a*|n/a*|n/a*|n/a*|n/a*|audio door (speech)|none|
|`audio.stt.voxtral-mini`|voxtral-mini-transcribe-3-0|n/a*|n/a*|n/a*|n/a*|n/a*|audio door (transcriptions)|none|
|`audio.stt.voxtral-small`|voxtral-small-transcribe-3-0|n/a*|n/a*|n/a*|n/a*|n/a*|audio door option, unused in 14 d|none|
|`audio.stt.openai`|gpt-transcribe|n/a*|n/a*|n/a*|n/a*|n/a*|audio door option, unused in 14 d|none|
|`audio.stt.openai-4o`|gpt-4o-transcribe|n/a*|n/a*|n/a*|n/a*|n/a*|audio door option, unused in 14 d|none|
|`audio.stt.openai-4o-mini`|gpt-4o-mini-transcribe|n/a*|n/a*|n/a*|n/a*|n/a*|audio door option, unused in 14 d|none|
|`audio.stt.openai-legacy`|whisper|n/a*|n/a*|n/a*|n/a*|n/a*|audio door option, unused in 14 d|none|
|`eval.label.a`|Sonnet medium|n/a*|n/a*|n/a*|n/a*|n/a*|`agw eval mine`|none|
|`eval.label.b`|Terra medium|n/a*|n/a*|n/a*|n/a*|n/a*|`agw eval mine`|none|
|`eval.judge`|Sonnet medium|n/a*|n/a*|n/a*|n/a*|n/a*|eval scorers|none|
|`hermes.brain`|Haiku high|n/a*|n/a*|n/a*|n/a*|n/a*|Hermes, reads `agw routes`|none|
|`hermes.compress`|Haiku high|n/a*|n/a*|n/a*|n/a*|n/a*|Hermes|none|
|`hermes.title`|Haiku none|n/a*|n/a*|n/a*|n/a*|n/a*|Hermes|none|
|`hermes.approval`|Haiku none|n/a*|n/a*|n/a*|n/a*|n/a*|Hermes|none|
|`hermes.vision`|Haiku none|n/a*|n/a*|n/a*|n/a*|n/a*|Hermes|none|
|`image.cutout.bria`|bria/remove-background|n/a*|n/a*|n/a*|n/a*|n/a*|`agw image` cutout (selectable, unused)|none|
|`image.enhance`|Haiku high|n/a*|n/a*|n/a*|n/a*|n/a*|`agw image --enhance`|image 8|
|`podcast.research`|Sonnet medium|n/a*|n/a*|n/a*|n/a*|n/a*|`agw podcast`|none|
|`podcast.editorial`|Sonnet medium|n/a*|n/a*|n/a*|n/a*|n/a*|`agw podcast`|none|
|`podcast.outline`|Sonnet medium|n/a*|n/a*|n/a*|n/a*|n/a*|`agw podcast`|none|
|`podcast.write`|Sonnet medium|n/a*|n/a*|n/a*|n/a*|n/a*|`agw podcast`|none|
|`podcast.review`|Terra medium|n/a*|n/a*|n/a*|n/a*|n/a*|`agw podcast`|none|
|`podcast.metadata`|Haiku high|n/a*|n/a*|n/a*|n/a*|n/a*|`agw podcast`|none|

\* Cost the table cannot show by route, from the journal's own step rows and the gateway (14 days):

|What|USD|Where it sits|
|-|-|-|
|Research tool calls (Sonar 386 steps $21.58, Tavily extract $0.18)|21.78|journal step `research/tools`, no route id; the gateway side prices them at $0.20 until `eaa2de3`|
|Podcast (research, editorial, outline, segments, revises, TTS)|6.55|3 episodes; journal steps `podcast` $5.71 and `podcast.produce.unit` $0.84; no route id|
|`eval.mine` labelling (Gemini flash $1.78, Sonnet $1.40, Terra $0.49)|3.67|the label step shows a third model, `gemini-3.8-flash`, that no `eval.label.*` route carries (`eval.label.c` left the table)|
|Hermes (lane `hermes`: 1,064 Haiku calls, a few Gemini TTS and Voxtral calls)|2.45|its five `hermes.*` seats read `agw routes`; the gateway cannot say which seat a call used|
|`door.transcriptions` (Voxtral mini, 78 calls)|1.91|audio process|
|Journal steps total / route-attributed|135.62 / 103.02||

Routes seen in the window that the table no longer holds: `review.angle`, `review.angle.deep`, `review.adversary`,
`review.synthesis`, `review.router` ($5.72 in all, last call 2026-11-03: review v1, deleted in Wave 10), `cheap.classify` (1
call) and `eval.label.c` ($1.53, one 400 s run).

## The cost alert of 2026-11-16

`agw cost > 30 USD per 24h` fired from 15:00 UTC. The journal shows why:

|Hour (UTC)|Research runs (prod / eval)|Cost (prod / eval)|
|-|-|-|
|11 to 13|28 / 20|15.13 / 4.68|
|14 to 15|2 / 51|0.40 / 6.38|
|16 to 21|18 / 0|4.32 / 0|

Production research runs made 51 to 72 tool calls and cost $0.28 to $0.48 each before 14:47 UTC, and 12 to 39 calls and
$0.01 to $0.26 each after the call budget (`5130c28`); a baseline run costs $0.084 at standard depth and $0.47 at deep, the budgeted one
$0.020 and $0.216 (`2026-11-16-research-budget.md`). So the day was the owner's research load plus the research eval Issues
(1594, 1600, 1602), both of which are one-offs; the budget that cuts a run's cost by half to three quarters was deployed the same
afternoon. The alert's own text says "a normal day is 2 to 20" and splits eval from production only on the dashboard tile. A
day with a research-eval sweep will trip it again (see proposal 6). Issue 1727 finds the calling Issue, which is not needed here.

## The ten costliest routes and what they buy

Journal cost, production plus eval, route-attributed only (the unattributed lines above would rank research tool calls second).

|#|Route|USD|What it buys|
|-|-|-|-|
|1|`research.agent`|68.50|a cited report per call; 409 runs, 1.06 billion input tokens (45 % cache reads), 2.6 M tokens per run, p50 137 s, p95 424 s. The call budget moves the cost, not the seat|
|2|`image.sunburst`|5.70|40 generated images, $0.14 each; a flat model price, no seat to move|
|3|`cheap.extract`|4.14|2,580 `web.read` and shop reads at $0.0016; p50 5.8 s; the bulk of the platform's call volume|
|4|`factory.ask`|3.52|the Judge: 164 production calls ($0.47), 683 eval case runs ($3.05); the eval is the cost|
|5|`narrative`|3.44|70 project pages, $0.048 each on Sonnet medium|
|6|`review.angle`|3.09|gone (review v1)|
|7|`factory.hygiene`|1.88|64 checkout reads, $0.029 each, about 1 M input tokens per run; 7 of 67 steps failed output validation|
|8|`prose.review`|1.80|148 cross-lab reviews on Terra, $0.011|
|9|`eval.label.c`|1.53|gone (one run)|
|10|`prose.write`|1.48|54 rewrites on Sonnet medium, $0.027|

The rest of the table is under $1.10 per route in 14 days.

## Routes with no caller

**`factory.classify`.** Last production call 2026-11-07 (135, 46 and 42 calls on the three days before); the 90 calls of 2026-11-16 are
the eval. software-factory dropped the Classify station (its `docs/rewrite/reports/0-skeleton.md:180`); its seat Issue (1791) was asked
by signal and answered that it does not reuse the call, nor does any planned seat Issue (the light seat is a deterministic rule, the
size comes from `factory-triage`; recorded as NL33 in its `docs/decisions.md`). **Removed:** the route, the `factory.classify`
capability, the `factory-classify` workflow with its 45-case suite and tests. `identifier`, the one helper nine factory capabilities
imported from it, moved to `capabilities/identifier.ts`.

Reachable but unused in 14 days, kept (a caller picks the model by name; removing one breaks a caller, `AGENTS.md` §Callers outlive
a release): `audio.tts.elevenlabs-*` (3), `audio.stt.voxtral-small`, `audio.stt.openai`, `-4o`, `-4o-mini`, `-legacy`, and `image.cutout.bria`
(`agw image` takes `model: recraft|bria`). Default: keep; look again at 60 days.

`hermes.*` (5 seats): no agw caller, by design (the table's own comment says so); Hermes reads `agw routes` and spent $2.45 in the
window. Not a dead route.

## Routes and workflows with no eval

Cases committed with the workflow: 17 suites, 12 of them for the factory (`packages/host/src/workflows/*/eval/cases.jsonl`), the
Judge's 34 under `packages/eval/factory-ask`, and the older eight outside the repo under `$AGW_EVAL_DIR` (research 32, review-gt 146,
brain 10, check 7, diagram 6, image 8, otel 8, prose 10, speech 10, transcriptions 10).

|Route|Production cost, 14 d|Why it matters|
|-|-|-|
|`cheap.extract`|4.14|the largest call count; only an ad hoc 12-page harness exists (`2026-11-16-effort-arms.md`), nothing committed|
|`factory.screen`, `factory.errand`, `factory.errandneeded`|0.04 together|cases exist (14 each) and have no scored run in the journal|
|`image.*` seats, `image.enhance`|6.1|8 cases and a scorer; no seat arm has ever run|
|`podcast.*`, `audio.*`|6.6 and 3.9|no cases for the podcast stages; speech and transcriptions have cases and no scorer in the repo|
|`cheap.title`, `cheap.summarize`, `triage`, `vision.describe`, `hermes.*`|0.05 and Hermes' 2.45|none|

## Prompts that were cut or retried

- **`factory.hygiene`:** 7 of 64 production steps (11 %) answered with a schema-invalid `review` (a format mismatch in the finding's
  location) and were repaired in a `review-retry` step. The same score was 1.00 in the 3-case eval, so the cases do not show it.
- **`research`:** 18 of 409 agent steps ran twice, 10 `research:reask` calls, 3 runs failed with "did not answer with the report JSON".
  `5130c28` removed the re-ask on unsourced citations; the 3 failures are before it or unchanged (check at the next audit).
- **`otel`:** 4 `otel:reask`, 2 steps retried of 58.
- **`cheap.extract`:** one `OUTPUT_TRUNCATED` in 2,580 calls (its ceiling is the tier's 32,000).
- **`factory.digest`:** 21 failed runs, all Anthropic 502 or 503 (18 on 2026-11-15, 3 on 11-13), the transport had already tried three times (`withRetries`), so this was a provider outage, not a missing retry; the route's
  fallback fires on a drained credit only. The digest is regenerated every few hours, so the cost is one missing digest.
- **`check`:** p95 827 s against p50 58 s: the agent step is skipped when the checks pass; the long tail is a repo's own `make check`.

## Where a cheaper seat is level, and where it is not

|Job|Measured|Level?|
|-|-|-|
|`research.agent`|Haiku high against Sonnet medium, 10 prod-derived standard cases: `supported` 0.80 against 0.67 (CI of the difference −0.27 to 0.00), every verdict a tie, Sonnet 6.7 times the cost|level; Haiku stays|
|`otel.agent`|Haiku high ties Sonnet medium and DeepSeek on every score (8 cases, two reruns), $0.039 a run cheaper|level; Haiku is the seat|
|`diagram.agent`|Haiku none ties Sonnet medium (6 cases), 3.9 s faster|level|
|`brain.agent`, `check`|Sonnet +0.05 facts within noise at 20 times the cost; `check` every arm 0.86|level|
|`factory.queue`, `factory.triage`|effort low and none hold in 14 and 16 cases (queue 56 of 56 edges exact at low; triage 31 and 30 of 32 against 30)|level, not worth moving: cents a month|
|`cheap.extract`|effort high to none: `complete` −0.30 (CI −0.50 to −0.11), `faithful` −0.09 (−0.45 to +0.28)|**not level** on completeness|
|`factory.ask`|Haiku none and high both below Sonnet medium: `ownerKept` 58 % and 56 % against 73 %; pass 78 % against 84 %|**not level**; Sonnet medium is the seat|
|`factory.steward`|Haiku high 76 % right on the new wording, 62 % on the old (14 cases); no Sonnet arm run|unmeasured|
|`factory.digest`|Haiku none: judged faithfulness 0.22, structure sound; no stronger arm run|unmeasured, and a signal that none may be too weak|
|code reading at Sonnet medium|the owner's note: unmeasured (brain wiki, `engineering/model-routing.md` §2)|unmeasured; Wave 11|

modelpick's table of 2026-11-16 (quoted from the factory's step-back report): Haiku high 29.9 on the intelligence index at $0.16 a task,
Sonnet medium 30.8 at $0.78, Sonnet high 41.5 at $1.64. agw's own evals agree on the first comparison (Haiku high is level with Sonnet
medium on four agent jobs) and say nothing on the second, which is where the factory's lead seat sits.

**The honest size of the prize.** Every seat move the evals support is worth cents a month. The money is one route: `research.agent`
plus its Sonar calls is 66 % of 14-day spend, and its cost per run followed the call count, not the seat (the budget halved a
run's cost at the same seat). Next in line are `image.sunburst` ($5.70, a flat price) and `cheap.extract` ($4.14, level at high).

## What the seven factory workflows got wrong in the recorded cases

|Workflow (route)|Recorded|What went wrong|
|-|-|-|
|ask (`factory.ask`)|34 cases, 3 runs per arm (`2026-11-11-factory-ask-judge.md`)|Haiku answered "Disable the version Watch for this repo" twice on one Issue, an answer nothing could apply, and kept only 56 to 58 % of owner-class questions with the owner. Moved to Sonnet medium: 73 %. Four cases fail on every arm (`fpp-350-b`, `linewatch-367`, `weatherorb-697`, `legacy-slack-off`): the prompt lets the Judge take a reversible do-nothing default where the facts show nothing can apply it, a prompt fault, filed on its own|
|triage (`factory.triage`)|16 cases, 32 calls per effort arm|30 of 32 at high: `inject-precedent` failed twice (the owner's mark on a similar Spec screen read as "no Spec"); at none `architecture` failed twice (flags a Spec on a choice the rule says is not one). The checkpoint call is its weak point at every effort|
|queue (`factory.queue`)|10 cases, 9 pass, `edgeRecall` 0.83|One miss: a later Issue's own words said it was unrelated to the earlier one, and the factory later closed it as fixed by that work. Separately **agw's guard threw away every edge when one was bad** while the factory's own check keeps the sound ones: fixed here|
|steward (`factory.steward`)|14 cases|76 % correct on the new wording, 62 % on the old; the two failing readings are in `2026-11-16-steward-wording.md`|
|screen (`factory.screen`)|14 cases committed|never scored; 5 production calls in 14 days|
|hygiene (`factory.hygiene`)|3 cases|7 of 8 plants found, nothing on the clean controls; the missed plant is the weakest filler plant (a doc that "describes the future plans"); in production 11 % of steps needed a format repair|
|errand (`factory.errand`, `factory.errandneeded`)|14 and 14 cases committed|never scored; 75 and 2 production calls|

Beside these: `factory.fixclasses` got 25 of 33 commits right (25 of 30 after dropping three labels two readers would split; one answer was a plain error:
a test-only fix called `concurrency`); `factory.digest` judged 0.22 (above); `factory.specscreen` has 34 scored case runs and no hand-written report.

## Telemetry findings this round

1. **A route id is missing on the steps that cost most outside research.** $32.6 of $135.6 (24 %) has no route: the research tool step
   (Sonar), podcast, the audio door, `eval.label.*`, `eval.judge`, `image.enhance`. Round one's design item 1 ("record the route id on
   every journal step") is half done.
2. **`door.speech` fails 131 times in 14 days with "input is required"** and the run status is `failed` now (round one saw `done`);
   the caller sends an empty text on 13 of the 14 days. The door is right to refuse; the caller is not agw's.
3. **The gateway priced a Sonar row at a hundredth of a cent** until 2026-11-16; any cost read from `usage.records` before that
   understates research by about $21.

## Done in this change

1. `factory.classify` removed (route, capability, workflow, suite, tests, doc mentions) after software-factory answered that nothing reuses it.
2. Stale comments fixed in `packages/routes/src/table/factory.ts`: five routes claimed "no eval set" while their suites exist; each now
   names its suite and case count; three that have cases but no scored run say so. The routes README no longer calls the tiers "provisional until Waves 9–10" (done 2026-11-03; what is
   open is §Proposals here).
3. The queue guard judges each edge on its own: the sound edges stand, a bad one is dropped with a note, as the factory's own check
   does (`packages/capabilities/src/capabilities/factory-queue.ts`, README, tests). The order guard is unchanged.
4. Round one's audit moved into the repo as `2026-10-31-maturity-round-one.md`; two docs that called its numbers private now point here.
   It holds counts and spend, no names or hosts.

## Proposals

Each has a default that applies if nobody answers. None spends more than the cents named.

|#|Proposal|Default|Cost / gain|
|-|-|-|-|
|1|Remove `factory.classify`, the `factory-classify` workflow and its 45-case suite|done in this change|removed one route, one workflow, one suite|
|2|Run the three never-scored suites (`factory-screen`, `-errand`, `-errand-needed`) once on the deployed release and write one report|yes|about $0.02|
|3|Put a route id on every step that spends: Sonar and Tavily (`research/tools`), podcast stages, audio door, `eval.*`, `image.enhance`|yes, as one Issue|closes the 24 % that no route owns; no behaviour change|
|4|Pin the third labeller or drop it: `eval.mine` still buys a `gemini-3.8-flash` label that no route carries|decide before the next mining run; default: drop it, keep two labellers|saves $1.78 per 14 days|
|5|Take the fallback seat when a 5xx outlasts the transport's three attempts (`factory.digest` lost 21 runs to one outage)|no: the digest comes back in a few hours and a different model's output would muddy the eval; revisit if an outage hits a loop that cannot wait|none|
|6|Alert on production cost only (`purpose != eval`) with a separate eval line at a higher bar|yes; the dashboard tile already splits them|stops an eval sweep from paging the owner|
|7|Eval arms for the Sonnet-medium text seats that have suites: `narrative` (6 cases) and `prose.write` (8) against Haiku high|run only if the owner cares about $4 per 14 days; default: no|about $0.50 to run; at most $4 saved|
|8|Add a Sonnet-medium arm to `factory.steward` and `factory.digest` (Haiku none judged 0.22)|yes for the digest (one arm, $0.01), no for the steward|digest is the one seat a measurement suggests is too weak|
|9|Write a 20-page `cheap.extract` suite from production pages and commit its cases|yes; it is the platform's busiest route and its seat decision rests on 12 reference pages|about $0.30 per run|
|10|Wave 11 (review v4 measure and tune, due 2026-11-17): run it as written, and make its first arm the question the owner raised: Sonnet medium against Haiku high at code reading, with the ledger's dispositions as the score|yes|Wave 11 costs Max time, not API: review has no agw route any more|

On "waves 9 and 10": in `docs/waves/PLAN.md` Wave 9 (review v4 agw side) and Wave 10 (callers, factory, cutover) closed on 2026-11-03.
What the routes README meant by "provisional until Waves 9–10" is Wave 11, which is the proposal above; its arms (light seat,
verifier, K 3 against 2, the deep cap) run on the Max subscriptions and never reach a route of this table, so the numbers of this
audit change nothing about its plan except that research, not review, is where API spend sits today.

## Questions for the owner

1. **Is research worth two thirds of the bill?** The platform does what it did; every lead calls `/research`. Default: yes, and the budget
   plus the answer cache keep the cost per run down; a daily cap is not set (`rules/agent-limits.md` forbids caps on a run, not on spend:
   spend caps are allowed). Say so if you want one.
2. **Round one's numbers were called private** in two docs of this public repo. They are now in `docs/audits/`. Default: keep them; they
   hold no names, hosts or keys. Say so if you want the file back out and the history scrubbed.
