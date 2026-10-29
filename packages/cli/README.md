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

- **`AGW_URL`** (default `http://127.0.0.1:7791`) and **`AGW_API_SECRET`** come from the environment, key by key. Plain `http://` is refused (exit 3) unless the host is `127.0.0.1`, `[::1]` or `localhost`, so the bearer never leaves in cleartext. Whatever is unset is read from `${XDG_CONFIG_HOME:-~/.config}/agw/env` (`KEY=value` lines, written by `make deploy`). That file is refused unless its mode is exactly `0600`. No secret anywhere means exit 3, with a hint that names the file.
- **The contract** is cached per host at `${XDG_CACHE_HOME:-~/.cache}/agw/<sha256(AGW_URL)[:12]>/openapi.json`, so two hosts never share one. It is fetched (`GET /openapi.json`, bearer) when there is no cache, on `agw schema --refresh`, and at most once per call on an error a stale cache explains: an unknown command, an unknown flag, a missing required field, a 412. New commands and new flags appear without a manual refresh. **A stale cache cannot be acted on**: a call sends the cache's sha, so a stale contract is a 412 that refreshes and retries; and `--help` (top level, a group, a command), which sends no call and so has no sha to check, fetches the contract first (one request; when the host cannot answer, or no secret is set, it prints from the cache, and an unknown command then names the failed refresh in its message). `agw schema` stays offline on purpose; `agw schema --refresh` fetches. This needs nothing from a deploy (no cache to clear on the mini), so it holds on any machine that has ever run `agw` against the host.
- **`x-cli.hidden`** (a capability's `cli: { hidden: true }`) makes an operation no command and not a skipped one (`agw schema` lists it under `hidden`): its answer is not for a terminal (`image.generate` is megabytes of base64). It stays on HTTP and in process, and its `command` still takes part in the host's uniqueness check (`assertCommands` covers every capability).
- **A bad document never replaces a good cache.** Commands are built before the cache is written. An operation with an unknown `x-cli.kind`, no valid command words, a reserved-flag collision or a command another operation already maps to is skipped; it is no command, and `agw schema` lists it under `skipped` with its reason. `$ref`s are inlined everywhere, including path items, operations, parameters and request bodies. A document with no usable operation is refused (exit 1) and the cached contract is kept.
- **Every call** sends `x-agw-contract: <sha>`, the cached document's `info['x-contract-sha']`. The sha is the sha256 of the canonical JSON (keys sorted recursively, no whitespace) of the document without that field.
- **On a 412**, the CLI refreshes the cache. It retries the call once if the same argv still parses against the new contract, else it exits 9. A 412 in the middle of a wait loop refreshes the cache and exits 9 with the resume command as the hint, so the run is never started twice.

### Platform processes

The platform runs one `host` process plus own processes for heavy pipelines (concept §8). Each serves its own OpenAPI document with the same `x-cli` extensions and takes the same bearer secret; `agw` serves one merged command set from all of them.

- **`AGW_PROCESSES`** names the other processes: `AGW_PROCESSES=audio=http://127.0.0.1:7792` (comma-separated `<name>=<url>`; names `[a-z][a-z0-9-]*`, not `host`). `AGW_URL` stays the host. It is read like the other keys, environment first, then the env file, with one rule: **the process list goes with the host URL**. When `AGW_URL` comes from the environment, `AGW_PROCESSES` is read from the environment only, so a shell pointed at another host never mixes in the deployed processes of the env file. A malformed list (no `=`, a bad or duplicate name, `host`, one URL twice) exits 2 naming the entry. Without `AGW_PROCESSES` the CLI is exactly the single-host CLI: one contract, one fetch, the same output.
- **Contracts and caches per process.** Each contract is cached under its own URL (above). The host loads as always (its cache, else a fetch that must succeed). Another process loads from its cache only: a command call never fetches another process's contract, so a hung or down process never delays a host command. Its contract is fetched when it can matter: `--help` (every contract once, in parallel), an unknown command or a missing flag or field (every process once, in parallel; the host's failure is reported after the others were tried), and `agw schema` (a process with no cache). A 412 refreshes only the process that answered it. Another process's contract fetch has a 10 s hang guard; the host's keeps `AGW_TIMEOUT_S`. The credentials and the process list are read and validated once per call.
- **Routing.** A command goes to the process whose contract declared it, with that process's contract sha.
- **Conflicts fail loudly.** A command two processes declare never runs: it exits 9 (`'<words>' is declared by more than one process: host, audio`), `agw <words> --help` prints the help with that line below it, `agw --help` marks it `[conflict: host, audio]`, `agw schema` lists it under `conflicts`. The other commands keep working. A conflict is seen as of the contracts known to this call: one with a process never fetched shows once `--help` or `agw schema` has fetched it. The one exception is below.
- **Runs.** Every process is built by the same host app code, so each serves `run status|wait|cancel` with the identical operation; `kind: 'run'` declarations identical in method, path, `x-cli`, every input schema and the output schema (canonical JSON) are one shared command; a drifted one is a conflict.
  - *Decision:* the run's owner is the shared journal, not a prefix in the resume command. Every process reads and writes the same Postgres journal: `status` and `wait` are journal reads, and `cancel` (and a steer) is a journal request applied by whichever process holds the run's lease (`packages/runtime/src/journal.ts`, `Journal.cancel`; `Runtime.cancel` aborts a local scope only if there is one). So any process answers any follow-up correctly. Why not the alternatives: a process prefix would change the resume command (`agw run wait <runId>`) that every caller already parses; asking processes in turn would turn a 404 into N requests.
  - Inside one call, the wait loop stays on the process that answered the start. A standalone run command (the printed `pending` resume command included) goes to the host first and moves to the next process only when the connection was provably never opened (`ECONNREFUSED`, `ENOTFOUND`, `EAI_AGAIN`). A reset, a lost answer or a timeout exits 7 at once, so a request that may have landed is never sent twice.
