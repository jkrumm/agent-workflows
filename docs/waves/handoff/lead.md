> **Wave 16 in flight** (lead `agent-workflows-w1-r12`, 2026-11-02): five workers fanned: `fix/failed-step-usage`,
> `fix/cost-null-unknown`, `fix/door-errors-fail-runs`, `fix/eval-mine-cost-history`, `feat/eval-import` (the last
> three queued for factory capacity). The Wave 8 close-out below stands until Wave 16's replaces it.

# Lead handoff — Wave 8 (Ground truth): CLOSE-OUT before the owner session

Lead `agent-workflows-w1-r11`, spawned by mother `agent-workflows-w1-r4`, 2026-11-02 ~16:30 → ~20:30 local. Wave 7's
close-out is in git history (`fdeea26`).

stopped: owner session (labelling)

## How to start the owner session (about two hours)

1. On the MacBook, open `~/Downloads/agw-owner-session/session.html` in a browser (a copy of
   `$AGW_EVAL_DIR/review-gt/owner/session.html` on the mini; self-contained, works from `file://`, no network).
2. 155 items, one at a time, ~40 s each. Keys: `y` / `n` / `u` answer and move on, `j` / `k` move, `e` writes a note.
   - **Commit items (55):** "Is this a real defect that this commit created, at about this place?" `no` for a feature
     change, refactor, preference, an older bug or a different problem.
   - **Finding items (100):** "Does this finding describe this bug?" `yes` only for the same defect (other words are
     fine); `no` for a different issue, even a plausible one in the same file.
   - Answers save in the browser as you go; the page is blind (it never says which cases the labellers accepted or what
     the judge answered).
3. Click **Export** at the end (repeatable): it downloads `owner-labels.jsonl` to `~/Downloads`.
4. Tell the lead/mother it is done. The next session ingests it on the mini:
   ```sh
   scp iumac:Downloads/owner-labels.jsonl /tmp/owner-labels.jsonl
   agw eval gt ingest --commit --labels "$(cat /tmp/owner-labels.jsonl)"
   ```
   It reports case precision (Wilson CI), what the filter drops, Cohen's κ owner vs judge, and the bars.
   **Do not run `agw eval gt pack` again before ingesting**: a new pack rewrites `owner/manifest.json` and the answers
   no longer match it (session id `24b43b759558ca7f`).

## Delivered

| What | Where |
|-|-|
| Double usage rows fixed | `d7a0034` (`callerRecords`: agw writes `usage.records` only for caller-priced media and Tavily; the gateway owns every token-priced row). Release `2f657c0`, `make verify` PASS |
| Ground-truth contracts | `1329364` `packages/eval/src/gt.ts` |
| `eval.label` / `eval.judge` on pinned, no-fallback routes (`eval.label.a` Sonnet medium, `.b` Terra medium, `eval.judge` Sonnet medium); line-numbered diffs; versions hash rendered prompts + seats + schemas | #111 `b43f553` |
| Scorer v3 (recall, detected, severity calibration, false alarms, clean, noise) on the GT suite; `materialize` `isolate` (refs, reflog and alternates cut: no later fix reachable); compare directions | #110 `96b8305` |
| `agw eval mine review` (SZZ, controls, split, labelling, resume, atomic writes, owner emails from `review-gt/owner.json`) | #113 `0369c2b`, `e51fc17`, cost note `6831148` |
| Owner pack and ingest (`agw eval gt pack|ingest`) | #112 `7b2e5ef` |
| otel.agent → Haiku high (owner decision 18:10) | `ec328a0`; eval report + modelpick `2730f60` |
| Deployed | release `e51fc17`, `make verify` PASS |

Reviews: `agw review` on every PR (#110 actionable → fixed: isolate leak; #111 clean + version coverage; #112 actionable
→ fixed: blindness; #113 actionable → fixed: emails out of source, no silent shrink, concurrency 1; one false blocker,
TS2440, `tsc` clean). Merges on green GitHub CI: the mini's load (~30–110, iOS simulator, VMs, weatherorb) made local
`make check` fail on timing tests unrelated to the changes (kill harness, outbox debounce, parseHtml 2 MB, image
streaming, review hardening).

## Proofs

