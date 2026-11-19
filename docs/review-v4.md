# Review v4

Moved verbatim from the root `AGENTS.md` `## Review flow`. The steps are there; this is the mechanism.

Review v4 (Max only, no API review spend, no LLM in agw) is the only review: host operations `agw review
prepare|submit|dispose|status|route|covered|cancel|stats` over a Postgres ledger (`packages/host/src/review/README.md`),
routed by `REVIEW.md`'s globs. `/review` (the dotfiles skill) runs `prepare` → the reviewer agent
(the live definition: dotfiles `agents/reviewer.md`, installed at `~/.claude/agents/reviewer.md`) on the printed seat → `submit` → `dispose` for every finding, rounds converging by
disposition. A repeat `prepare` (same thread, head tree, tier) returns the same prepared job and the prompt is also in
`<jobDir>/prompt.txt`; `a..b` diffs from the merge base when `a` is not an ancestor of `b`; a reply that leaves stat paths out is
accepted and the files are `unreviewed`. `covered` proves a commit range was reviewed; the factory's evidence reads it. Review v1 (the
LLM workflow with angle agents, OCR and react-doctor) was deleted in Wave 10.