- **A process down or answering no contract.** Host commands keep working. Its cached commands stay in `--help`, marked `[unavailable: audio]`, with `(process audio unavailable: <reason>)` below. An unknown command names a process's failure only when that process could declare it (no contract known, or commands under the same first word), so a typo in a host command never blames a down process. Invoking one exits 7 (network) with a message naming the process (`process audio unreachable at <url>: …`). A process that answers but hands over no usable contract after a 412 is also exit 7, `process audio is unavailable: …`.
- **`agw schema`** stays offline from the caches. With `AGW_PROCESSES` set, every entry carries `process`, the listing adds `processes` (name, url, contractSha, and `unavailable` when its fetch failed in this call) and lists every process's operations, the shared run commands once per process. `contractSha` at the top stays the host's.

### Commands, arguments and flags

| From the document | Becomes |
|-|-|
| `x-cli.command` | the command words: `['llm','title']` is `agw llm title` |
| `x-cli.positional` | positional arguments, in order |
| every other input property (body, path and query parameters, `$ref`s inlined) | `--kebab-case` flags: `maxWords` is `--max-words` |
| `string`, `number`, `integer`, `enum` | coerced and checked |
| `boolean` | `--loud` or `--no-loud`; inline only `--loud=true\|false` |
| a union of literals (`anyOf` of `const`s) | an enum: every value in usage and help |
| a union of scalars (`string\|number`) | the string passes through; the host validates it |
| objects, arrays, unions with an object or array | one JSON value: `--labels '{"bug":"…"}'` |
| `x-cli.stdin` | read from stdin only when that field is required, not given otherwise, and stdin is not a TTY. An optional field is never read implicitly, so an inherited open pipe cannot hang the call |

- **Globals:** `--format json|plain`, `--help`. `--commit` exists only on mutating commands, and `--idempotency-key <k>` only on workflows and mutating commands. They are reserved: an operation with a non-positional input property of one of those names (`format`, `commit`, `idempotencyKey`, `help`) is skipped like one with an unknown `kind`, and `agw schema` lists it under `skipped` with the reason. The host refuses such operations at start, so this is defence only.
- **Errors before sending:** an unknown flag or command exits 2 and the hint lists the valid ones. A missing required input, a bad value, and a path parameter that decodes to `.` or `..` (checked after every decode, up to 8) or is still percent-encoded after 8 decodes also exit 2, client-side.
- **Output:** JSON on stdout when stdout is not a TTY (agents). On a TTY, `x-cli.defaultFormat` decides. `--format plain` prints `x-cli.plainField`, a dotted path into the response. A capability answers its output directly, so the path starts at the response; a workflow answers a run envelope, so the path starts at its `output`, and only once the run is `done` (a pending, failed or cancelled answer prints the whole state, as in JSON). `agw diagram "..." --format plain > x.excalidraw` writes the document.
- **Mutating commands** (`x-cli.mutating`) need `--commit` (or `--commit=true`) when stdin is not a TTY. Without it, or with `--commit=false`, the CLI exits 6 and sends nothing.
- **Deadlines:** a request that waits on a run gets `Prefer: wait` plus 30 s. Every other request gets `AGW_TIMEOUT_S` (default 1800 s), a hang guard for a capability that runs a model synchronously, never a budget. A deadline hit exits 7 with `no answer from <url> within <n>s`.