- **Double rows, both writers** (after `2f657c0`): `cap.decide` (`microsoft-decision-1`), `cap.web.search` (`sonar` ×2),
  the verify review (Haiku, Sonnet, Terra), smoke and title: gateway rows only, zero `agent-workflows` rows. A TTS call
  through the speech door: one `agent-workflows` row (`gemini-3.8-flash-lite-tts`, $0.000193), no gateway row. The
  11-02 duplicates (383 rows) stay in `usage.records` (owner's call); argo's v7 `/usage/demand` drops them itself.
- **otel on Haiku:** run `01a19d5c-4f2c`: 8 gateway rows, all `claude-haiku-5-5`, `api_credit` iu, $0.0058.
- **GT path end to end:** eval run `01a19d9e-665a`: isolated clone, light review, judge, scorer v3.

## What the data says (private detail under `$AGW_EVAL_DIR/review-gt/`)

- **Mine** (miner `2026-11-02.1`): 31 repos, 12 748 owner commits, 3 636 fix commits (3 501 after the message filter),
  8 289 SZZ candidates (2 234 dropped as too large, 192 too old, 36 093 cosmetic lines), 1 790 eligible controls, 100
  picked (29 dev, 71 test).
- **Labels:** 150 labelled, **35 accepted (23 %)**: 7 dev, 28 test. Rejected: both no 76, `b` no 28, no overlap 8,
  `a` no 3. Classes: logic 16, ui 4, edge-case 4, security 3, error-handling 3, config 2, data, concurrency, other.
- **First v1 numbers** (light depth, 35 bug cases, dev+test mixed, scorer `2026-11-02.v3+…`; not a decision set):
  recall 0.24, detected 0.59, severity calibration 0.40, 6.3 findings per review, noise 0.09.
- **Spend (purpose eval, since 16:30 UTC):** $12.05 on `me` credit (labels $7.62, reviews $3.20, judge $1.23), $3.32
  on the IU personal key (Terra labeller $2.66, adversary $0.65). Per labelled candidate $0.068; per accepted bug case
  ≈ $0.30. `me` has $1.02 eval credit left; `iu` is not eval-eligible (production over pace).

## Shortfalls in the pack (the page says the totals, never which kind)

- **35 of 50 accepted cases** (+ 20 rejected = 55 commit items): the credit ran out. The precision bar is read on 35.
- **27 of 50 judge-positive pairs** (v1 matched no more on 35 light reviews); 73 negatives fill to 100, all
  preselected (same file or naming it). κ is still computable; a skewed split widens its CI.

## After the owner session (next lead, not done)

1. Ingest (above). Bars: accepted ≥ 90 % right; κ ≥ 0.8. Below the case bar: tighten the filters (`MINER_VERSION`
   bump) and re-mine. Below κ: a second judge on another vendor, disagreements scored `unclear` (`docs/review-v2.md`).
2. Toward 200 bug cases and 100 controls: ~165 more accepted ≈ 720 labelled candidates ≈ $49 (≈ $37 credit + $13 IU,
   over the ~$20 IU stop: ask the mother first). Label in batches ≤ 60 (`eval.mine` hits the runaway cap's static $5
   ceiling until it has 20 done runs; a 147-candidate run was stopped in its rebuild step at $10.12, labels kept).
   Size each batch to `evalAvailableUsd` on the gateway's `/health` (≈ +$3.7/day on `me`; me2's +$100 needs its claim).
   Seeded defects only if fewer than 150 cases survive.

## Left behind

- `agw eval import` (PLAN Wave 8) not built: Wave 9's native `/code-review` arm needs it before it runs.
- `eval.mine`'s label estimate prints `unknown`: its cost-history port is not wired in `boot.ts`.
- Pack blindness, one residual tell: a rejected candidate no labeller claimed shows "Claim: the lines the fix changed"
  instead of a description. It cannot be blinded without inventing a claim; it does not bias the accepted-precision bar.
- Review improvements not taken: a contract test tying `callerRecords` to the `x-agw-usage: caller` call sites; a
  labeller location check against the post-image; abstain when the diff cut drops the blamed file.
- Local `make check` is unreliable while the mini runs the simulator/VM load; CI was the gate today.
- Controls are not reviewed yet (false alarms need them; Wave 9's baseline runs them).
