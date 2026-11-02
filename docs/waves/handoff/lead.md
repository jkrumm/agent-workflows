# Lead handoff — Wave 3 (Callers move, seats onto Claude): CLOSE-OUT

Lead `agent-workflows-w1-r6` (pane t50), 2026-11-02 ~01:45 → ~09:50 local. Briefs on the mini (not in git):
`~/.local/state/agent-workflows/briefs/gw3/` (gateway, transports, opencode, audio, usage, seats, deploy, live, rates, hermes,
oc, modelpick).

## Live state

agent-workflows release `3e6026e` (host, audio), gateway build `6123d4041b283b0e` (from `55d89e6`) on `127.0.0.1:7794`,
`make deploy` OK, `make verify` PASS at both (`3e6026e`: smoke `01a19b6b-4f2a-…`, cap `01a19b6b-544e-…`, audio
`01a19b6b-582d-…`; `55d89e6`: gateway requests `01a19b60-8e6a-…`, `01a19b60-947f-…`, `01a19b60-9ad4-…`, agw-opencode
`01a19b60-a0d4-…`). agw holds no provider key:
`.env.tpl` has no IU or Anthropic ref, the host and audio call the gateway with the API secret (caller `agw`), the OpenCode
server and `ocr` with the `agw-opencode` door token (a gateway-only caller, refused by the audio and image doors).
`data/door-tokens` gained `agw-opencode`, `oc`, `modelpick`. hermes-agent master `5f74d3d` deployed (`make deploy` verified,
patches re-applied to `~/.hermes/hermes-agent`), dotfiles master `a46ce79` (`oc`), modelpick master `b476704` (web
restarted). Every fan worktree and worker of this wave closed. Not ours, left alone: `feat-shop-amazon*`, PR #83.

## Per-step verdicts

| Step | Verdict | PRs / commits | Review |
|-|-|-|-|
| agw on the gateway | **PASS.** Every transport (capabilities, image, audio, OpenCode, `ocr`) on `AGW_GATEWAY_URL`; `iu-anthropic` is the `anthropic` wire with `x-agw-fallback: none`; attribution headers from the step (`ctx.attribution`, `AgentOpenSpec`, an OpenCode `model.request` plugin walking child sessions to the root); 1 h cache writes priced at the 1 h rate (OpenCode asks 5 m only, captured); the outbox writes only what the gateway cannot price; `IU_KEY_ID`, `iu.env`, `athena-iu.env` handling, `ANTHROPIC_API_KEY` gone | #87, #88, #90, #91, #92, #95, #96, #97 | each: agw review (deep on #87, #88, #91, #92, #95) + `/code-review high` on #87, #88, #91, #92, #95; fixes landed, round 2 agw review on #87 |
| Seats onto Claude | **PASS.** `TRIVIAL` Haiku none, `EASY` Haiku high, `STRONG` Sonnet medium, single calls on `anthropic`, agents on OpenCode; every Claude route falls back to GPT on IU (Luna low / Terra low / Terra medium), guard tests. Live: 20 Claude routes `api_credit` on `iu`; a scratch gateway with every pool disabled answered 402 and `cheap.title` moved to Luna (`refused/no-pool` pick, Luna `iu-api` row) | #93, #94 | agw review each; #94's findings fixed |
| Hermes, `oc`, modelpick | **PASS.** Each with its own door token; `-eu` ids gone; Hermes vision on `anthropic_messages` (Sonnet), approvals Haiku, `session_affinity_header: x-agw-session`, four IU-host patches extended to the gateway; modelpick probes force IU (`x-agw-upstream: iu`), catalog on `GET /anthropic/v1/models`. Live: a Hermes turn (`hermes` lane, DeepSeek priced, session bound), `oc run` Haiku `api_credit`, a modelpick forced probe on `iu-api` | hermes-agent #14, dotfiles #58, modelpick #4 | agw review each (Hermes deep: `needs-human` on failure independence, below) |
| Concept note | **PASS.** v3.14 (the gateway as built, the narrowed writer rule, two GPT seats by design); the stale "402/503" fixed at `docs/concept.md:337`; `docs/factory-input.md:17` already named Anthropic's 400 | landed in `93e3d2e` (the mother's commit swept the lead's uncommitted edit from the shared checkout) | lead |
| Review crash | react-doctor 0.9.18 reports `message`, not `title`: every review with a finding died at synthesis | #89 | lead diff read, make check (no agw review: it was the broken tool) |

