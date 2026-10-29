# Brain (Wave 7)

`src/workflows/brain/`: `agw brain "<question>"` answers a question from the owner's vault, read-only. Output (the
contract; `schema.ts`): `{ answer, citations: [{ path, claim }], read: [path], status: ok|partial|notfound, warnings,
grounding: { citations, grounded } }`. Input `{ question }`, strict. A long run waits like research (exit 10, `agw run
wait <runId>`).

- **The agent** (`agents/brain`, route `brain.agent`) holds `brain_search` and `brain_read` and nothing else: they go
  through the tool gate (`packages/host/README.md` §Tool gate) to the `brain.*` capabilities (`packages/capabilities` §Brain capabilities). OpenCode's
  own `read`, `grep` and `glob` are offered but denied outside the agent's location (`external_directory`), which
  `brain-opencode.test.ts` proves against the real `opencode`, so the gate is the only way to the vault.
- **Route decision: Haiku 5.5 EU (`brain.agent`), not DeepSeek, and no fallback.** The agent reads arbitrary private notes
  (health, finance); that content never leaves the Anthropic EU route. Unlike every other agent route, `brain.agent`
  has no provider-balance fallback (lead decision, Wave 7): a balance failure fails the run with the typed error
  instead of moving the notes to another provider, and `AGW_ROUTES` cannot add one. `brain.test.ts` pins it.
- **Grounding.** The gate's per-call hook (research's guarded one, `ledgerGrant`) records each `brain_read` that found
  a note into the evidence ledger (the `research_tool_calls` table, the note's canonical path in `retrieved`; reused,
  no migration), the `tools` step reads it once the agent has ended. A citation whose path is not a note the run opened
  (compared `./`-stripped, NFC and case-folded; a kept citation carries the canonical path) is dropped into `warnings`;
  a search hit alone does not ground one. `partial`: a citation was dropped, none was grounded, or nothing was read.
  `notfound`: the agent's own `found: false` ("Not in the vault."). `grounding` counts before the drop. Because the
  ledger is the table, a host restart mid-run loses nothing.
- **Per attempt.** A failed agent step is tried once more as a second step, `brain:retry`, with its own grant, `tools:retry`
  evidence step and ledger step: the answer is grounded on the notes the attempt that produced it read, so a note an
  attempt read before it died grounds nothing in the retry, and calls are not summed across attempts. The runtime's own
  step retry is not used for this (one grant and one ledger step would span both sessions). A cancel is not retried.
- **Re-ask.** A non-JSON answer gets one re-ask in the same session (`brain:reask`), then `invalid_output`.
- **As a child.** `createBrainWorkflows(deps)[0].workflow` is the `Workflow` a parent passes to
  `ctx.workflow('<step>', brain, [{ question }, …])`; a child that fails is `null`. The input and output above are the
  stable contract; a change to either bumps `BRAIN_VERSION`. `brain.test.ts` calls it from a fake parent.
- **Eval** (`docs/research/2026-10-29-wave7-ports.md` §brain): suite `brain`, plain cases in
  `$AGW_EVAL_DIR/brain/cases.jsonl` (`{id, input: {question}, reference: {notes: [1-2 vault paths], facts: [1-3]}}`).
  The scorer reports `valid`, `reference` (a reference note is cited; with two notes, either), `grounded` (cited and
  read; the rule needs 1 on every case) and `facts` (judged: one `decide` boolean per reference fact, regression and
  drift only); `pass` is valid, reference cited, nothing dropped. Cost is the harness's `costUsd` (median ≤ $0.01).
  The live run is `agw eval run brain --yes`, once, by the lead.

## Route

Model and rate: `packages/routes/src/table/brain.ts` (the only home of model ids). Source seat: agent-gateway
`GET /api/routing`, 2026-10-27, unless noted.

| Route | Source seat | Wire |
|-|-|-|
| `brain.agent` | none (new; Wave 7, the brain agent over the private vault; **no fallback**) | opencode |
