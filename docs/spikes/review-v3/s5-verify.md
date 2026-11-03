# S5 — The `reviewer` procedure end to end, and the verify vote

Added after a fresh-context critique of the first design draft pointed out that S1-S4 never ran the verify stage or a
subagent that spawns subagents, which the in-session path depends on.

**Verdict:** the in-session shape works. A Sonnet subagent ran the native skill (a fork) and spawned one verifier
subagent per candidate, all on Sonnet, at spawn depth ≤ 2, from an Opus caller. The verify vote acts as the severity gate
it is meant to be: on #118 it kept the one known-real finding and demoted the four minor ones, which matches the
independent judge of S2 exactly. It costs ~$0.10 API-equivalent per verified candidate. **The finder is not
deterministic:** a second `high` run on #119 missed the real bug the first one found.

Procedure: `data/reviewer-draft.md` (find with the native skill, group, one context-isolated verifier per group, JSON
out). Worktrees on a branch whose upstream is the PR base (S1 finding 4). Run from the lead's Opus session on `me2`,
2026-11-03 ~01:35 CET.

| Run | Agents (depth) | Wall | API-eq | Result |
|-|-|-|-|-|
| End to end, PR #119, `high` | reviewer (1), skill fork (2), 4 verifiers (2) | 73 s | $0.50 | 4 candidates, all `real: false` → **clean**. The finder **missed** the real bug that j1 (`high`, same PR) and j8 (`xhigh`) found |
| Verify only, PR #118, the 5 `important` of j4 | caller (1), 5 verifiers (2) | 51 s | $0.59 | `scope.ts:552` **kept, real** (the known gap); the other 4 → `nit`, each with a cited line and the reason (deliberate contract, monotonic reader, speculative path) |

## What it changes in the design

- The verify vote is cheap enough to always run: ~$0.10 per candidate, so ~$0.3-0.6 on top of a `high` find.
- One finder run at `high` misses things another run catches (#119: 1 of 2 `high` runs, 1 of 1 `xhigh`). Wave 9
  measures recall with repeats per case, and `deep` (`xhigh`) is the level for risky changes, not `high` twice.
- `CLAUDE_CODE_SUBAGENT_MODEL` is `sonnet` in the fleet's sessions, so the pin and the global setting agree; the
  `reviewer` agent still names its model so an owner session without that variable behaves the same.
- The verifier needs only Read, Grep, Glob (it used `cd <worktree> &&` through Bash in this draft; the agent
  definition passes absolute paths instead, so Bash can go).
