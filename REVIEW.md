---
# Read by the router (agw review route) and by the reviewer. Globs are repo-relative.
# none: plan, handoff and retro commits (docs/waves/**, concept.md alone) skip review coverage.
# A concept.md change that rides with code is still routed (and reviewed) by the code.
none:        [docs/waves/**, docs/concept.md, docs/spikes/**/data/**, bun.lock]
sensitive:   [packages/runtime/**, packages/middleware/**, packages/gateway/**, packages/limits/**,
              packages/cli/src/spec.ts, packages/host/src/door-tokens.ts,
              scripts/deploy.sh, scripts/launch*.sh, .env*.tpl, .github/**, "**/*.sql"]
nits: 3
---
# REVIEW.md — agent-workflows

What failure looks like here:

- **A contract drifts.** A workflow's typed in/out, the CLI generated from it, REVIEW_OUTPUT, the journal schema:
  a change on one side without the other, or a caller left on the old shape. No shims: the superseded path is deleted.
- **Money leaks or lies.** Every LLM call goes through the gateway; a call outside it, a usage row that reads an
  unpriced call as $0, a payer or pool picked wrongly, a cap that can be bypassed.
- **A run is lost or doubled.** Journal steps must be idempotent and resumable; a non-idempotent side effect inside a
  step, a missing idempotency key, a recovery path that re-runs writes.
- **A second copy.** A new fake, helper, client, retry loop or route table where one exists (`@agent-workflows/testing`,
  `packages/routes`, `packages/limits`). Search before adding.
  - one fake per port, in `@agent-workflows/testing`
- **The public repo leaks.** IPs, hostnames, internal URLs, tokens, account ids in code, docs, tests or fixtures.
- **A cap kills a working run.** No turn limits, no wall-clock ceilings on agent runs; only idle watchdogs and runaway
  caps far above normal (`rules/agent-limits.md`).
- **Docs lie.** AGENTS.md, a package README or `docs/concept.md` saying something the code no longer does; concept.md
  changes without a version note.

Skip: formatting, naming taste, lint-level remarks, test style. Evidence is always `file:line`.
