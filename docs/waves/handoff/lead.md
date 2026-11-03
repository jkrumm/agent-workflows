# Lead handoff — Wave 15 (Coverage and debt): IN PROGRESS

Lead `agent-workflows-w1-r15`, spawned by mother `agent-workflows-w1-r4`, 2026-11-03 03:29 CET. Wave 8's close-out is
in git at `0826cf4`.

## In flight (rd fan, worktrees under `.claude/worktrees/`)

| Branch | Item |
|-|-|
| `feat/eval-mine-daily` | daily mining job: `--auto` sizing (eval credit from `/health`, IU line $20 from `usage.records` since 2026-11-03T00:00Z, margin $0.75), LaunchAgent `com.jkrumm.agent-workflows-eval-mine` 04:30 via `make eval-mine-job`, off at 200; labeller c's re-asks |
| `fix/compaction-overflow` | compaction output limit / budget in the OpenCode config, a classifier for the error |
| `feat/eval-suites-text` | suites + deterministic scorers: narrative, overview, prose-polish, retrospective |
| `feat/eval-suites-media` | suites + scorers: image-icon, podcast, speech/transcription round trip (queued: capacity) |
| `chore/docs-and-small-debt` | concept.md drift, routes/otel READMEs, overview.classify prompt, flaky ocr env test (queued) |

Next: test fakes into `packages/testing` after these land (it touches every package's tests). `IU_ANTHROPIC_BASE` is
already gone (681e942); the unused `~ctx` rows go with the compaction fix.
