# Capabilities with little production use: verdicts

Audit of 2026-11-16 over the 20 days of runs before it. Counts are root runs of the operation; a capability that only a
workflow calls in process has none by design. A caller is a file that names the verb or operation id: searched with `rg`
across `~/SourceRoot` (agent-workflows, dotfiles, hermes-agent, software-factory, argo, usage-tracker, modelpick,
email-gateway) and Hermes' skills and config.

| Capability | Runs | Callers found | Verdict |
|-|-|-|-|
| `llm.summarize` | 2 | dotfiles `rules/research-first.md` and `hooks/web-fetch-route.ts` tell agents to pipe a long YouTube transcript into `agw llm summarize` | keep: it is the instructed path for long transcripts |
| `llm.classify` | 5 | none. email-gateway's `llm.classify` span is its own telemetry; software-factory only names it in a 2026-11-01 research note and built `factory.classify` instead; `agw decide` covers calibrated verdicts | **deleted** (`issue_1671`): the capability, route and CLI verb are gone; the stand-in tests moved to `cheap.title` |
| `overview.classify` | 2 | `packages/host/src/workflows/overview` (`agw overview`, behind `agw agents`); argo's plan lists the overview push | keep: only that workflow calls it; the verb goes with the workflow |
| `llm.title` | 199, all `verify` and `smoke` | `make verify` calls `agw llm title`; the `smoke` workflow calls it | keep: the verify probe is its job |
| `eval.label` | 0 | `packages/host/src/workflows/eval-mine` calls it in process, once per seat (`agw eval mine review`); no root run exists by design (`eval-mine/history.ts`). The nightly miner is retired, the manual command stays | keep |
| `prose.critique` | 0 | the `prose` and `prose-polish` workflows call it as a step; hermes-agent `scripts/prose.py` runs `agw prose-polish`; `narrative` runs the same steps | keep |
| `shop.find`, `shop.item` | 0 | none outside this repo; no skill, Hermes script or cron names `agw shop`. It is the owner's interactive tool (`docs/shop.md`) and shares fetch, parse and cache with `shop.search` | keep, no automated use: the three verbs are one tool, so a removal is one owner decision for all three, not a cut of two. Revisit with the next audit |
| `learnings.activate` | 0 | `agw learnings activate` is the manual override of `agw learnings tidy`, which activates facts seen in two weeks by itself; the retrospective loop that proposes them is live | keep |
| `narrative-polish` | 0 | internal child run of `narrative` (`NARRATIVE_POLISH_ID`); hermes-agent `scripts/project-narratives.py` runs `agw narrative` for the daily vault pages | keep |
| `podcast-publish` | 0 | dotfiles `skills/podcast/SKILL.md` and hermes-agent `skills/podcast/SKILL.md` and `AGENTS.md` | keep: the repeat of a failed upload |

One deletion followed from this table (`llm.classify`, done in `issue_1671`). Nothing else lacks both a caller and a plan.
