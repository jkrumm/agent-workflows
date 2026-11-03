# Mother handoff

The whole memory of the mother. A fresh mother reads AGENTS.md, `docs/concept.md` §0 and §11,
`docs/waves/PLAN.md` and this file, then continues from **Next action**.

## State
- **New plan 2026-11-01:** inference gateway (Waves 1–4, `docs/gateway.md`), then review v2 and the maturity pass
  (Waves 5–13). Wave 1 done (release `767f643`, REPORT `docs/spikes/gateway/REPORT.md`); Wave 2 done (release `b25aac5`); Wave 3 done (release `3e6026e`); Wave 4 done (release `2e7d5f2`); Wave 5 done (release `bf76dc4`); Wave 6 done (release `9cf9625`); Wave 7 (spec) done, argo `84053e8`; Wave 16 (accounting, ex-13) done `9c34697`; Wave 17 (review on the subscriptions, design) stopped at the owner's sign-off of review v3 (close-out `d7bdc76`,
  one page at the top of lead.md, design `docs/review-v3.md`); Wave 8 resumes
  after it without an owner session; Wave 7b (build) done 11-03 (argo `6702133`). The 2026-10-30 plan is finished (concept.md Final retro); STOP removed.
- Owner actions done (PLAN context): orgs linked, keys seeded, cycle days, no payment method. Left: `me2` keys
  (~2026-11-02, 7-day claim window); until then the `me2` pool stays disabled.
- Lead's close-out channel: `docs/waves/handoff/lead.md` (the mother owns PLAN.md and the retro log;
  the lead writes per-step verdicts, Left behind, gate evidence and retro notes there, then idles).
- dotfiles `make doctor` / architecture-check may be red outside this fleet (Athena, teamchat, collie pin,
  tailscale drift). Not ours; gates are judged on our rows only.

## Lead
- Mother `agent-workflows-w1-r4` (pane t4f, account me2); Wave 8 lead `agent-workflows-w1-r14` (pane t102, account me2), spawned 2026-11-03 ~02:00.
  Rotation policy: a fresh lead per wave unless the last one closed under ~30% context.

## Decisions taken
- 2026-11-03 owner: `review.synthesis` -> Haiku 5.5 high. Wave 17 gets its own Opus high lead and a mature,
  integrable design: callable like agw itself (CLI, the same contract), not a script bolted on.
- 2026-11-03 owner: `research.agent` -> Haiku 5.5 high now (reverses 11-02 18:10 (2)); act on pacing now (not after
  7 days); review should end up off API credit, on a subscription-based Claude Code review agent (interactive factory
  sessions, not `claude -p`): Wave 17 researches and designs it before Wave 8 resumes. Relayed the hotfix to r12.
  Live `7a58222`. Prod credit last 48 h $67.27, ~97 % review; pace since the angle hotfix ~$50/day vs ~$10/day the
  credit sustains. Next lever (r12): cap angle prompts under Haiku's 100k long-prompt tier. Owner: synthesis to Haiku too. Live `f889a72` (#121 contextLimit, #122): live standard review $0.117 (was $0.144 standard,
  $0.28 router mean); GT dev 4 cases recall 0.75 -> 0.50 (one flip, n=4, noise or synthesis seat: Wave 9/11 measure it).
- 2026-11-02 21:00 owner: no labelling session ("I will not answer 155 questions"). Ground truth is validated by a
  third labeller and a second judge on other vendors (PLAN Wave 8); reports state the LLM-consensus limit. Rule for every
  wave: never plan owner work beyond a few minutes; a human check is a ≤ 10-item sample, asked only when the automated
  bar fails. The owner also flagged the human queue (17 open, oldest 10-15, most from other fleets); ours (CONTEXT7) resolved.
- 2026-11-02 18:20 owner signed spec v7 (argo `9fd63c7f`): decisions 1–4 as recommended, 5 deferred, plus §Insights
  (rule-based, numbers never model-written). Built beside Wave 8 as argo Wave 8, its own lead in the argo checkout.
- 2026-11-02 18:10 owner: (1) `otel.agent` -> Haiku 5.5 high now (scores equal Sonnet; cost counts while over pace), in
  Wave 8's next deploy; live at `ec328a0` (otel run $0.0058, all Haiku rows on credit). (2) `research.agent` stays Sonnet medium. (3) `prose.review` stays DeepSeek
  (cross-lab, off the credit); `review.adversary` unchanged until review v2 removes it. (4) Spec v7 not yet signed: the
  owner is reviewing the mocks; Wave 7b waits. (5) Production pacing decided after 7 days of post-hotfix data (~11-09).
