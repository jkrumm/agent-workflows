# Prose (concept §10)

`prose` is agent-gateway's lint → cross-lab review → rewrite → keep gate, minus the writer: the rewrite runs in the
calling Claude Code session on Max, so the platform does the two parts that need no Opus.

| Command | Does | Cost |
|-|-|-|
| `agw prose` | lint (code) and one cross-lab review call (route `prose.review`); answers `{language, format, mediumNote, lint{findings, counts}, review{scores, notes}, visualSuggestions, reviewer, voicePath, writerBrief}` | one call on the review route (about $0.004 on legacy's recorded jobs) |
| `agw prose-gate` | the keep decision on `{original, rewrite}`: `{kept: rewrite\|original, text, reason?, lint{before, after}}`; no model, a recorded run at cost 0. An empty rewrite is valid and keeps the original; a blank original is refused | 0 |

- **Command names.** The gate is the workflow `prose-gate`, command `agw prose-gate`. The host refuses a command that is
  a prefix of another, so `agw prose gate` cannot sit beside `agw prose`; workflow ids may now carry a hyphen inside a
  segment, only between alphanumerics and before a letter (`prose-gate`; the one operation-id helper makes it `proseGate`
  for the route and the uniqueness check). The brief names `agw prose-gate`; a test asserts it is the
  registered command.
- **The brief.** `writerBrief` is legacy's writer system prompt (rules and rubric) and user prompt (lint findings, reviewer
  notes, brief, context and draft as fenced data) in one block, without the voice guide: the session reads `voicePath`
  itself. The review prompt is legacy's, word for word, and carries no voice guide (legacy's did not either).
- **Fences.** Every prompt gets a fresh 128-bit random token, never derived from the text; it is regenerated while any
  fenced body contains it. Resume determinism comes from the journal (the step result), not from rebuilding the prompt.
  The brief has a token of its own, never the one the reviewer saw, built in a journaled step (`brief`) so a resumed run
  reads it back; the reviewer's notes and the lint excerpts (quoted draft text) have `<<<` and `>>>` made inert where they
  are inlined into the brief, which also lists at most 50 findings and 30 notes and counts the rest. The returned review
  keeps the reviewer's own words. A draft can make the reviewer echo its closing marker; the regeneration loop is capped
  at 8 tries.
- **The gate** takes no `medium` (its rules do not depend on it). It judges the trimmed rewrite and answers `text`: that
  trimmed rewrite when kept, else the original as given; the caller writes `text`. It is `judgeRewrite` unchanged: same format, every fenced block, URL and wikilink target kept, none added, no
  fence left open, no lint rule with more findings. `lint.after` is the rewrite's own lint, kept or not (an empty rewrite
  is kept out with the original's).
- **Cross-lab refusal.** The writer is always the calling session (Anthropic). `prose.critique` refuses a `prose.review`
  route whose primary or fallback is not on the OpenAI chat wire (an agent harness, an Anthropic wire) or whose model names an Anthropic family (`claude`, `anthropic`, `opus`, `sonnet`, `haiku`,
  `fable`, vendor prefix included): at boot (`createCapabilities`, after `AGW_ROUTES`) and again on the route each call
  resolves. A malformed `AGW_ROUTES` stays the first call's `NOT_CONFIGURED`, as for every other capability.
- **Capability.** `prose.critique` (route `prose.review`, `agw prose-critique`) takes the review fields (non-blank text, medium,
  register, language, `draftFormat`, verdictFirst, brief, context), never a prompt: it builds the fenced reviewer prompt
  itself, so no free prompt on the paid seat is reachable over HTTP or the CLI. A `verdictFirst: false` draft gets no
  `verdict_first` score, stripped in code. The registry has no internal registration, hence the structured input.
- **Port.** `lint.ts` is `server/lib/prose-lint.ts` of agent-gateway at `15a8e6d` with `noUncheckedIndexedAccess` casts
  and its tests (`prose-lint.test.ts`); `gate.ts` is `judgeRewrite`/`worsenedRule` from `server/jobs/handlers/prose.ts`.
- **Eval.** Suite `prose` (plain cases, scorer `scorer.ts`: `valid`, `notesPresent` (reported, not part of `pass`: a clean
  draft may get none), `scoresInRange`, and against a recorded case `scoreAgreement` and `lintAgreement`, which compares
  the findings (rule and line), not their count). Rules 1 and 2 of the pre-registered set were offline (legacy lint and the real legacy `runProsePipeline` on canned
  adapters) and were run once; that script is deleted with agent-gateway (Wave 11). Rules 3 and 4 need live review calls.
- No agent definitions: the workflow runs no agent step, so it adds nothing to the run fingerprint beyond its `version`.

## Callers without a Claude session

Hermes and the `narrative` workflow have no Claude Code session to rewrite in, and a cheap brain model is not legacy's Opus
writer, so the platform carries the rewrite for them: `agw prose-polish` (`../prose-polish/`) runs this workflow's lint and
`prose.critique`, one call on the `prose.write` route (Opus on IU, native Messages) with the writer prompt the brief above
is built from, and the same keep gate. The `/prose` skill flow for Claude Code is unchanged: the rewrite stays in the
calling session on Max.

## Route

Model and rate: `packages/routes/src/table/prose.ts` (the only home of model ids). Source seat: agent-gateway
`GET /api/routing`, 2026-10-27, unless noted.

| Route | Source seat | Wire |
|-|-|-|
| `prose.review` | `prose_review` (SINGLE_SHOT); the capability `prose.review` calls it and refuses an Anthropic route | iu-openai |
| `prose.write` | `prose_write` (iu-anthropic, native Messages, Opus 5.5, adaptive thinking at effort high, 32k output); used by `prose-polish` only, never by this workflow | iu-anthropic |
