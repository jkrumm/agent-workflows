# @agent-workflows/testing

The fakes that more than one package's tests use, and the `bun test` preload. Private; every package lists it as a `devDependency` only, and no production `src/` imports it. It depends on the packages whose types it fakes (`capabilities`, `middleware`, `runtime`), so the workspace has dev-only cycles; bun and `tsc` resolve them because nothing here runs at import time.

| Subpath | What |
|-|-|
| `/gateway` | `startFakeGateway`: one fake gateway on a real socket for the chat, Messages, decision, speech, transcription, Gemini and Replicate paths (`attempt` is 0 on a route's first request; `on` restarts it), with the response builders (`sse`, `chatStream`, `messageResponse`, `geminiAudio`, `prepAnswer`, ...) |
| `/transports` | `fakeTransports`: in-memory `ChatPort` / `DecisionPort` with scripted replies |
| `/image-server` | `startFakeImageServer` and the `pngFixture` / `webpFixture` bytes |
| `/agent-host` | `FakeAgentHost`, `FakeSession`: the runtime's agent host driven by a script |
| `/opencode`, `/opencode-bin` | the fake OpenCode server, and the same as a spawnable `opencode` stand-in |
| `/platform` | `FakeUsage`, `testPlatform` (needs `AGW_TEST_PG_URL`) |

`src/preload.ts` (bunfig `[test] preload`) scales each test file's default timeout to the host load; `src/load-timeout.ts` is its logic.

## Stays in its package

Fakes only one package's tests use, or that sit on a package's unexported internals, stay next to them:

- `capabilities/src/web/fake.ts` (`fakeWeb`): built from the web capabilities' schemas.
- `audio/src/testing/index.ts` (`testDeps`, `testConfig`, `fakeMedia`, `recordingUsage`, clock and log): typed on the audio lanes' ports.
- `audio` podcast fakes (`fakeRoom`, `fakeBrain`, `fakeResearch`, `fakeHistory`) and `fakeAudiobookshelf`.
- `gateway/test/support.ts`, `limits/test/support.ts`, `eval/test/harness-support.ts`, `host/test/support.ts`, `cli/test/fake-host.ts`, and the remainder of `middleware/test/support.ts`.
- `runtime/test/support/pg.ts`: the Postgres helpers several packages share. Not moved: it is not on this change's list.
