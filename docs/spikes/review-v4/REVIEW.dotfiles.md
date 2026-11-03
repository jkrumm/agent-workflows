---
none:        [brain/**, reference/**, "**/*.lock", sc-note.md]
sensitive:   [hooks/**, config/global.CLAUDE.md, config/*settings*.json, rules/security.md, rules/attribution.md,
              scripts/*secret*, scripts/git-credential*, "**/*.plist", launchd/**, tailnet-sshd/**, caddy/**,
              launcher/**]
nits: 3
---
# REVIEW.md — dotfiles

What failure looks like here:

- **A machine stops booting or a job stops running.** A LaunchAgent, plist, launcher or Makefile target that breaks on
  the mini (headless, no Touch ID) or the MacBook, or only works on one of them when both run it.
- **A script meets another shell or host.** Code that runs locally in bash and over `ssh` in the mini's zsh, or on
  macOS bash 3.2: word splitting, arrays, `mapfile`, GNU-only flags.
- **A secret path hangs or leaks.** `op read`/`op run` on the mini, a secret in a tracked file, a credential helper
  that exits 0 with nothing.
- **A guard opens.** A hook that fails open, a deny rule loosened, `ask` rules in a checked-in settings file.
- **Instructions contradict.** A global CLAUDE.md, rule, skill or AGENTS.md line that says the opposite of another, or
  of the code; a model id written in prose (they live in the route table only).
- **A second copy.** A new script, helper or skill that repeats one that exists (search `scripts/`, `skills/`).
- **`homelab-private` leaks.** Any reference to its services or hosts.

Skip: formatting, wording taste, lint-level remarks. Evidence is always `file:line`.