## Gate evidence

- `make check` in the train after every rebase, CI green on each merged head; flakes (a 5 s hook timeout, one unnamed
  fail) passed on rerun, see Left behind.
- `make deploy` + `make verify` PASS at `55d89e6` (ids above): the smoke and `agw llm title` runs each have one
  `source='gateway'` row (`api_credit` on `iu`, `smoke.ping/title`, `cap.llm.title/call`, priced) and no
  `agent-workflows` row after the outbox synced; the `agw-opencode` token lands `agw_workflow`.
- `make live-routes`: a live call per route, proved by its stored gateway row (model, `outcome ok`, priced, lane
  `agw_workflow`): 32 routes PASS on `55d89e6` (20 Claude on credit, 12 IU incl. DeepSeek, Terra, Gemini); after #97 four
  IU routes again on `3e6026e`, their runs hold gateway rows only.
- `@verifier`: `agw-gateway` spans in ClickStack prod with pool, pick reason, caller, model, tokens, cost (no run
  attributes on spans: those live in the rows); every agw gateway row carries `run_id`, workflow and step; no key
  material in the gateway or host logs. It found the duplicate rows #97 fixed.
- Gateway `/health`: ledger unsynced 0, quarantined 0; `iu` meter $57.70 (seed $56.11), `me` $0, `me2` disabled.
- Fallback live: see the seats row. OpenCode's 402 path: the pinned 2.0.32 surfaces the marker and the step moves
  (captured against a loopback stand-in; no drained real org exists to test against).

## Departures and lead decisions (for the mother)

- **The gateway writes token-priced inference only.** Media agw prices per minute, character or image (TTS, STT, images,
  Replicate) sends `x-agw-usage: caller` (honoured for caller `agw` on media paths only) and agw's outbox keeps those rows,
  plus anything billed outside the gateway (Tavily). In concept v3.14.
- **Gateway additions**: `x-agw-project`/`x-agw-workspace` → `repo`/`project_raw`/`workspace`; lane `agw_workflow` for
  `agw-opencode`, `lane_detail.raw` = caller for `other`; `GET …/models` passthrough without a row (Anthropic and IU);
  `x-agw-upstream: iu` forces IU (reason `forced`, no binding); IU text calls without `usage.cost` priced at the route rate
  (`@agent-workflows/routes/rates`), the row's `model` is the concrete id when IU echoes it behind a provider prefix
  (`openai.gpt-6.1-terra` → `gpt-6.1-terra`, echo in `model_raw`).