- 2026-11-02 16:10 owner (hotfix ahead of Wave 6): review burns the credit (67 reviews in 2 days = $52.50, $0.78 each;
  `review.angle` on Sonnet $46.29). Restore the v3.5 split: `review.angle` -> Haiku 5.5 high (EASY), `review.angle.deep` and
  synthesis stay Sonnet; deploy and verify today, target ~$0.13 per review. Review seats are final only in Wave 11; the
  Wave 9 native `/code-review` arm on Max is the candidate for moving review onto subscription quota. Relayed to r9.
  Live 2026-11-02: PR #109, release `61b7687`, a 4-angle standard review $0.158 (the angles $0.077 per review vs ~$0.69 per review on Sonnet).
- 2026-11-02 owner: two waves inserted after Wave 5, the rest renumbered +2. Wave 6 moves every text and agent seat
  onto measured Claude choices (pulls the tier structure forward, adds credit pacing for evals); Wave 7 is a new
  usage-view concept in Argo (spec v7, owner sign-off on the spec is a stop, then build).
- 2026-11-01 ~22:50: old mother r2 and lead r3 were resumed beside r4/r5. Settled: r4 mother, r5 lead (r2 stepped down, owner: "w1-r4 owns the fleet");
  r3 hands r5 its review verdicts, then idles and gets closed. Accepted departures from gateway.md (r2): no bootProcess; SQLite ledger to usage.records,
  at-least-once with idempotent keys and quarantine; build-hash restart. Close-out must state them for concept v3.14.
- 2026-11-01 owner: Admin keys in the mini's secrets cache are authorized (the owner asked for them to be wired, for the
  Wave 4 reconciler). Personal one-person orgs, no payment method; accepted risk, not a stop.
- 2026-11-01: mother and lead (`w1-r2`, `w1-r3`) ended ~19:46 mid-Wave 2 (the `iu` session window at 98 %); a fresh
  mother resumes from PRs #81 and #82.
- 2026-11-01 owner Admin API facts: cost_report in cents with group_by description; spend_limits/balance unreadable on
  Individual Orgs, the registry stays the source; iu spent $56.11 on 10-31 outside any gateway. Lead told: meter seeds
  from max(ledger, cost_report) since cycle start.
- 2026-11-01 19:30 owner (via software-factory program lead, review-v2): IU repos out of eval cases; owner labels in
  Wave 8's session; native `/code-review` arm on Max as factory spawns, early is fine; review-eval API spend low — Max
  first, Waves 9 and 11 API sweeps on a small `dev` slice before full `test`. In PLAN context; brief Waves 8/9/11 leads (renumbered 2026-11-02).
- 2026-11-01 owner: build the inference gateway in agw (no adoption); agw's seats move to Claude to spend the
  credit; EU endpoints don't matter; the Athena team key is Athena Teamchat's only. Headroom default $2 per pool.
- 2026-10-29: Sonnet review angles for `--deep` only, Haiku default (recall 0.017 → 0.13 at 9.4× cost;
  IU constrained). Revisit when the IU budget relaxes.

- 2026-10-29 owner: workflows only need to work properly (parity, verified live); no tuning or
  experiments; per-workflow reworks (review especially) come later. In PLAN's header; relayed.

- 2026-10-29 owner: EU runtime does not matter; no EU pinning of routes (PLAN header, Wave 9 step).
- 2026-10-29: decide confirmed off Requesty (decision-1-eu answers from Sweden Central); triage on
  Bedrock, no Requesty.

- 2026-10-29 owner: all review off Max (claude -p burns ~1.8x the Max window). agent-gateway review
  loses its Max fallback now and refuses once iris (last caller, 16 jobs since 10-28) uses
  `agw review --pr N`; asked iris-mother. Review OCR off by default. agent-gateway/.env's
  AGENT_GATEWAY_REVIEW_OCR=0 (set by the argo session) is kept and owned by us.
  iris confirmed: review on `agw review`, audio and decide/triage on the host; it no longer calls
  agent-gateway or audio-gateway at runtime. agent-gateway's review refuses (fe14b53).
  Kept on Max by assumption: in-session `/review --deep`, the degrade-to-`/code-review` fallback, the
  fleet's own `/code-review high` (none is `claude -p`); flip if the owner says so.

