# Lead handoff — Wave 20 (Review v4 papercuts): CLOSE-OUT

Lead, 2026-11-03, Opus, account `me2`. Wave 12's close-out is in git at `7d11edb`.
Deployed and verified: agw `4bd04cc` (`make verify` PASS incl. hidden smoke review `rv_whcpu66cyafthrfcmpq5`, light, me2;
gateway unchanged, build `181f23c8608bfc67`). software-factory `4bdc4b8` deployed, `make verify` all checks passed.
dotfiles pushed at `e7a1da0`.

## What landed

| Repo | Commits | What |
|-|-|-|
| agw | `67ada93` | `agw check` on this repo is green. Two causes. The host's work-tree probe (`git rev-parse --is-inside-work-tree`) parsed git's English "not a git repository", but under the host git answers in German, so a non-repo was `step_failed` instead of `invalid_input`. That bug hit every repo; the probe now runs with `LC_ALL=C` (new optional `env` on `ExecRequest`). Separately, the credentials test grepped the make env for `AGW_`, which the host passes legitimately (`AGW_PORT`); it now greps its own `leak-` markers |
| agw | `7aa9e4f` | CLI `coerce` resolves any string field named `cwd` to an absolute path (flags, positionals, stdin), so `agw check --cwd .` and `agw review … --cwd .` work. Host schemas stay absolute-only |
| agw | `89baa86` | Review threads: the resolved key is stored as `scope.threadKey` (no migration) and `status` shows it on the job and in the list (older jobs: null). `prepare --thread` takes the key or a 12-hex id the ledger already holds for the repo (`ledger.threadJob`). `cancel` abandons a `prepared` in-session job (no factory call). Hidden `cancel` reads `error.details.spawn.status` from the factory CLI's JSON error line; unreadable → `running` (job kept) |
| agw | `60c064e` | `eval.gt.calibrate` deleted with the single judge mode, κ, `gt-sample.ts` and the eval-gt tests. `eval.recall` always scores with both judges; the dual scorer string is unchanged and pinned by a test. `docs/review-v2.md`, eval and host READMEs say so |
| agw | `4bd04cc` | `runawayCap` takes per-workflow `minSamples`; `eval.recall` needs 100 done runs before a learned cap (window 200) |
| software-factory | `4bdc4b8` | `spawn cancel`'s 409 `not_cancellable` carries the spawn row (`ErrorBody.spawn`, the CLI's `details.spawn`); design doc and help text |
| dotfiles | `e7a1da0` | `/review` skill: scope goes as `--scope`, `--thread` key or id, `cancel` for stale jobs. `/check` skill: a relative `--cwd` resolves |

The factory change was done directly: no software-factory agent was working (`rd agents`).

## Gate

- `make check` 4065/0 on the final tree (Wave 12: 4091; the eval-gt tests were deleted). `agw check --cwd .` through the
  deployed host: `make check passed; fallow audit --quiet passed` (run `01a1a1dd-ff38`).
- software-factory `make check` 1678/0 (before the doc nit; after it, CLI tests 122/0 and oxfmt clean).
- Live: factory `spawn cancel` on a started spawn answers `not_cancellable` with `details.spawn.status: started`.
  `agw review cancel rv_zbfb6h6cfpo6av2maj65` (Wave 19's stale in-session job) → `cancelled`; the other one
  (`rv_mhsa7ehwsewfkhknwo7e`) was already `abandoned` by a later prepare on its thread. A new job shows `threadKey`
  (`base:c91898f…`). `--cwd .` resolved on `status` and `check`.
- **Reviews, v4 in-session on Max:**

| Repo, range | Rounds |
|-|-|
| agw `d8866cc..4bd04cc` | `rv_njaarmh5majtksrg6naz` deep (sensitive path `runaway.ts`) clean; `covered` true |
| software-factory `07f2f7b..4bdc4b8` | `rv_aay3w3f7b3huforfs6ab` deep (`http.ts`) clean with 1 doc nit, fixed; `rv_pzeuj4lvczfcvwnd52vs` light round 2 clean; `covered` true |
| dotfiles `e7a1da0` | `rv_nach3rdyhby7pyza3yo5` light (docs) clean; `covered` true. The reviewer could not see agw's CLI; the lead checked `--scope` against `agw review prepare --help` and `cancel` live |

## Decisions made here

- **`gt calibrate` deleted, not given a source.** A source means recall journaling both judges' verdicts per pair as
  calibratable runs: Wave 11 work if single-judge scoring is ever worth the saving. Dual costs one extra cheap judge call
  per pair.
- **Unreadable 409 → `running`.** The safe side: the job is kept and may still submit.
- **Relative `cwd` resolved in the CLI for any field named `cwd`**, not per command: every host op takes it as a path.

## For Wave 11 (the mother edits PLAN.md)

- Recall output `judges` is now `{ mode: 'dual', scorer }` (no `kappa`/`reason`). `cohenKappa`/`kappaCI` went with
  calibrate; re-add from git (`60c064e^`) if calibration returns.
- An `eval.recall` started before `4bd04cc` and resumed after keeps working (the journal does not re-parse child input;
  the reviewer checked `runChild`).

## Small gaps found

- Deep tier on a 10-line change: any touch of `packages/server/src/http.ts` (factory) or `packages/limits/src/runaway.ts`
  routes deep (sensitive path), ~100k reviewer tokens. Fine by rule; Wave 11 may weigh it.
- The light dotfiles reviewer cannot see agw's code, so it cannot verify skill text against the CLI (also seen in Wave 12
  for modelpick). Cross-repo claims stay the lead's job.

## Spend

Max only (`me2`): the lead, 1 implementer run, 4 in-session reviewer runs (2 deep, 2 light). API: `make verify` cents.

## Left behind

- Wave 20 `done` in PLAN.md with `**Repos:** dotfiles, software-factory`; no wave flipped `active` (Wave 11 waits for
  2026-11-17, the mother picks). Nothing spawned (orchestrated).