- **Two seats stay on GPT**: `review.adversary` (cross-family critic, the capability needs the chat wire), `podcast.write`
  (`Llm.round`, the writer's tool loop, speaks only the OpenAI dialects). `prose.review` stays DeepSeek (refuses Anthropic).
- **STRONG = Sonnet effort medium** (unmeasured; the 2026-10-31 eval had Sonnet low only).
- **Door scope**: `agw-opencode`, `oc`, `modelpick` open the gateway only.
- Hermes review asked an owner question (all Hermes lanes, fallback included, now share the gateway as one point of
  failure). The PLAN's owner decision moves Hermes onto the gateway, so not a stop; listed for the owner below.

## Left behind

- 34 duplicate `source='agent-workflows'` rows ($0.186, 2026-11-02 08:09–08:32 UTC) for IU text calls the gateway also
  recorded (IU's provider-prefixed echo slipped the outbox filter until #97). Not deleted (irreversible; owner's call):
  `select … from usage.records r where source='agent-workflows' and ts between '2026-11-02 08:09Z' and '2026-11-02 08:33Z'
  and exists (select 1 from usage.records g where g.source='gateway' and g.run_id=r.run_id)`.
- `~/.config/agw/iu.env` and `athena-iu.env` (team key copies, mode 0600) still exist on the mini; nothing in agw reads
  them now. A rollback to a pre-Wave-3 release would read `iu.env` again. Not deleted: the owner's call.
- Team-key spend: the Wave 3 reviews before the deploy ran on the old host, whose `iu.env` set the Athena team key:
  ≈ $9.3 (10 `agw review` runs, one crashed at $1.10). After the deploy reviews run on credit/personal.
- Hermes: a gateway outage takes every Hermes lane (no direct-IU lane left); `make verify`/`hermes-liveness.sh` do not
  check the gateway or the door token (only `make status`); `/openai/v1/props` (501) writes a zero-token error row per
  process TTL; a Luna aux stream logged as error; a "too large" error without a token count is retried, not compressed
  (loopback counts as local); vision not exercised live; a `make deploy` rollback reports `ROLLBACK ALSO FAILED` because
  `patch-check` reads the new patches as drift. Hermes' `scripts/model-release-watch.py` (untracked, not ours) was moved
  aside for its deploy and put back. Stale: Hermes `SOUL.md`, `README.md`, `.claude/skills/hermes-update`.
- modelpick: the bench stays on IU direct (Keychain); deployment rows' rationale text for vision/approval is stale;
  two Replicate calls lack `x-agw-upstream: iu` (zero-cost catalog reads now write no row).
- `oc`: an unreadable door-tokens file falls back to IU direct silently.
- agw: in-flight runs across the deploy and OpenCode sessions created before it have no attribution (unbound rows);
  `traceparent` never reaches the gateway from OpenCode (2.0.32 overwrites it), the join is `x-agw-run-id`; OCR (off)
  sends no attribution; an `AGW_ROUTES` override that changes a model may double-count or drop its row (Wave 5 removes
  `AGW_ROUTES`); a gateway 402 on a podcast call is recorded as unknown usage; triage's reasoning tokens read 0 on the
  `anthropic` wire; a Claude route without a fallback would fail on a 402 (guard test forbids it in the table).
- `scripts/live-routes.sh` copies the Claude alias map (drift risk with `table/claude.ts`).
- Flaky under load: a 5 s `afterEach` hook timeout (one train), one unnamed fail (another); both green on rerun.
- The `agw agents` question (FV Wave 5) and the `agw digest` track came from the software-factory lead; I said the factory
  spawns the digest worker itself after this wave and routed `agw agents` to the mother.

## Retro notes for the mother

- **A lost wake cost 3 h.** From ~05:00 to 08:20 the lead sat on a declared wait while every worker was idle; no
  `workers done` note came (an hc core restart happened in that window). A lead must not rely on one wake: after declaring,
  a bounded foreground poll on the thing it waits for (a branch head, a PR, `pgrep merge-train`) is what actually worked
  for the rest of the wave.
- `rd say` refused workers whose factory status read `none` though they sat at a prompt; `hc send <pane>` delivered.
  Watchdog pings ("waited on a confirmation") were false for a worker mid-command.
- The live checks paid off a third and fourth time: every test and review passed while IU's GPT and Gemini rows landed
  unpriced and with prefixed model ids, and 247 zero-token catalog rows appeared from modelpick. Only `make live-routes`
  reading the stored rows showed it (#96), and only `@verifier` joining the two sources by `run_id` showed the double
  count (#97). Read the stored rows from both writers, not one.
- The review tool itself was broken (react-doctor schema change): a dogfooded reviewer needs a smoke review in
  `make verify`, or the first real PR finds it at $1.10.
- Branch names collide across waves (`feat/gateway-deploy` existed from Wave 2); the merge train needs a worktree holding
  the branch, and a doc conflict in AGENTS.md's Validate table recurred twice in one rebase (both branches add rows).
- oxfmt and oxlint skip per-file paths under `.claude/worktrees/`: a worker's "format clean" there means nothing unless it
  ran on `.` from the worktree root. Two train rounds were lost to it.
- One checkout, two committers: the mother's `git commit -a`-style commit took the lead's uncommitted concept edit. Each
  role should commit only its own paths (`git commit -- <paths>`).
- Delegated reviews found disjoint things again: `/code-review high` the persisted restart trigger and rollback order,
  `agw review` the door scope and the Tavily rows.
