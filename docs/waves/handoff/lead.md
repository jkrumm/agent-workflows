# Lead handoff — Wave 15 (Coverage and debt): IN PROGRESS

Lead `agent-workflows-w1-r15`, spawned by mother `agent-workflows-w1-r4`, 2026-11-03 03:29 CET. Wave 8's close-out is
in git at `0826cf4`.

## Landed (live at `740cddb`, `make verify` PASS)

| PR | Item |
|-|-|
| #126 | daily mining job: `agw eval mine review --auto`, LaunchAgent `com.jkrumm.agent-workflows-eval-mine` (04:30, `make eval-mine-job`, installed); labeller c one call per ask |
| #127 | concept.md v3.15 (docs to code), routes/otel/brain READMEs, overview.classify prompt, the flaky ocr env test (a mkdtemp path spelled `test-key`) |
| #128 | compaction: `compaction.buffer` 40k, read-only restart on the route's fallback, unrecognised-failure warning |
| #129 | suites: overview, narrative, prose-polish, retrospective (deterministic scorers, eval-only fixtures) |
| #130 | suites: image-icon, podcast, speech-roundtrip (audio); eval runs post no Slack notice and file no brain note |

Mining, first live run (launchd kickstart 05:18): bug cases 46/200, +3, IU eval $2.75 of $20.

## In flight

- `feat/eval-audio-suites`: the host's eval runs and scores audio-process suites (podcast, speech-roundtrip).
- `chore/testing-fakes`: shared fakes into `packages/testing`.
