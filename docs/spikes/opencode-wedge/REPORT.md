# OpenCode 2.0.32 prompt wedge: isolated

Spike of Wave 2. Input for Wave 3 (the OpenCode host). Investigation only; no product code.

## Verdict

**Cause: OpenCode's file-watcher boot.** On the first request for a directory ("location"), the server starts one `entries` watcher per ancestor directory of the cwd, from `/` down, one after the other (`backend=node`). Until the last one is up (`location services booted` in its log), the server answers nothing that needs the location, `GET /api/info` included. The prompt is not hung. It is queued behind the boot.

- **Boot time on this host: 2.5 s to 109 s for the same configuration.** All 54 watchers-on sweep trials replied in the end (longest prompt 126 s); none stayed blocked for good. The server was mostly idle while it waited (mean CPU 1 to 63 % per trial, median 2 %). Time rose with the number of servers booting at once (31 to 55 s one at a time, 31 to 109 s three at a time, medians 38 s and 69 s) and varied with host load (load average 5 to 10).
- **S2's "wedged 6/6" was a 45 s ceiling against a 30 to 109 s boot.** The dotfiles spike's `prompt: 200` was a boot that fit inside its 30 s curl ceiling. Replaying that script unmodified today gives `prompt: 200` 7 of 10 times and `000` 3 of 10, depending on the boot duration of the moment.
- **"Ignores SIGTERM" is a slow SIGTERM.** With watchers on, 52 of 54 sweep servers had not exited after 6 s; the two that did took 4 s and 71 s, and `recover.ts` saw 8 to 36 s over four runs (S2 waited 8 s). With watchers off it exits in 31 to 90 ms (one 3.3 s outlier in 54 trials).

**Minimal recipe that prompts reliably: `OPENCODE_DISABLE_FILEWATCHER=1` in the server's env.** Both documented spellings work alone (`OPENCODE_DISABLE_FILEWATCHER`, `OPENCODE_FILEWATCHER_DISABLE`). Result with that one variable, same spawn as S2:

|metric|watchers on|`OPENCODE_DISABLE_FILEWATCHER=1`|
|-|-|-|
|boot, `location services booted`|median 38 s (30 to 55 s, one at a time)|median 38 ms (21 to 184 ms, 54 trials)|
|prompt round trip|median 73 s in the 54-trial sweep|median 0.46 s (0.18 to 1.3 s, 54 trials)|
|SIGTERM exit|not exited after 6 s in 52/54; 8 to 36 s in `recover.ts`|31 to 90 ms (one 3.3 s outlier)|
|sweep trials that prompted|54/54 (every one slow)|54/54|

It costs nothing that I could find: AGENTS.md in the cwd still reaches the model (`scripts/agents-md-check.ts`: a rule "reply PINEAPPLE" was obeyed with watchers on and off). Not tested: file-change events on the server's event stream, which are what the watcher feeds.

**Detection.** `GET /api/info` with a 2 s timeout. During the stall it times out repeatedly (`0 s: 200, 2 s: timeout, 6 s: timeout, 10 s: timeout, 14 s: timeout` in one run; it recovered to 200 by 10 s in another). Right after spawn it still answers 200. The stall starts at the first session create or prompt for a directory. Log line `location services booted ... durationMs=` ends it. With the env var set none of this is needed (boot 30 ms), but a host should still run an idle watchdog: a model call can also hang.

**Recovery.**
- SIGKILL works every time: 52 of 52 stuck servers in the sweep, 15 to 46 ms.
- SIGTERM first, SIGKILL after a few seconds. Do not treat a slow SIGTERM as proof of a dead server.
- **A session survives a server restart.** The store is the sqlite DB under `XDG_DATA_HOME`. Tested twice (`scripts/recover.ts`):
  - SIGKILL during the boot stall: the session is listed after restart on the same data dir and takes a new prompt (0 messages, then 3).
  - SIGKILL after a finished turn: 3 messages before and after restart, a second prompt answers (6 messages).
  - Re-attach is by session id against a new server; there is no in-flight turn to resume.

