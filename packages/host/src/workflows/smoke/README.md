# smoke

`agw smoke ping`: the reference workflow (`packages/host/README.md` §Workflows). `make verify` and the live proof run it.

`agw smoke route <id>`: one live call on one route with a fixed prompt, the proof behind `make live-routes`
(`scripts/live-routes.sh`). A single-call route (`iu-openai`, `anthropic`) gets one completion on its own wire, with no
fallback, so the usage row is the route's own model; the prompt is eight fixed words. An `opencode` route gets one agent
step (agent `smoke`, `agents/smoke`, no tools) with the prompt "Reply with the single word ok.". A media route (`iu-gemini`,
`iu-replicate`, `iu-decision`, or any route with a `price`) is a 400: `make verify` or its capability covers it. The
input is a route id and nothing else, so an API caller spends a few tokens at most. `purpose` is `AGW_PURPOSE`, as for
`smoke ping`. Output: `{ route, model, wire, text }`.
