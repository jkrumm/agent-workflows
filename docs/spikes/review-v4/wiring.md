# Review v4 wiring proposal

Owner direction 2026-11-03: one routed reviewer agent, Max only, no API credit, no `claude -p`, no Agent SDK; the
factory guarantees every wave was reviewed and caps expensive reviews. This replaces `docs/review-v3.md` §Shape and
§Interfaces where they differ. Nothing here is built; the cross-repo asks at the end are written, not executed.

## One agent, two transports

```
in-session:  /review ─ agw review prepare ─ Agent(reviewer, model+effort from the route) ─ agw review submit --stdin
hidden:      agw review ─ prepare ─ factory spawn (role reviewer, one session per job) ─ the same agent ─ submit
                                   └ the route picks none | light | standard | deep, the ceiling admits or holds
```

| Stage | Owner | What |
|-|-|-|
| `agw review prepare` | agw code | Thread and round from the ledger; the **route** (below); the review ceiling and the deep cap; a throwaway worktree at the head (never the caller's tree); the job dir of pointers: `diff.patch` (round ≥ 2: since the last reviewed head when it is an ancestor, else the round-1 base), `stat.txt`, `intent.md` (`--context`, PR body, the wave's PLAN step, the brief), `history.txt` (recent commits on the touched paths), `prior.json` (ledger findings on the touched paths with their dispositions), `REVIEW.md` read from the **base**. Prints the job and the seat (`model`, `effort`) |
| reviewer | the agent (`reviewer.md`) | Read-only; intent, domain rules, system fit and duplication, breakage, security, in that order; `deep` adds one verifier on each `important` finding. Replies with JSON |
| `agw review submit <jobId> --attempt <n> --stdin` | agw code | Schema check; the echoed file list must equal `stat.txt` (empty-diff guard); drops repeats of ledger findings; stable ids; nits capped by `REVIEW.md`; `outcome` computed; idempotent per `(jobId, attempt)`; writes the ledger; prints REVIEW_OUTPUT |
| `agw review dispose <runId> <findingId> fixed\|wrong\|intentional\|irrelevant` | agw code | The answer to every finding (the article: every finding is answered); `prior.json` of the next round and of later changes on the same paths reads them |
| `agw review route --repo --base --head` | agw code | The deterministic router alone (no LLM), for the factory and the wave gate |

In-session is the default for Claude Code callers (the lead, `/ship`, `/implement`): no transport, ~5k tokens of the
caller's context for the reply. The caller sets `model` and `effort` on the Agent call from `prepare`'s seat. Hidden
is for every other caller (`agw review` from Hermes, scripts, `make verify`) and for `deep` from a session that must
not block: the factory spawns one interactive session (`entrypoint: cli`, the unmodified binary, S0) per job whose
prompt runs the same agent and pipes its reply to `submit`.

## Routing: the change sets the tier

`route.py` is the spike; the build moves it into agw (`agw review route`). Rules in order, first match wins; a caller
may raise the tier (`--min`), never lower it:

| Rule | Tier |
|-|-|
| No content change (renames, whitespace) or every file matches `REVIEW.md` `none` (wave plans, spike data, lockfiles) | none |
| A non-test file matches `REVIEW.md` `sensitive` (runtime, middleware, gateway, limits, CLI generator, launchers, env templates, CI, SQL; dotfiles: hooks, settings, the global CLAUDE.md and security rules, secret scripts, plists). A doc counts only where the glob names docs (`rules/security.md`), not a package's README | deep |
| Docs only (`*.md`, `*.mdx`, `*.txt`, or any file under a `docs/` directory) | none |
| Docs only, but an agent-facing file is among them (basename `AGENTS.md`, `CLAUDE.md`, `SKILL.md`, `REVIEW.md`, or under `rules/`, `skills/`, `agents/`, `.claude/`): in doubt the router hits higher | light |
| Tests only | light |
| > 800 changed non-test code lines, or > 3 packages | deep |
| A manifest changed | standard |
| ≤ 40 code lines in ≤ 3 files | light |
| otherwise | standard |

Seats (owner decision 2026-11-04): `light` and `standard` Sonnet medium (one seat until the tier set is collapsed), `deep`
Sonnet high with ONE verifier per `important` finding.
Opus high is not a tier; it stays an owner option for `deep` on the `sensitive` paths if Wave 11 shows Sonnet missing
there. The thresholds are starting values; Wave 11 tunes them on the ledger (a tier's findings that the author fixed,
per tier and rule).

Routed over the last merged PRs (`data/route-*.txt`): agent-workflows 60 PRs in 4.4 days → 34 deep, 23 standard, 3
light; dotfiles 40 PRs in 19 days → 13 deep, 17 standard, 9 light, 1 none. Of the PoC PRs the router sends #92 deep and
#119, #90, dotfiles #51 and #50 standard: #90's header duplication was `important` only at deep (a nit at standard), the
cost of routing by size and paths alone. agent-workflows is deep-heavy because the
fleet works on runtime, middleware and gateway, which AGENTS.md already reviews deep.

