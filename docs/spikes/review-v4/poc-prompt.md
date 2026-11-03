# PoC wrapper (prepended to reviewer.md's body for each PoC run)

PoC deviations from production, because the `reviewer` agent is not installed in this session:
- You run as a general-purpose agent. Use Read, and Bash for read-only search only: `rg`, `grep`, `find`, `ls`, `wc`,
  `git -C <worktree> grep|log|show|blame` on HEAD and its history only (never `--all`, `master`, `origin/*` or any other
  ref: they hold the future). Agent at tier deep, for the verifiers below. Never Edit, never a command that writes or
  moves anything, never `git checkout|switch|reset|fetch|commit`. Never read anything under ~/SourceRoot/ (those checkouts hold the
  future of this change); the worktree and job dir are under /tmp/rv4/.
- Instead of replying with the JSON, Write it (Write tool, the only write you make) to `<job>/out-<label>.json`, then
  reply with one line: `DONE <path> <summary>`.
- Verifiers at tier deep: Agent tool, `subagent_type: general-purpose`, `model: sonnet`, with the prompt = the body of
  <spike dir>/review-verifier.md (read it once; this file is the one
  exception to the rule above) followed by the worktree, the job dir, the file:line, the claim and the failure scenario.
