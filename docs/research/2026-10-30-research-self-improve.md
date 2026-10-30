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
| 4 manual PDFs failed `unsupported content type application/pdf` | no PDF text path | `web.fetch` reads PDFs in-process (`unpdf`, `[page N]`, up to 30 MB and 400 pages); a Jura manual reads in 0.4 s, free, where Tavily Extract had been paid for it |

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

## Rounds 1 to 3 in numbers (12 runs, about 3.4 USD)

| | Round 1 (5 deep) | Round 2 (3 deep, follow-ups) | Round 3 (3 deep, after `091221a`) |
|-|-|-|-|
| Cost | 1.52 | 0.73 | 0.95 |
| YouTube videos read | 0 (secondary summaries) | 0 | 10, with `[m:ss]` citations |
| Reddit | a third-party archive API, 40 fetches in one run | same | 24 threads directly, through the browser |
| otto.de | HTTP 400, lost | lost | read (browser) |
| Report language | mixed (3 English, 2 German on one prompt) | English only with an explicit hint | English without a hint |
| Lost pages | in the agent's prose only | same | `blocked[]` with URL and reason |

The `blocked` column found its first real cases in round 3: the Jura press PDF (`unsupported-type`, which Tavily Extract
could not read either) and two archive.org availability calls (`rate-limited`).

## Second pass (same day)

- PDF text in `web.fetch` (`unpdf`, `[page N]`, 30 MB, 400 pages): the press PDF the agent lost reads in 0.4 s; manuals
  that Tavily Extract had read for a credit are now direct and free.
- Fetch cache, 6 hours per process, with `cached` and `fetchedAt` in the output and a `fresh` bypass: round 3's runs
  y2 and y3 read the same idealo and kaffeemacher pages twice.
- `--context-runs`: parallel runs hand their reports and sources to a reconciling run.
- Archive snapshots: the prompt teaches `web.archive.org/web/<YYYYMMDD>/<url>` (verified live: an idealo page from May 2025
  reads in 2 s) instead of the rate-limited availability API.
- `research-chrome` is a supervisor loop: an adopted Chrome made the first version exit 0 and watch nothing.
- A long transcript is summarised by composition, not by a new flag: `agw llm summarize` already takes stdin
  (`agw web youtube <url> --format json | jq -r .transcript | agw llm summarize`); the research agent reads it raw.
- Claude Code sessions are pointed at `agw web fetch` and `agw web youtube` by a paragraph in `rules/research-first.md`.

## Still weak

- A scanned PDF has no text layer and stays a `no-text` block (no OCR).
- `--context-runs` carries the reports as text; it does not yet re-verify a contradiction by itself, the agent does.
- The browser lane is one Chrome and three tabs for every run; a challenge that needs a person (Reddit's) is solved once per profile on screen share.
- The caption endpoint rots with YouTube's client versions; a retired client shows up as a named failure per client.
- A long transcript is returned raw (30,000 characters by default). A caller that pays for its
  context pipes it: `agw web youtube <url> --format json | jq -r .transcript | agw llm summarize`; for the research agent the raw text costs about 0.003 USD per 30 minutes of video.
