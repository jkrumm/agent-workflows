# Lead handoff — Wave 7 (Usage view v7, Argo): CLOSE-OUT of steps 1–2

Lead spawned by mother `agent-workflows-w1-r4`, 2026-11-02 ~16:30 → ~18:20 local. No workers, no fan, no branches: the
spec is editorial work and stayed in this session. Wave 6's close-out is in git history (`15a9d91`).

stopped: owner sign-off of spec v7

## Deliverable

| What | Where |
|-|-|
| Spec v7 | argo `docs/design/usage-tracking.md`, commit `84053e84` (pushed to `master`; argo is direct-to-master, `make check` green, 565 tests) |
| Mock, source | argo `docs/design/usage-v7/flow.html` (`?scheme=dark`, `?w=390`) on `usage-v7/tokens.css` (basalt-ui 2.27.2 `tokens:css`) |
| Mock, renders | argo `docs/design/usage-v7/flow-light.png`, `flow-dark.png` (1440), `flow-mobile-light.png`, `flow-mobile-dark.png` (390) |

The spec names 12 questions (headline H, supply S1–S4, router R1–R3, demand D1–D3, Athena A1), the view and endpoint for
each, a pace model, eight data gaps with what closes each, the v6 → v7 deletions and pass criteria. Prose ran through
`/prose` (`agw prose --medium docs`, gate kept the rewrite). Every figure comes from read-only queries on `usage.*` (role
`argo`), the gateway's `/health` and Argo's live `/usage/credits/pools`, as of 2026-11-02 16:00 UTC.

## What the data says (for the mother)

- **The headline flips: over pace, not under.** Credit left iu $88.43 + me $93.09; spending it all by expiry needs
  $8.65/d; production on credit ran at $85/d on the gateway's first day (98 % `review`). At that rate iu is dry
  ~3 Nov, me ~4 Nov, then 16 days of Claude seats falling back to GPT on the IU personal key ($577.57 of $500) until iu
  renews on 21 Nov. The rate is from 16 hours, so the spec marks it thin.
- **Argo's v6 Credits tab is wrong today:** iu credit left $100.39 vs $88.43 (cycle-wide max of meter and lagging
  report), me projected unspent $69 vs ≈ $0 (pools projected alone; the router drains iu first).
- **IU since the cutover: $3.26, all by design** (non-Claude seats and eval arms); no credit fallback, no refusal.
- **agw still double-writes** `source=agent-workflows` rows, billed `api_key personal`, for OpenCode agent steps the
  gateway already recorded: 382 rows, $5.01 since 08:10 UTC, $4.94 of it in runs with gateway rows (the Opus eval arms on
  `me` read as IU personal spend). Spec Gap 6; the fix belongs in agent-workflows.

## Open questions for the owner

Also in the spec's §For the sign-off.

1. **Verdict direction.** Judge both directions, with "dry before renewal" the louder state? Recommendation: yes; today's
   data shows the dry case.
2. **Two tabs.** Flow and Explore replace Overview, Claude Max, IU API and Credits; Compared and the picker's Routing
   move into the subscription node's detail. Recommendation: yes.
3. **agw changes in the build.** Gaps 4–6 (route-fallback marker, origin header, no double rows) join Wave 7's build in
   agent-workflows. Recommendation: yes; R2 and D2 cannot be answered without them.
4. **Spill units.** Days and Claude list dollars, labelled as such, never as IU cost. Recommendation: yes.
5. **Pacing production.** The page shows the overflow and changes no routing; whether the gateway should pace
   production (a cheaper tier when over pace) is a separate decision. Recommendation: decide after 7 days of data, and
   claim me2 now (+$100 a cycle, ~1 day at today's rate).

## Left behind

- Step 3 (build v7) not started, by the plan's stop.
- The double-write (Gap 6) is live and inflates the IU personal figures on today's page; untouched (agw code, outside
  this step's scope).
- No `basalt-design-reviewer` pass on the mocks: they are static HTML, not the app; the build's shot rounds own that.
- The mocks' fonts load from argo's `apps/dashboard/node_modules` when opened inside the checkout; elsewhere system
  fallbacks.