### Workflows and runs

- `kind: 'workflow'` commands `POST /workflows/…` with `Prefer: wait=<min(remaining, 240)>`. They forward `x-agw-purpose` (`AGW_PURPOSE`). A workflow start and every mutating call carry an `Idempotency-Key`: `--idempotency-key <k>`, else one generated before the first send. If the network fails on that send, the hint is `the run may have started; retry with --idempotency-key <k>`.
- A `202` answer means the run is still going. The CLI loops on the command named by `x-cli.resume` (`run wait <runId>`) until the run ends or `AGW_WAIT_BUDGET_S` (default 110) is spent. A host that answers `202` at once is polled at most once a second.
- **`done`** prints the state and exits 0. **`failed`/`cancelled`** prints the state and exits 1.
- **Budget spent:** stdout carries the last state, the error line `kind: pending` with `hint: "agw run wait <runId>"`, and the CLI exits 10. That hint is exactly the command to run next.
- **A `202` without the resume positional** (no `runId`), or a workflow without `x-cli.resume`, prints the state and exits 1 (`host returned no run id`). It never prints a resume command it cannot fill in.
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

- `agw schema` lists the commands with the contract sha, and `skipped` (operation, command, reason) when the document has operations the CLI could not use.
- `agw schema <command…>` prints the input schema, with `x-flag` or `x-positional` on each property, plus the output schema and `x-cli`. For a workflow the output schema is the run state with the workflow's own `output` typed (the host writes it into the document; `agw schema review` shows `REVIEW_OUTPUT`); `run status|wait|cancel` keep `output` open.
- `agw schema --exit-codes` needs neither a cache nor a host.

## Conformance suite

`test/conformance.test.ts` is black-box. It spawns `bin/agw.ts` and asserts stdout, the stderr line and the exit code. The fake host (`test/fake-host.ts`, `Bun.serve` on port 0) serves the real capabilities registry's `openapi()` and routes on fake transports, plus fixture workflow and run operations shaped as contract v1. It checks every exit code from 0 to 10, flag types through a `$ref`, stdin, `--format plain`, literal and scalar unions, boolean syntax, unknown commands and flags with and without refresh, `--commit` and `--commit=false`, idempotency replay, conflict and the generated key in the network hint, the 412 retry and the removed command, a skipped unknown `kind` and a bad document that keeps the cache, a `202` without a run id, an optional stdin field under an open pipe, one cache per URL, the request deadline, `.`/`..` path parameters, pending and resume, the 240 s cap, `schema` offline with the host down, the env-file mode and an unreadable env file, and a contract-sha known-answer vector shared with the fake host. A second block runs two fakes with different contracts over one shared run store (the journal): merged help, routing, a conflict, one process down, run follow-ups and the resume command of a second process's `pending` answer, a 412 from the second process, a 412 on a shared run command with another process down, `schema --refresh` with the host down, a dropped connection that is not resent, an uncached hung process a host command never contacts, `--help` on a conflict, drifted run operations, a typo that does not blame a down process, per-process caches and a malformed `AGW_PROCESSES`.

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
- **`agw schema <workflow>` is larger** by the workflow's output schema (a screenful for `review`); it is read once, and it replaces reading the host's source.
- **Help is for humans.** Agents should use `agw schema <command>`, which carries the same facts as structured JSON.

On the cache side, the contract is cached on disk, so a capability call costs one HTTP request and no spec fetch. A new contract costs one extra `GET /openapi.json`, only on an unknown command or a 412.
