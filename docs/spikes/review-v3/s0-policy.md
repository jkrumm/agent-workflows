# S0 — Policy: what a subscription review may run on

**Verdict:** review on the subscriptions runs only as interactive Claude Code sessions (the unmodified binary, the
owner's own logins, the `cli` entrypoint) and their native subagents. `claude -p`, the Agent SDK and every
`CLAUDE_CODE_ENTRYPOINT` relabel stay out. The relabel is the one workaround people use, and it is unsound.

## Sources read (2026-11-03)

| Source | What it says |
|-|-|
| anthropics/claude-code#97074 (opened 2026-09-25, open, no assignee) | Headless `claude -p` (`entrypoint: sdk-cli`) moves the 5-hour meter ~1.8x faster than the interactive TUI (`cli`) for the same tokens. Replications 1.3x to 3.0x, all user-run, one to three accounts each; weekly limit not shown to differ. No comment by Anthropic staff in the thread (every comment `author_association: NONE`, 2026-11-03) |
| Comment 6585881480 (2026-11-02, a user) | "not solved yet"; points at a post on X by the T3 Code author; guesses the 5-hour increase on all plans was not applied to the SDK / `claude -p` |
| pingdotgg/t3code#25597 (2026-10-26, **closed unmerged** 2026-10-31) | Sets `CLAUDE_CODE_ENTRYPOINT=t3-code` for the spawned `claude -p`; measured ~1.83x more work per 1 % of the 5-hour window; an arbitrary label behaves the same, so the gain is "not `sdk-*`", not the string. A maintainer closed it: changing the default attribution "to change quota accounting" needs prior approval; users can still set the variable themselves |
| Research `r2` (`research/r2.json`, 45 citations, all grounded) | Help center (2026-10-07, 2026-06-15): signed in with a plan, `claude -p` and the SDK draw from plan limits; monthly API credit covers them only with a linked Console org's API key. Claude Code legal page: plan OAuth is for "ordinary use of Claude Code and other native Anthropic applications"; developers "should use API key authentication". **Usage Policy effective 2026-11-12** adds: do not "resell, proxy, or otherwise provide access to Claude through unauthorized means, including services that route requests through consumer subscriptions or misrepresent the product or client being used". `CLAUDE_CODE_ENTRYPOINT` is undocumented. One Anthropic-side statement on faster usage (an employee's post, 2026-10-28) names heavy sessions (xhigh effort, Workflows, Agent Teams, long SDK jobs), not the entrypoint |

## Judgement of the workarounds

| Workaround | Sound? | Why |
|-|-|-|
| `CLAUDE_CODE_ENTRYPOINT=<custom>` on `claude -p` / SDK | **No** | It reports a client that is not the one running: the exact act the 2026-11-12 Usage Policy clause names ("misrepresent the product or client being used"). Undocumented, measured by users only, removable server-side without notice. The upstream project declined to make it a default. And it keeps `claude -p`, which the owner's constraint bans regardless |
| Same variable in `settings.json` env for interactive sessions | **No** | Interactive sessions are already `cli`; relabelling them gains nothing and is the same misrepresentation |
| Drive the TUI in a pseudo-terminal (what the herdr-core terminals and the factory already do) | **Yes, with the one caveat below** | It *is* the interactive client: unmodified binary, the owner's own login, `entrypoint: cli` in every transcript of these spikes (main thread and forked-skill subagents, `data/`). No credential leaves the keychain, nothing is proxied |
| Channels / cross-session messaging socket into a running session | Sound, not needed now | Documented Anthropic surfaces (Channels: research preview; the messaging socket: documented, same machine). Kept as the fallback transport if typed notes ever break (S1) |
| API key of a linked Console org (`claude -p` with a key) | Sound, but API credit | Monthly credit, Commercial Terms. This is today's `agw review` money, the fallback in `docs/review-v3.md`, not the subscription path |

**Caveat (owner's to hold, not new):** the consumer terms' §3 bars "automated or non-human" access except by API key
or explicit permission, and the legal page's limits "assume ordinary, individual usage". Unattended interactive sessions
for the owner's own work are what every `rd wave` and factory spawn already is; a review desk adds no new category. It
adds volume, so v3 keeps review a small share of the fleet's quota (S2) and never parallelises past two sessions.