- 2026-10-29 owner: no argo audio bridge; argo needs no audio integration. Door-only listener
  (91de8f3) to be deleted; argo's audio routes removed with audio-gateway in Wave 11.

- 2026-10-29: research, otel, prose and podcast stay on their Requesty routes with the Terra fallback
  (parity; the per-workflow reworks may move them).

- 2026-10-29 owner: dispatch unused → agent-gateway and `agw-legacy` retire completely in Wave 11
  (concept v3.9). Worker tabs close right after merge; herdr-reap to close merged fan tabs (Wave 10).

- Wave 11 data rule: gateway data is backed up and kept, never deleted (stop reason 2).

- 2026-11-01 owner (d56e8c1): claude-platform keys in vault `mini`, seeded; IU and ME resolve, ME2 placeholder until
  ~11-02 (me2 stays disabled). Admin probe on IU and ME. Relayed to the Wave 1 lead.

## Open decisions
- none

## Overnight
- `fleet-keepalive.sh` is retired (dotfiles b0c835d); the factory's wake note keeps the mother going. A real stop: write
  `docs/waves/handoff/STOP` (first line = reason) and commit.

## Obstacles noted
- 2026-11-02 evening: mini load ~100 from non-agw processes (iOS simulator, VMs, weatherorb); local `make check` flakes on
  timing tests, so Wave 8 gates merges on CI's `make check` (same command, hosted runner). For the owner, not ours.
- 2026-10-27: agent-gateway MCP timed out at the mother's session start; the lead checks the `/review`
  door and falls back to `/code-review high` on Max if it stays down, noting it in Left behind.
- 2026-10-27: `rd wave` numbers tabs from labelled "wave N" tabs only, not agent names; the mother was
  named `-w1` and blocked the first spawn. Fixed by renaming the mother. dotfiles fix (count taken
  agent names too) waits until the P0 wave frees dotfiles.
- 2026-10-28: Max room is tight (iu and me at ~98% weekly; me resets 10-29 06:00, iu 10-28 16:00);
  `rd` pauses rather than spilling. A pause is not a stop.
- 2026-10-28: Wave 3 deploy waits on owner 1Password request `20261028T005518-15306` (creates
  `op://mini/agent-workflows/{API_SECRET,ARGO_URL,OTEL_EXPORTER_OTLP_ENDPOINT}`); MacBook unreachable
  overnight. Queued via ask-human; the lead retries. Not a stop.
- For the owner's report (not ours to fix): agent-gateway `dispatch` credential-isolation gap
  (`dispatch-worktree.test.ts` fails on the mini, system `credential.helper osxkeychain`); a sweep
  worker pushed a branch to the IU GitLab repo prometheus-epx (deleted, no MR; rule added to briefs);
  modelpick main checkout has an unpushed local commit `6d7c624` still calling `agw`.
- Wave 4 first step (added to PLAN): direct capability calls over HTTP are billed but not
  recorded (N6) — route them through a one-step run or record their usage.
- 2026-10-28 ~04:05: IU/DeepSeek (Requesty) 503 Insufficient Balance; owner request
  `20261028T040759-9702` queued by the prometheus fleet. Blocks Wave 4's side-by-side numbers if it
  persists — a spend item for the owner (stop reason 2 only if the fleet has nothing else to do).
- 2026-10-28: a lead's `/code-review` fork checked out a branch in the shared main checkout (detached
  HEAD where the mother commits); restored, lesson in briefs. `git status` before every mother commit.
- 2026-10-28 ~09:00 owner direction: DeepSeek behind IU is out of balance (other IU models answer).
  No gateway `/review` in the fleet; interim tests/evals on the Athena team key
  (`op://Private/athena-teamchat/key`, careerpartner; not in the mini cache yet, never in this repo);
  route fallback to GPT-6.1 Terra medium on balance failures; ported review and the `/review` skill
  degrade to "review in-session with /code-review". Relayed to the lead; in PLAN (budget line, Wave 4).
- 2026-10-28 ~09:30: deploy chain done and live-verified (owner answered the re-asked dialog).
  usage-tracker session (`usage-tracker-9f`) fixed the `iu_key` contract; accepted, in PLAN Wave 4;
  tell it when deployed. Owner said a message hit the wrong prometheus-scripts chat; the lead says it
  sent none (owner dialog only) — not from this fleet as far as the record shows.
