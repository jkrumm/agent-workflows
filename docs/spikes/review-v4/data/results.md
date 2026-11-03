# Review v4 PoC results (2026-11-03)

Labels come from later history (the fixing commit or PR is the evidence). **hit** = the labelled defect;
**class** = the same bug class at the same function, another instance; **partial** = part of the labelled defect.
Findings are `important` unless marked nit; votes are the three-verifier vote (deep only). v1 = the first prod
`agw review` run on the PR (API credit, the journal).

| PR | Label (evidence) | v1 (API) | light | standard | standard v2 | deep v1 | deep v2 (Sonnet high) | deep (Opus high, v2) |
|-|-|-|-|-|-|-|-|-|
| agent-workflows #119 | intent miss: the cost history reads `cap.eval.label` runs production never writes (#120, `9c34697`) | clean (light, $0.05): miss | miss | miss | miss (traced the name to the test, not production) | miss (nit: the test rebuilds the wiring) | **hit** 3/3, + the eval README left stale | **hit** 3/3, + the same README |
| agent-workflows #90 | duplication: a second fake gateway and a hand-written gateway wire beside capabilities' (#132, `9bd4c66`) | 5 blocking (launcher env, double count, purpose, retry, effort; env and double count fixed in #95): miss on the label | 1 doc nit | partial: two dup nits | partial: two dup nits | **partial**: header helper copied verbatim 3/3 | **partial**: header copy 3/3 + a README that lies about the prep wire 3/3 | **partial**: header copy + README lie + launcher env, 3/3 each |
| agent-workflows #92 | money bug: the gateway-recorded model set misses IU's provider-prefixed echoes, spend counted twice (#97, `3e6026e`) | 6 blocking incl. the set built from defaults only (`routes:113`): **class** | 1 doc | audio's direct IU calls skipped (real, v1 had it) | **class**: Sonar passes the gateway outside the set | audio's direct calls, twice 3/3 | **hit** as nit "unverified" (the echoed model label) + **class** (Sonar) 3/3 + audio 3/3 | **class** (Sonar, `routes:111`) + audio twice, 3/3 each |
| agent-workflows #64 | clean (no later fix to its lines) | none (before the journal) | README documents a `500 ROUTE_OVERRIDE_INVALID` nothing produces | same + an unused import nit | same | same 3/3 | not run | not run |
| dotfiles #51 | drift: the drain admission copied into the local gate, which refused where the factory holds (#52, `ec03dbc`) | 3 blocking (fallback paths, unbounded timeout, stale close): miss | clean | 2 nits | 1 **wrong** important (`.status` vs `state`: the factory did answer `status`) | stale AGENTS.md and skills 3/3 | env overrides dropped on the factory path 3/3, stale docs 3/3; nits: spawn key from herdr only (unverified), `wave-gate.py:56` | spawn key reuse 3/3 (**later fixed**, `6c1815f`), stale skills 3/3, wave label not passed 3/3 |
| dotfiles #50 | shell bug: `${t:+$t 2}` word-splits in bash, not over ssh in the mini's zsh (`0e0ce13`) | none (before the journal) | miss | miss | **hit** (REVIEW.md shell line, tuned) | **hit** 3/3 (REVIEW.md without the line) | not run | not run |
| dotfiles #58 | clean | 0 blocking | clean | 1 important (renamed Haiku id on the MacBook fallback, unchecked) | 2 nits (the same id, a stale comment) | **clean**: the id demoted 1/3 by the vote, 3 nits | not run | not run |

## Cost and wall (API-equivalent from the transcripts, nested verifiers included)

| Arm | n | Mean | Range | Wall mean |
|-|-|-|-|-|
| light (Sonnet low) | 7 | $0.09 | 0.05-0.13 | 18 s |
| standard (Sonnet medium) | 7 | $0.19 | 0.10-0.32 | 35 s |
| standard v2 | 7 | $0.21 | 0.11-0.35 | 48 s |
| deep v1 (Sonnet high, vote) | 7 | $0.65 | 0.16-1.19 | 119 s |
| deep v2 (Sonnet high, vote) | 4 | $1.33 | 0.76-2.04 | 185 s |
| deep (Opus high, vote) | 4 | $2.51 | 1.21-3.33 | 286 s |
| v1 on API credit, last 3 days (all repos) | 366 | standard $0.49, deep $1.10, router default $0.61 | | |

## Reading

- **Light and standard** find doc drift and leftovers cheaply, and the false alarm on dotfiles #58 shows why `important` needs
  the vote. They do not find logic bugs that need tracing across files: fine for small and docs-only changes, which is
  what the router gives them.
- **Deep v2 on Sonnet** matches Opus on #119, #90 and #92 (it alone named #92's exact defect, under-tagged as a nit;
  prompt v2.1 now forbids parking an in-repo claim as unverified). Opus is ahead on dotfiles #51 (the spawn-key reuse, later
  fixed). Sonnet costs about half.
- **No arm** found the labelled drift on dotfiles #51 (the gate duplicating the factory's drain admission) or #90's
  duplicated fake gateway (a test-support copy). Both need knowledge of a second system's design; `REVIEW.md` lines
  ("admission belongs to the factory", "one fake per port") are the lever, not a bigger model.
- **v1** ran on four of the labelled-defect PRs (#119, #90, #92, dotfiles #51) and reached one by class (#92). Its findings
  are usually acted on (`v1-dispositions.jsonl`: 56 of 80 blocking fixed, 3 wrong, 21 ignored); the wrong ones all
  lacked context (a stacked PR, a documented design, a deliberate trade-off), which v4's intent and prior files carry.
