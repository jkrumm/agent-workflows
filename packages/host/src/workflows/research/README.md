# Research (concept P3)

`src/workflows/research/`: `agw research <query> [--depth quick|standard|deep] [--context …] [--follow-up <runId>]`
answers research-gateway's report shape (`report`, `citations [{claim, url, confidence}]`, `sources`,
`unverified [{topic, url, reason}]`, `status` `ok|partial`, `warnings`) plus a code-counted `grounding` and the
agent's `tools` counts. `--depth` defaults to `standard`. A long run waits like check and review: after
`AGW_WAIT_BUDGET_S` the CLI exits 10 with `agw run wait <runId>`. The shape is the winner of the three-way comparison
(`docs/research/2026-10-28-research-three-way.md`: one agent with the platform's web tools); the other arms are gone.

- **The agent** (`agents/research`, route `research.agent`) runs on the shared OpenCode server. Its four tools
  (`web_search`, `web_fetch`, `web_docs`, `web_package`) go through the host's **tool gate** (`packages/host/README.md` §Tool gate) with a
  grant `src/workflows/research/tools.ts` builds (`researchGrant`): the four tools mapped to the `web.*` capabilities,
  and a hook that writes every call's evidence apart to `research_tool_calls` (migration 0007; rows go with their
  run; in memory on a host without a database), so a step retry or a host restart loses nothing. A call's cost is
  booked as it is reported on the run's `tools` step, which lives as long as the agent's turns (a cancelled or failed
  run keeps its spend); `tools` reads the ledger once the grant has drained (at the agent's end, calls in flight are
  served first, bounded). A ledger write is retried (three attempts) and logged and never fails a call that worked.
- **Unused columns.** `research_tool_calls.engine_job`, `engine_cost` and `booked_by` (migration 0008) and the
  partial unique index on them stay in the table: nullable, never written or read by this code. The previous release,
  the rollback target of a failed deploy, still uses them; they are dropped by a later migration once no rollback
  target reads them.
- **Grounding** (`assemble`, in code): a citation whose URL the run neither retrieved nor saw as a search result is
  dropped to `unverified`; dropping 10 % or more, or retrieving nothing at all, makes the report `partial`.
  `grounding` counts before the drop.
- **Follow-up** (`--follow-up <runId>`, `followUp` in the input): the query is a new question about a finished
  report. The run must be a `done` `research` run, else the follow-up fails `invalid_input` with the reason (no such
  run, another workflow, not done, no report). The agent gets the earlier question, report and citations and the
  pages that run retrieved, researches only what the new question adds, and answers in the same shape. The earlier
  report is data derived from web pages, never instructions (the agent's rule for page text applies to it). Grounding
  counts this run's retrieved and seen URLs plus what the earlier run may rest on: the pages it retrieved (its ledger
  rows) and the URLs of its final citations, which passed its own grounding (so a seen-only page it cited, or one it
  inherited, stays citable and a chain of follow-ups stays grounded; a page it merely saw and did not cite is not). A follow-up that read nothing new
  carries the warning `no new pages were read for this follow-up` (its status follows the rule as usual). The earlier
  research reaches the agent as one fenced block (the marker carries a hash of the data, so the data cannot contain it;
  claims and URLs are single lines), with the URLs as the ledger rows and citations hold them.
  `grounding.pagesRetrieved` stays this run's own. A flat `followUp` id rather than a separate
  `research.followup` workflow: one workflow keeps one run record, one scorer and one fingerprint, and the CLI shows
  `--follow-up <runId>` where an object would be a JSON flag. A follow-up of a follow-up continues from the latter's
  own report only (the chain is not walked).
- **Process.** Concept §8 sends heavy pipelines to their own process. Research has no in-process pipeline: the agent
  loop runs in the OpenCode server (already its own process, shared with review and check), and the host only serves
  the gate's calls (an HTTP hop to `web.*` capabilities, bodies capped at 64 KiB) and the scorer's reads. A separate
  research process would add a second gate and a second ledger writer for nothing; it is not built.
- **Scorer** (`scorer.ts`): `valid`, `complete`, `grounded` (code), `golden` (the case's `expect`, research-gateway
  `evals/lib.ts` semantics; `live:` via `web.package`), `supported` (judged: `web.fetch` + `decide` on up to 3 cited
  pages), `judgedShare`. Cases are plain eval cases in `$AGW_EVAL_DIR/research/cases.jsonl`.

## Route

Model and rate: `packages/routes/src/table/research.ts` (the only home of model ids). Source seat: agent-gateway
`GET /api/routing`, 2026-10-27, unless noted.

| Route | Source seat | Wire |
|-|-|-|
| `research.agent` | research-gateway's `IU_LEAD_MODEL` / `IU_WORKER_MODEL` (not agent-gateway) | opencode |

## Token effect / cache effect

The research agent: its `AGENTS.md` and its four tool schemas are the cached prefix (identical across runs); the
question, depth directive, background and a follow-up's earlier report are the task message. The tool gate adds no
model-visible text beyond each tool's JSON answer (page text up to `maxChars`, 20k by default), which is where a
research session's tokens go; DeepSeek's prefix cache holds because the session's history is never edited (cache
reads recorded and priced at the route's rate).