- 2026-10-28: athena-mother's pane is gone; the team-key usage window (~$3.8) was not announced to
  it. Report to the owner. usage-tracker-9f's socket is gone; the `iu_key` deploy notice was not
  delivered (Argo must accept `iu_key` on its side).
- For the owner: team-key spend Wave 5 ≈ $4.64 (notice in `handoff/lead.md` at `f562b05`); a lead's
  host-wide `pkill -f "bun test --isolate"` ~21:25 may have killed another fleet's test run.
- Gate lesson: the merge train read only the mini's `make check`; CI was red for a wave. Wave 6 fixes it.
- For the owner: MacBook ask-human `20261029T033409-656` (remove research-gateway's MCP registration
  there). Team key: Wave 6 $26.13 (running total since Wave 4 ≈ $44).
- CONTEXT7 key: done via athena-orchestrator (request `20261029T080529-10120`); ref swapped (`349ad6b`).
  Workers ran `agw review` 3× against the direction in Wave 7 ($0.46); briefs now forbid it.
- 2026-10-29: old-gateway caller inventory (owner asked about iris): iris, argo, hermes-agent,
  dotfiles, modelpick, homelab monitors, warden (retired), usage-tracker collectors. In PLAN Waves 8
  and 10. Asked iris-mother (rd say) to plan a switch wave and say whether `triage` must be ported;
  Answered: iris switches audio now (its Wave 16 S3); `triage` ported as-is in our Wave 8, then iris
  Wave 17 drops its agw adapters once our lead sends the decide + triage contract. argo's audio switch
  moved to Wave 9 (VPS reachability by the tailnet-grant precedent; security review).
- 2026-10-29 ~13:00 owner: Argo shows "review 46.7 M" and combines personal IU with the team key.
  Agent `argo` (pane w5V:p1, rd work) runs `~/.local/state/agent-workflows/briefs/argo-usage.md` end to end
  and reports via rd say; findings inside agent-workflows come back to the mother for the lead.
- 2026-10-29 ~13:25: triage + decide live for iris (purpose `iris`; per-caller identity is only
  `x-agw-purpose`); contract delivered; iris-mother switches audio (S3) then decide/triage (S4) in its
  Wave 16 and reports when iris no longer calls the old gateways. Asked the lead to confirm decide's new
  route avoids Requesty. For Wave 8's retro: decide's model move shifts the scorer judges' calibration.

## For the owner (not stops)
- PR #83 (shop, another session) must spread a tier in `vision.ts`: Wave 6's guard fails a `model:` literal.
- 34 duplicate usage rows ($0.19) and `~/.config/agw/{iu,athena-iu}.env` left undeleted (query and detail in PLAN Wave 3
  Left behind); ≈ $9.3 team-key review spend before the Wave 3 deploy; Hermes has no lane outside the gateway now.
- The software-factory lead asked about `agw agents` (its FV Wave 5), routed to the mother; not in this PLAN. Answer when
  it asks again: it belongs in the factory's plan or a later agw wave, not Waves 4–13 as written.

## Next action
- Wave 8 done (`360e5f8`, 43 cases + 100 controls). Wave 15 (coverage and debt, the daily mining job, compaction
  overflow) pulled forward and active while the owner reads review v3.
- On the owner's sign-off of review v3 (5 points in lead.md `d7bdc76`): rewrite Waves 9–11 from the close-out's proposal
  (Wave 12 loses review's seats), Wave 9 waits for the sign-off (and Wave 15 to close). Cross-repo asks (dotfiles agents + `/review`, software-factory `reviewer` role) go into the waves.
- Owner changes to the five points: fold them into the rewrite; a rejected pick goes back to a short Wave 17 follow-up.
- Still owed by the owner: me2 keys and expiry day (+$100 a cycle; eval credit is the bottleneck now).
- Wake-loop: the factory re-fires `workers done` while the lead idles on shells. Answer with a blocking ~9.5-min poll on
  lead.md (bash loop with perl select, foreground timeout 590 s; `rd read` under `timeout 15`), not a bare re-declare.
- `rd wave`'s gate checks only the predecessor in file order and needs `- [x]` steps there; waiting waves get a non-`active`
  status, pulled-forward waves sit before the waiting one.
- Commit only own paths (`git commit -- <paths>`). Shell: never nest double quotes in a `factory session note`; use a file.
