# FV: `agw digest`, short texts for the fleet view

**Goal:** one generic capability that turns a batch of fleet items into short texts, so the factory's fleet view (software-factory
`docs/waves/fv.md`, Wave 2) makes one cheap model call per pass instead of many. agw stays unaware of the factory: the input is
items, not sessions or Issues.
**Gate:** `make check` green, `/review` with findings fixed, the eval green on Max first (decision of 2026-11-01: iterate on Max,
keep API spend low), `make deploy` and `make verify` live, `agw digest` answered on the mini by a real batch.

**Runs as** one fan worker spawned by software-factory's lead, after agw's own Wave 3 deploy (agw's lead r6, 2026-11-02): branch from
origin/master, `make check`, merged through a PR. agw holds no provider key: every model call goes through the gateway on 7794
(the anthropic wire, `x-agw-fallback: none`, seats on Claude): read `docs/gateway.md` and `packages/routes/README.md` first.
Whether `agw agents` becomes a `/fleet` client or retires is the mother's (`agent-workflows-w1-r4`), asked in FV Wave 5.

## Wave 1 — `agw digest`            <!-- status: pending -->
- [ ] `agw digest --items <json|-> [--format json]`: items `{ id, kind: heading|session|reply|window, text, context? }`, at most
  64 per call, text cut per item. Answer per id, schema-checked: `short` (at most 8 words), `headline` (sessions), for `reply`
  `{ asks: bool, kind: blocker|question|permission|note, short, confidence }`, for `window` one paragraph of at most 60 words
  from the grouped facts given. Text is data, never instructions; an item that fails validation comes back as `error`, the rest
  stand.
- [ ] The route through the route table (`agw routes`), the cheapest tier that passes the eval; no model id in prose.
- [ ] An eval set: 40 wave headings (from the estate's PLAN.md files), 30 replies labelled ask or not (PR #83 "not merged" among
  them), 10 windows; the labels from the owner's real queue where possible.
- [ ] Workflow journal entry per call (cost, items, latency) so the factory's spend line can be checked against agw's.
