# @agent-workflows/cli

`agw` is one generic runner: it reads the host's OpenAPI document and turns every operation's `x-cli` block into a command (concept §9, ADR-004). There is no per-command code. A new capability or workflow on the host is a new command on the next call.

```sh
agw llm title "Release notes for the new CLI"          # {"title":"…"}
git log -1 --format=%B | agw llm summarize --format plain
agw <workflow words…> [args]                           # a workflow: waits, or exits 10 with the resume command
agw run wait 6f1c…                                     # that resume command, verbatim
agw schema                                             # offline: every command from the cached contract
agw schema llm classify                                # one operation's input schema and x-cli
agw schema --exit-codes
```

`bin/agw.ts` is the entry point (`#!/usr/bin/env bun`). Bun only, no runtime dependencies.

## The contract as the CLI sees it

Host HTTP contract v1, fixed by the lead. The host serves it, `agw` consumes it.

### Credentials and the cached contract

- **`AGW_URL`** (default `http://127.0.0.1:7791`) and **`AGW_API_SECRET`** come from the environment, key by key. Whatever is unset is read from `${XDG_CONFIG_HOME:-~/.config}/agw/env` (`KEY=value` lines, written by `make deploy`). That file is refused unless its mode is exactly `0600`. No secret anywhere means exit 3, with a hint that names the file.
- **The contract** is cached at `${XDG_CACHE_HOME:-~/.cache}/agw/openapi.json`. It is fetched (`GET /openapi.json`, bearer) when there is no cache, on `agw schema --refresh`, once on an unknown command, and once on a 412.
- **Every call** sends `x-agw-contract: <sha>`, the cached document's `info['x-contract-sha']`. The sha is the sha256 of the canonical JSON (keys sorted recursively, no whitespace) of the document without that field.
- **On a 412**, the CLI refreshes the cache. It retries the call once if the same argv still parses against the new contract, else it exits 9. A 412 in the middle of a wait loop refreshes the cache and exits 9 with the resume command as the hint, so the run is never started twice.

### Commands, arguments and flags

| From the document | Becomes |
|-|-|
| `x-cli.command` | the command words: `['llm','title']` is `agw llm title` |
| `x-cli.positional` | positional arguments, in order |
| every other input property (body, path and query parameters, `$ref`s inlined) | `--kebab-case` flags: `maxWords` is `--max-words` |
| `string`, `number`, `integer`, `boolean`, `enum` | coerced and checked. A boolean is `--loud`, `--loud=false` or `--no-loud` |
| objects, arrays, unions | one JSON value: `--labels '{"bug":"…"}'` |
| `x-cli.stdin` | that property is read from stdin when it is not given otherwise and stdin is not a TTY |

- **Globals:** `--format json|plain`, `--help`. `--commit` exists only on mutating commands, and `--idempotency-key <k>` only on workflows and mutating commands.
- **Shadowing:** an input property of the same name wins over a global flag. `agw llm summarize --format bullets` sets the summary's format, so that command prints its default output format.
- **Errors before sending:** an unknown flag or command exits 2 and the hint lists the valid ones. A missing required input also exits 2, client-side.
- **Output:** JSON on stdout when stdout is not a TTY (agents). On a TTY, `x-cli.defaultFormat` decides. `--format plain` prints `x-cli.plainField`, a dotted path into the response.
- **Mutating commands** (`x-cli.mutating`) need `--commit` when stdin is not a TTY. Without it, the CLI exits 6 and sends nothing.

### Workflows and runs

- `kind: 'workflow'` commands `POST /workflows/…` with `Prefer: wait=<min(remaining, 240)>`. They forward `Idempotency-Key` and `x-agw-purpose` (`AGW_PURPOSE`).
- A `202` answer means the run is still going. The CLI loops on the command named by `x-cli.resume` (`run wait <runId>`) until the run ends or `AGW_WAIT_BUDGET_S` (default 110) is spent. A host that answers `202` at once is polled at most once a second.
- **`done`** prints the state and exits 0. **`failed`/`cancelled`** prints the state and exits 1.
- **Budget spent:** stdout carries the last state, the error line `kind: pending` with `hint: "agw run wait <runId>"`, and the CLI exits 10. That hint is exactly the command to run next.
- `run wait` waits the same way. `run status` and `run cancel` answer once and exit 0.

### Errors and exit codes

Exactly one JSON line on stderr per failure:

```json
{"error":{"kind":"not_found","code":"NOT_FOUND","message":"Run not found","hint":"","details":{"status":404}}}
```

`code` is the server's code, or `null` when the failure is the CLI's own. `details` carries the HTTP status and the server's `data` (`server`/`client` shas on a 412, `retryAfterS` on a 429).

| Exit | Kind | When |
|-|-|-|
| 0 | ok | success |
| 1 | general | a 5xx, or a run that ended `failed`/`cancelled` (state on stdout) |
| 2 | usage | unknown command or flag, bad value, a 400/422 |
| 3 | auth | no secret, an env file with the wrong mode, a 401/403 |
| 4 | not_found | 404 |
| 5 | conflict | 409 |
| 6 | confirmation_required | mutating, non-TTY, no `--commit`; nothing sent |
| 7 | network | host unreachable |
| 8 | rate_limited | 429 |
| 9 | contract_mismatch | 412, and the command does not parse against the new contract |
| 10 | pending | budget spent, run still going; hint is the resume command |

The table lives in `src/exit.ts`. `agw schema --exit-codes` prints it, and changing it is a breaking change.

### `agw schema`

It works offline with the host down, as long as the cache exists. With no cache, it fetches one.

- `agw schema` lists the commands with the contract sha.
- `agw schema <command…>` prints the input schema, with `x-flag` or `x-positional` on each property, plus the output schema and `x-cli`.
- `agw schema --exit-codes` needs neither a cache nor a host.

## Conformance suite

`test/conformance.test.ts` is black-box. It spawns `bin/agw.ts` and asserts stdout, the stderr line and the exit code. The fake host (`test/fake-host.ts`, `Bun.serve` on port 0) serves the real capabilities registry's `openapi()` and routes on fake transports, plus fixture workflow and run operations shaped as contract v1. It checks every exit code from 0 to 10, flag types through a `$ref`, stdin, `--format plain`, unknown commands with and without refresh, `--commit`, idempotency replay and conflict, the 412 retry and the removed command, pending and resume, the 240 s cap, `schema` offline and the env-file mode.

```sh
bun test packages/cli
```

Against a deployed host (the `@verifier` after `make deploy`), the read-only cases and the pending case run too:

```sh
AGW_CONFORMANCE_URL=http://127.0.0.1:7791 \
AGW_CONFORMANCE_PENDING='["<workflow>","<command>","<args…>"]' \
bun test packages/cli
```

The secret comes from `AGW_API_SECRET` or the real env file. `AGW_CONFORMANCE_PENDING` is the argv of a workflow that runs longer than a few seconds. The live tests are skipped without these variables, and the skipped names say so.

## Token effect / cache effect

The CLI makes no model call and adds no model-visible text of its own. What it prints is what an agent reads, so every byte of output costs tokens in the caller's context:

- **Errors stay short.** One line, a message and a hint that is a runnable command, never prose.
- **JSON by default, one line.** No pretty-printing for agents.
- **Help is for humans.** Agents should use `agw schema <command>`, which carries the same facts as structured JSON.

On the cache side, the contract is cached on disk, so a capability call costs one HTTP request and no spec fetch. A new contract costs one extra `GET /openapi.json`, only on an unknown command or a 412.