## What changed between the spikes (step 1 to 3)

**Step 1, dotfiles script replay** (`scripts/dotfiles-opencode_probe.sh` is an unmodified copy; `evidence/dotfiles-replay.txt` is the wrapper run, `evidence/reproduce.out.txt` the final `reproduce.sh`). Installed build: `opencode v2.0.32`, the pinned `opencode-bin/2.0.32` (the installed `opencode` is agent-gateway's shim to that build; its 2.0.29 sits next to it and was not used). Its own ClickHouse read-back fails at the end (ClickStack is not running) and is ignored.

|variant|prompted|prompt `000` (30 s curl ceiling)|
|-|-|-|
|verbatim, first ad hoc run|0/1|1/1|
|verbatim, replay wrapper (3 runs)|1/3|2/3|
|verbatim, inside three `reproduce.sh` runs|6/6|0|
|one line added: `OPENCODE_DISABLE_FILEWATCHER=1` in its `env -i` list (wrapper 3/3, three `reproduce.sh` runs 6/6, one more 1/1)|10/10|0|

**Step 2, S2 replay.** I did not run `probe-opencode.ts` itself: it needs ClickStack on `:4319`, which is down, and the S2 telemetry package. `scripts/trial.ts` reproduces its spawn line for line: explicit env (PATH, HOME, TMPDIR, LANG, XDG roots, password, config JSON, IU vars, `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_RESOURCE_ATTRIBUTES`), cwd = scratch HOME under `$TMPDIR`, `--hostname localhost`, random port, stdout/stderr to a file, `fetch` for session create, prompt and wait. The only change is the OTLP target (a local sink on 127.0.0.1 that answers 200; the dead-port cell below covers a down collector). Baseline cell of the watchers-on sweep: 3/3 took longer than 45 s (S2's guard), 3/3 eventually replied.

**Step 3, bisect.** Each cell: 3 fresh servers, fresh scratch HOME, one prompt (`Reply with the single word OK.`, `deepseek-v4.1-flash` on the IU chat route), 120 s ceiling, one variable flipped from the baseline. Two baselines: the S2 spawn (watchers on) and the same with `OPENCODE_DISABLE_FILEWATCHER=1`. Full tables: `evidence/bisect-wedge.table.md`, `evidence/bisect-fixed.table.md`; raw rows `*.jsonl`.

"Blocked" is the count of prompts that took more than 45 s. Medians in ms.

|variable flipped|watchers on: prompted|blocked >45 s|median prompt|median boot|watchers off: prompted|median prompt|
|-|-|-|-|-|-|-|
|baseline (S2 spawn)|3/3|3/3|83459|77544|3/3|464|
|env: inherit parent env (`env=parent`)|3/3|3/3|79389|73198|3/3|205|
|cwd: repo with ancestor AGENTS.md|3/3|3/3|91822|76485|3/3|614|
|cwd: empty dir, outside any repo|3/3|3/3|86629|80128|3/3|628|
|cwd: empty dir under `/tmp`|3/3|2/3|60783|52302|3/3|636|
|HOME: warm (seeded by an earlier server)|3/3|3/3|97405|84563|3/3|294|
|OTEL: no `OTEL_*` at all|3/3|3/3|84814|75950|3/3|454|
|OTEL: endpoint is a dead port|3/3|3/3|76189|72713|3/3|475|
|OTEL: `experimental.openTelemetry` on|3/3|3/3|118989|64152|3/3|396|
|OTEL: `OTEL_SERVICE_NAME` instead of resource attrs (dotfiles)|3/3|3/3|108814|96568|3/3|508|
|client: `curl` instead of Bun `fetch`|3/3|3/3|96722|95932|3/3|515|
|host: `127.0.0.1`|3/3|2/3|47962|40866|3/3|224|
|host: `::1`|3/3|2/3|47432|39002|3/3|314|
|port: fixed 17900|3/3|2/3|51630|41979|3/3|213|
|stdio: pipe, never read|3/3|2/3|46479|-|3/3|201|
|stdio: pipe, drained|3/3|2/3|48902|-|3/3|597|
|stdio: `/dev/null`|3/3|2/3|51109|-|3/3|413|
|stdio: inherit|3/3|2/3|60388|-|3/3|453|

How to read the left half. **No variable I flipped changed the outcome**, and none of them rescued the prompt. The spread inside it (40 to 97 s) is run order and host load: the sweep ran three servers at once and the later rows (host, port, stdio) ran on a quieter box, which is why they sit near 47 s. Do not rank rows against each other. The right half is the evidence: remove the watcher boot and all 18 cells, 54 trials, prompt in under 1.3 s, regardless of env, cwd, HOME, OTEL, client, host, port or stdio. The unread-pipe suspicion is out: a never-drained stdout pipe is fine (the server logs little).

Other cells that mattered:

|check|result|
|-|-|
|directory sizes (`evidence/location-dose.jsonl`): cwd under an empty parent, a parent with 1k, 10k, 40k files, a sibling dir with 1k, 10k, 40k files, the real `$TMPDIR` (about 30k entries)|2/2 each, boot 3 to 30 s, no trend with entry count (40k files: 3.9 and 9.2 s; empty: 11.9 and 27.2 s). Directory size is not the driver|
|other env switches, 3 each (`evidence/recipe.jsonl`)|`OPENCODE_DISABLE_FILEWATCHER`: boot 30, 56, 46 ms. `OPENCODE_FILEWATCHER_DISABLE`: 32, 29, 28. Both: 28, 37, 29. `OPENCODE_DISABLE_PROJECT_CONFIG`: 6.8, 3.1, 0.8 s. `OPENCODE_FAST_BOOT`: 8.5, 57, 15 s. Baseline: 38, 31, 55 s|
|boot log (`evidence/boot-timeline-watchers-on.txt`)|watchers start for `/Library/Application Support`, `/`, `/var`, `/var/folders`, ... down to the cwd, about 1 s each on a quiet run; `location services booted durationMs=9116`|
|CPU while stalled|median 2 % per trial in the watchers-on sweep (range 1 to 63 %); the server waits, it does not compute|
|what else boot does (via a CONNECT-logging proxy, `scripts/connect-log-proxy.ts`)|fetches `models.opencode.ai` (6 MB, 0.15 s by curl; not the cause) and probes `127.0.0.1:1234`, `:11434`, `:8000` (refused at once)|

Discarded: a first depth-versus-boot run (nested empty dirs) and a first directory-size run. A bloat fixture was left as a sibling inside the "clean" base, so both were contaminated. The table above comes from the rebuilt runs (one fixture alive at a time).

## What I could not establish

- **Why each ancestor watcher takes that long**, and why it stretches with concurrent servers and load. The log shows the sequence, not the wait. The CPU numbers say it is waiting, not computing. It is not directory size.
- **Whether a second directory on the same server pays the boot again.** Wave 3 will serve many cwds from one server; with the env var set this is a non-issue, but I did not measure it without.
- **Side effects of the flag beyond AGENTS.md:** file-change events, git status events, skills/AGENTS.md hot-reload.
- **Load as the cause of the variation.** It is the best fit (concurrency scaling, run-order drift, 2.5 s to 109 s on the identical cell), not a controlled result.
- Later builds; a quiet host (best case measured: 2.5 to 8 s with watchers on).

## For Wave 3

1. Put `OPENCODE_DISABLE_FILEWATCHER=1` in the server env. agent-gateway's server env allow-list lives in `~/SourceRoot/agent-gateway/scripts/opencode-server-env.ts` (per the dotfiles telemetry report: the wrapper's `env -i` forwards only that list); the host must pass the variable through any such wrapper. I changed nothing there.
2. Do not rely on a wall-clock prompt ceiling to judge a server dead. Use the idle watchdog from `rules/agent-limits`; poll `GET /api/info` (2 s timeout) as liveness; on a dead server SIGTERM, wait about 5 s, SIGKILL, restart on the same data dir, re-attach by session id.
3. Treat the stall as a health signal, not an error, if the variable is ever absent.
4. Unrelated, seen on the way: `GET <IU openai base>/models` timed out at 5 s on roughly a third of calls while chat completions were fine. A probe that gates on `/models` (as my first harness did) fails spuriously. `opencode-safe` probes the base URL, not `/models`.

## Reproduce

```bash
cd docs/spikes/opencode-wedge   # or the repo root; paths are relative to the script
timeout 900 bash scripts/reproduce.sh
```

Needs the pinned 2.0.32 build, bun, and the IU Keychain items (`claude-sdk-api-key`, `claude-sdk-base-url`). Takes 4 to 9 minutes depending on host load (final run 4 min 31 s). Starts only throwaway servers on its own ports, SIGKILLs each, and checks the server list before and after (agent-gateway's servers are untouched). The full sweeps: `bun scripts/matrix.ts bisect-fixed,bisect-wedge --reps 3 --conc 3 --ceil 120000` (about 35 minutes).

Final run (`evidence/reproduce.out.txt`), summary table:

```text
|group|cell|prompted / n|wedged|median prompt ms|median location-boot ms|mean CPU %|prompt >45 s (S2 guard)|SIGTERM not honoured in 6 s|SIGKILL ok|
|-|-|-|-|-|-|-|-|-|-|
|repro|S2 spawn as ran (watchers on)|3/3|0|6625|6162|7|0/3|2/3|2/2|
|repro|same + OPENCODE_DISABLE_FILEWATCHER=1|3/3|0|211|29|72|0/3|0/3|0/0|
```

That run happened on a quieter host (boot 2.5, 6.2 and 20 s, so none exceeded 45 s). The wedge is therefore load-dependent: the same cell took 31 to 55 s one at a time and 31 to 109 s in the three-at-a-time sweep. The watchers-off row is the same on every run.

## Versions and cost

- OpenCode 2.0.32 (`opencode v2.0.32`, pinned build under `agent-gateway/opencode-bin/2.0.32`, native arm64 binary, not a shim)
- Bun 1.4.3, macOS 26.7.1 (arm64), host load average 5 to 10 throughout
- Model: `deepseek-v4.1-flash` via IU chat (`aisdk:@ai-sdk/openai-compatible`), configured at cost 0
- Spend: about 220 one-word prompts (142 logged in the evidence rows plus replays, manual probes, recovery and reproduce runs), roughly 10 tokens each. At the $0.0000078 per call S2 measured, about $0.002. Not metered.

## Files

|path|what|
|-|-|
|`scripts/reproduce.sh`|the one command|
|`scripts/trial.ts`|one server, one prompt, one verdict; every variable is an option|
|`scripts/matrix.ts`|cells x reps with counts; groups `repro`, `recipe`, `location`, `bisect-wedge`, `bisect-fixed`|
|`scripts/recover.ts`|SIGTERM latency, detection probes, kill/restart/re-attach|
|`scripts/agents-md-check.ts`|AGENTS.md still honoured with the watcher off|
|`scripts/dotfiles-opencode_probe.sh`, `replay-dotfiles.sh`|the earlier spike script (unmodified copy) and its replay wrapper|
|`scripts/connect-log-proxy.ts`|diagnostic proxy that logs what a cold server connects to|
|`evidence/`|tables, raw rows (`*.jsonl`, no credentials, scratch paths only), boot timeline, final reproduce output|
