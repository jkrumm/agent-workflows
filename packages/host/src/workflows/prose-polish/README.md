# Prose polish (Wave 10)

`agw prose-polish "<text>"` (`src/workflows/prose-polish/`): the whole prose pass for callers that have no Claude Code
session: Hermes, and the `narrative` workflow's polish stage. Agent-gateway's `prose` job, ported. Inside Claude Code the
rewrite stays in the calling session on Max (`/prose`: `agw prose`, the session's rewrite, `agw prose-gate`); this workflow
is not part of that flow.

| Step | What |
|-|-|
| `lint`, `voice` | `prose`'s modules (`../prose/lint.ts`, `voice.ts`) unchanged; a missing voice guide fails before any spend |
| `review` | the `prose.critique` capability, unchanged (route `prose.review`, cross-lab refusal included) |
| `write` | the `prose.write` capability (route `prose.write`): the writer's system prompt (voice guide, rules, rubric) and the fenced user prompt, legacy's `buildWriterSystem` and `buildWriterPrompt` |
| `gate` | `prose`'s `keepGate` (`judgeRewrite`) over the rewrite |

Input is `prose`'s (`ProseReviewInput`: text, medium, language, register, brief, verdictFirst, context). Output is
agent-gateway's prose job answer, `{kept, text, reason?, language, format, mediumNote, lint{before, after, findings},
review{scores, notes}, visualSuggestions, models{writer, reviewer}, cost}`: `lint.after` and `findings` are the
rewrite's when it was kept, else the original's (legacy's `after`); `cost` is the reviewer's and the writer's USD
together (legacy's sum: an unpriced call counts 0 unless neither was priced, then `null`).

- **The writer is a capability, not a prompt, and not served.** `prose.write` takes the writer's fields (draft, medium,
  register, language, format, verdictFirst, brief, context, lint findings, reviewer notes) and builds both prompts
  itself, so no free prompt reaches the metered writer seat (`prose.critique`'s rule). It is `internal`: out of the HTTP
  router, the OpenAPI document, the CLI and the `cap.<id>` runs, so a door caller reaches the writer only through this workflow's
  lint, review and keep gate; `registry.call` from a step works. The rules (`writerInstructions`) and the fenced data
  (`writerData`) are shared with `prose`'s `writerBrief` for the session, one definition.
- **Findings and notes are clamped to what the prompt renders.** The writer lists the first 50 findings and 30 notes and
  counts the rest; the workflow sends exactly those and the number left out, so a long bad draft is never a failed run.
- `polishDraft` is the steps; the public workflow runs it, and `narrative`'s polish child runs it too.
- **A content failure is a result, a transport failure is an error.** An empty, truncated, starved or non-finished writer
  answer keeps the original with `reason` (`writer returned empty text`, `writer failed: …`), as legacy's `keptReason`; a
  failed call, an unreadable voice guide or a failed review fails the run, as legacy threw.
- **Route.** `prose.write` (`packages/routes/src/table/prose.ts`): `iu-openai`, DeepSeek flash, effort high,
  32k output (legacy's `prose_write` was Opus 5.5 on Messages, the wire now named `anthropic`; DeepSeek only since 2026-10-30, owner direction). The shared balance fallback applies.
- No agent definitions: no agent step runs.

## Eval

`eval/cases.jsonl` holds 8 short drafts written for the set (English and German; article, docs, briefing, vault and chat), each with
planted lint issues (banned words, a negative parallelism, a significance participle, German nominal style and passive chains), one
clean control and one with a code fence and a wikilink. Registered as the module's suite (`agw eval run prose-polish`); the reference
holds the planted phrases (`gone`), the facts that must survive (`keep`: numbers, names, a command) and an optional length band.

The scorer (`scorer.ts`, deterministic, no model judge) re-runs the lint on the draft and on the returned text and scores `valid`,
`honest` (`lint.before`, `lint.after` and `lint.findings` are what the lint finds, and `kept: original` returns the draft exactly),
`notWorse` (no more findings than the draft), `fixed` (fewer findings, 1 for a clean draft), `gone` (share of planted phrases
removed), `facts` (share of must-keep facts present) and `length` (the text's length is 0.5 to 1.25 of the draft's). `pass` needs all at
1, so a writer the keep gate refused scores 0 on `fixed` and `gone`: the original is the safe answer, not a good one.
