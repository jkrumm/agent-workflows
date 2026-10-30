# Research self-improvement, round log (2026-10-30)

The coffee-machine task of the brain orchestrator is the eval load: five deep runs (round 1), three deep runs with
`--follow-up` (round 2), one YouTube probe (round 3, after the deploy). Evidence is read from `agw.runs` and
`agw.research_tool_calls`; the deploy that carries every change below is `091221a`.

## Baseline (25 past research runs, before this work)

- 6 to 8 fetches per run failed on average in deep runs; 114 of the failed `web_fetch` calls were 404s (a dead link is
  not a block), the rest 403 (8), 400 (5), "no text on the page" (11, script shells), timeouts (6), PDF (2).
- A failed fetch left the agent's prose as the only trace: the run record held a digest of the arguments, not the URL.
- No YouTube path, no Reddit path, no page behind a bot wall. Learnings were already wired into the prompt
  (`boot.ts` `agentPrompt` through `withLearnedFacts`); only three learnings of other agents existed.

## Round 1 (five deep runs, 252 sources, 1.52 USD) and round 2 (three deep runs, 0.73 USD)

| What the orchestrator saw | Cause in the records | Change |
|-|-|-|
| Reddit read through a third-party archive API and a reader proxy, 40 fetches in one run | direct Reddit access is 403 from the mini; no browser path | browser fallback in `web.fetch` (headed Chrome, solved profile) |
| otto.de answers HTTP 400 | a shop rejecting a plain client | 400 is a `rejected` block and gets the browser |
| idealo and geizhals blocked in the headless browser MCP | headless Chrome is flagged (`webdriver`) | the fallback drives the headed `research-chrome` profile, not the MCP |
| YouTube review summarised from secondary summaries | no transcript tool | `web_youtube` |
| Reports in English for three queries, German for two, same prompt | the language was never specified | prompt rule: the report is in the language of the question |
| Parallel runs contradict each other without a signal | each run sees only its own pages | not fixed here (see below) |
| 4 manual PDFs failed `unsupported content type application/pdf` | no PDF text path | not fixed here (see below) |

## What changed

- `web.fetch` names a refusal (`blocked (<reason>)`: `cloudflare-challenge`, `bot-protection`, `login-required`,
  `forbidden`, `rate-limited`, `legal-block`, `rejected`, `no-text`, `unsupported-type`, `needs-human`). The research
  run keeps URL and reason on the tool-call row (migration 0012) and returns `blocked[{url, reason}]` and a warning;
  a page read on another try is not listed. The caller opens the list in a browser and feeds the text back as `--context`.
- `web.fetch` falls back to the headed Chrome over a loopback DevTools endpoint (`AGW_BROWSER_CDP_URL`) before the paid
  Tavily Extract. Because the browser resolves names and follows redirects itself, every request it makes is paused and
  asked of the SSRF guard, the remote address of the main document is checked, WebSockets are disabled in the page and a
  4xx top-level answer is not page content. Review found each of these gaps in turn (two deep review passes); the tests
  cover them. `make research-chrome` installs the Chrome LaunchAgent.
- `web.youtube`: the ANDROID then IOS innertube player (caption URLs without a proof-of-origin token, measured
  2026-10-30 from the mini), json3 and timedtext XML, `[m:ss]` blocks of 30 seconds, metadata from the player answer and
  the watch page. Choice made from a `agw research` run on the options; yt-dlp is not installed and would add a runtime.
- Learnings 7 to 9 (agent `research`, active): German price sources and the test.de table pages, specifications from
  manufacturer manuals instead of shop texts, recompute figures that do not add up.

## Live evidence after the deploy

- `agw web fetch` of idealo, geizhals, a Reddit search and otto.de: all `via: browser`, 0.6 to 4.1 s, no Tavily credit.
- `agw web fetch http://127.0.0.1:…` is refused (`URL_REFUSED`).
- A quick research run on a video URL: one `web_youtube` call, no failed fetch, 0.003 USD, the first-minute lyrics quoted
  from the transcript with timestamps.
- Reddit `.json` stays blocked even in the solved Chrome ("blocked by network security"); thread and search HTML read.

## Still weak

- PDF manuals have no text path (`unsupported-type`); the orchestrator's spec matrix leans on them.
- Parallel runs cannot see each other: a `--context-runs <ids>` input (or a reconcile step) is the open design.
- The caption endpoint rots with YouTube's client versions; a retired client shows up as a named failure per client.
- A long transcript is returned raw (30,000 characters by default). A summarising pass for a caller that pays for its
  context (Claude Code) is open; for the research agent the raw text costs about 0.003 USD per 30 minutes of video.