## The ceiling: Max only, review waits

- **No API fallback.** v1 (angles, router, synthesis, adversary) and the gateway's review routes are deleted at
  cutover; there is nothing to fall back to. At the ceiling a review **waits**; it never spends credit.
- **Admission:** a review starts on an account below 70 % of its 5-hour window and 90 % of its week (an account
  without a 5-hour reading is judged on its week). In-session: `prepare` judges the caller's own account; above the
  ceiling it answers `held: <account> at <n> %` and the caller either waits or asks for the hidden path (the factory
  may place it on another account). Hidden: the factory's admission (owner's reserve, `drain`, `pace`, never spill).
- **Liveness, not wall caps.** `rules/agent-limits.md` forbids wall-clock ceilings on agent runs, so v3's 5/10/25-min
  kill caps go: an idle watchdog (no new transcript line for 10 min) marks the attempt wedged and kills it; one
  retry on a fresh key, then `needs-human`. The in-session wait in `/review` is the same idle rule on the subagent.
- **Deep cap:** at most `N` deep reviews per account per day (start: 15, near today's peak), counted in agw's ledger
  across both transports. Past it a deep review is **held** until the next day or a one-click allow from the owner
  (the factory's ask); it is never downgraded, since a lower tier would not satisfy the factory's evidence rule. A held
  review blocks only its own ship.
- **What it costs.** The last 7 days ran ~520 v1 reviews across every repo ($236 on API credit). At the PoC's prices
  and the routed mix (≈ 20 % none/light, 40 % standard, 40 % deep) that is ≈ $0.62 API-eq per review, ≈ $330 a
  week (the runs already include re-review rounds): ≈ 25-40 % of one Max 5x week (at $8-13 per 1 %, `README.md`), spread over the
  accounts by the factory. IU repos (`~/IuRoot`) review on the `iu` account only.
- **Two hidden sessions at once**, host-wide (S3). In-session reviews count only per account.

## Convergence

Round 1 reviews the whole change; from round 2 only the diff since the last reviewed head, with `prior.json` holding
every earlier finding and its disposition: no finding repeats, `wrong`/`intentional` are settled, an `open` one still
present is reported once as `stillOpen`. Round 3 with `important` findings left sets `stepBack`; `submit` refuses a
fourth round on the same thread (`needs-human`, the author or the lead reconsiders the approach).

## The software factory's side

**Every wave and every Issue is reviewed at its required tier.**

1. **Evidence kind `review`.** `derive` (`issues/evidence.ts`) computes the required tier of the shipped commits by
   calling `agw review route --repo <path> --base <before> --head <landedAt>`: one router, agw's, never a second copy.
   `ship` is refused unless the Issue has `review` evidence whose tier ≥ the required one and whose reviewed head
   covers `landedAt` (equal, or the commits after it route to `none`, e.g. a plan update). `agw review submit` files
   the evidence itself (`factory issue evidence <id> --kind review --link <runId>`) when the job carries an Issue id;
   a lead may file it by hand with the run id. `none` needs no evidence.
2. **Waves (until F2 makes them Issues).** The close-out carries `Review:` lines with run ids (the lead role's
   existing rule, "never done with Review: none unless the reason is written"). `scripts/wave-gate.py` gains a check:
   `agw review covered --repo . --range <wave start>..HEAD` (every non-`none` commit range of the wave sits under a
   ledger run at its required tier); uncovered → the gate stops the chain with the uncovered ranges named.
3. **Role `reviewer`** in the role table: Sonnet (effort from the job's seat), hidden child placement, its own
   admission rule (the ceiling above), spawn key `review-<jobId>-a<attempt>`, settings with a deny list for anything
   but read-only tools (proven against a planted-injection diff before cutover).
4. **The deep cap** is agw's counter; the factory shows it (`factory status`: "deep reviews today 5/8") and raises
   the ask when one is held.

## Cross-repo asks (written, not executed)

| Repo | Ask |
|-|-|
| dotfiles | `agents/reviewer.md` and `agents/review-verifier.md` from this spike (global, checked in); `/review` skill rewritten to `prepare` → `Agent(reviewer)` → `submit` → dispositions; the `--deep` and degrade branches go; `wave/roles/lead.md` loses its separate `/code-review high` step; `scripts/wave-gate.py` gains the `covered` check; a `REVIEW.md` per busy repo (drafts: `REVIEW.agent-workflows.md`, `REVIEW.dotfiles.md`) |
| software-factory | evidence kind `review` and its `derive` rule; role `reviewer`; the deep-cap ask; `factory status` line |
| agent-workflows | `agw review prepare\|submit\|dispose\|route\|covered`; the ledger; REVIEW_OUTPUT v4; v1 and the review routes deleted; `scripts/verify.sh`'s smoke review on the hidden path at `light` (held by the ceiling = `SKIP`, not a failure); the eval adapter on the new schema |
