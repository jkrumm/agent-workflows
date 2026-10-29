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
  itself, so no free prompt reaches the paid Opus seat (`prose.critique`'s rule). It is `internal`: out of the HTTP
  router, the OpenAPI document, the CLI and the `cap.<id>` runs, so a door caller reaches Opus only through this workflow's
  lint, review and keep gate; `registry.call` from a step works. The rules (`writerInstructions`) and the fenced data
  (`writerData`) are shared with `prose`'s `writerBrief` for the session, one definition.
- **Findings and notes are clamped to what the prompt renders.** The writer lists the first 50 findings and 30 notes and
  counts the rest; the workflow sends exactly those and the number left out, so a long bad draft is never a failed run.
- `polishDraft` is the steps; the public workflow runs it, and `narrative`'s polish child runs it too.
- **A content failure is a result, a transport failure is an error.** An empty, truncated, starved or non-finished writer
  answer keeps the original with `reason` (`writer returned empty text`, `writer failed: …`), as legacy's `keptReason`; a
  failed call, an unreadable voice guide or a failed review fails the run, as legacy threw.
- **Route.** `prose.write` (`packages/routes/src/table/prose.ts`): `iu-anthropic` (native Messages), Opus 5.5, effort high,
  32k output, legacy's `prose_write`. The gateway seat had no fallback; the shared balance fallback applies.
- No agent definitions: no agent step runs.
