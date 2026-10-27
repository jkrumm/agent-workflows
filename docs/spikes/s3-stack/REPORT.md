# Spike S3: stack verdict (2026-10-27)

**Verdict: oRPC `1.16.1` + zod `4.6.7` on Bun `1.4`; `bun test`; Biome `2.6.3` (format + lint) with `oxlint 1.89.0 --type-aware` as a second lint step; TypeScript `7.0.2` (`tsc`).**

Scaffold installs exactly these. Pin them exactly (no carets): Bun's global 3-day `minimumReleaseAge` already
forced two choices below the registry `latest`.

| Slot | Pick | Runner-up |
|-|-|-|
| HTTP + OpenAPI | `@orpc/server` `@orpc/openapi` `@orpc/zod` `1.16.1` | Elysia `1.4.30` + `@elysia/openapi` `1.4.16` |
| Test | `bun test` (Bun `1.4.4`) | Vitest `5.0.5` |
| Lint + format | `@biomejs/biome` `2.6.3`, plus `oxlint` `1.89.0` + `oxlint-tsgolint` `7.0.2005` for typed rules | oxlint + `oxfmt` (beta) |
| Typecheck | `typescript` `7.0.2` (native `tsc`) | `@typescript/typescript6` `6.0.2` |

Research (all library facts below come from these two jobs, plus registry `time` fields I queried directly):
frameworks `74b5915f-c84a-4f90-adec-ec92249c87ad`, toolchain `bdaae225-277f-4d61-82c8-5f699e578ddd`.
The toolchain job came back `partial`; the one unverified item (Bun 1.4.1-1.4.4 test-runner changes) does not affect the pick.

## Why oRPC

The concept calls a capability "import, HTTP and CLI from one definition" (§2) and wraps *every* call in middleware (§4).
Only oRPC does that with one definition:

- `call(procedure, input)` runs the **same pipeline as HTTP**: zod validation, defaults, typed errors and `.use()` middleware.
  Measured: one middleware counter, 1 hit for an import-style call, 1 for an HTTP call.
- Elysia and Hono have no in-process route call. The closest is a synthetic `Request` through the router (`app.handle`, `app.request`).
  Calling the handler function directly skips validation and middleware, so "import" would be a second, unvalidated door.
- The typed error is part of the procedure contract (`.errors({ RUN_NOT_FOUND: { status: 404, data } })`) and lands in the OpenAPI 404 body.
- The SSE operation is documented as `text/event-stream` with a typed event schema. Elysia documents nothing for it.

Costs, accepted: 25 production packages vs 6; the HTTP dispatch is 3-6x slower than Hono and ~8x slower than Elysia in-process
(40-85k req/s on a loaded host, workflows last seconds to minutes); the emitted OpenAPI version is fixed at `3.1.1`; a docs trap (below).

No current alternative beats all three. `ts-rest` is dead (3.52.1, 2025-06-02, zod 3 peer). Fastify 5 +
`fastify-type-provider-zod@7.0.0` + `@fastify/swagger@9.9.2` is the maintained Node-flavoured path (needs zod >= 4.2, no in-process call). `hono-openapi@1.5.0`
(Standard Schema) and `chanfana@3.4.2` are Hono add-ons. None was implemented here.

## Comparison

All numbers from `bun run compare`, run on a loaded host (load average ~18 during the runs), so read timings as orders of magnitude.

| | oRPC 1.16.1 | Elysia 1.4.30 | Hono 4.13.13 + zod-openapi 1.6.3 |
|-|-|-|-|
| zod 4 | via `@orpc/zod/zod4` entry; peer `zod >=3.25` | Standard Schema + Standard JSON Schema; no peer declared | `zod ^4.0.0` only (v3 dropped at 1.0) |
| OpenAPI emitted | 3.1.1, fixed | 3.1.2 (default) | 3.1.0 via `getOpenAPI31Document` (default `doc()` is 3.0) |
| enum / default / description | ok / ok / ok | ok / ok / ok | ok / ok / ok |
| discriminated union (input and response) | `anyOf` + `const` | `oneOf` + `const` | `oneOf` + single-value `enum` |
| defaulted field in `required` (input) | no (correct) | no, but only without `mapJsonSchema` (see risks) | no (correct) |
| typed error in the doc | yes, native: `oneOf` [declared, generic fallback] | yes, per-status response schema | yes, per-status response |
| `x-cli` attach | `.route({ spec: (s) => ({ ...s, 'x-cli': X }) })` | `detail: { 'x-cli': X }` | key on `createRoute({ 'x-cli': X })` |
| in-process call without HTTP | `call(proc, input)`, typed, validated | `app.handle(Request)` only (no typed in-process client evaluated) | `app.request(...)` only |
| SSE | `eventIterator(schema)`, 4/4 events, documented | `yield sse({ data })`, 4/4 events, **not documented** | `streamSSE`, 4/4 events, documented as `string` |
| noise in the doc | none | 6 embedded `$schema`, 3 request media types per POST | none |
| document size, bytes | 5490 | 5670 | 3740 |
| wiring LOC (one file, 3 operations) | 62 | 50 | 53 |
| prod packages (excl. zod) / unpacked MB | 25 / 2.6 | 6 / 2.4 | 6 / 2.6 |
| GET req/s through the fetch handler | ~40-85k | ~330-650k | ~170-400k |
| cold start incl. Bun, ms | ~40-70 | ~85-150 | ~55-110 |
| `tsc` clean | yes | yes | yes (one `as never` on the SSE return) |
| Bun | runs; Node-neutral fetch adapter | native, built for it; no `engines`, optional peer `@types/bun >=1.2` | runs; documented |
| stable line | `1.16.1`; `2.0.0-beta.47` is a breaking preview | `1.4.30`; 2.x is a rewrite at `rc` | `4.13.x`; `5.0.0-rc.1` on `next` |

### Emitted OpenAPI, the same operation (`POST /run`, excerpts)

`x-cli` is identical in all three: `{ "command": ["research","run"], "positional": ["question"], "mutating": true, "defaultFormat": "plain", "plainField": "result.body", "job": { "statusOperationId": "runStatus", "idField": "runId", "statusField": "status", "terminal": ["done","failed"], "successStatus": "done", "resume": { "command": ["research","wait"] } } }`.

oRPC:

```json
"depth":  { "enum": ["quick","standard","deep"], "type": "string", "description": "Search breadth", "default": "standard" },
"source": { "anyOf": [ { "type":"object", "properties": { "kind": { "const": "web" } }, "required": ["kind"] },
                       { "type":"object", "properties": { "kind": { "const": "brain" }, "path": { "type":"string" } }, "required": ["kind","path"] } ] },
"required": ["question"]
// 200: { "anyOf": [ {status:"done", runId, result}, {status:"pending", runId, elapsedS, resume:{command}} ] }
// GET /runs/{runId} 404: { "oneOf": [ { defined:true, code:"RUN_NOT_FOUND", status:404, message, data:{runId} }, { defined:false, code, status, message, data } ] }
// GET /runs/{runId}/events 200: content "text/event-stream", oneOf [ {event:"message", data:{phase, at}, id?, retry?}, ... ]
```

Elysia:

```json
"depth":  { "default": "standard", "type": "string", "enum": ["quick","standard","deep"], "description": "Search breadth" },
"source": { "oneOf": [ { "type":"object", "properties": { "kind": { "type":"string", "const": "web" } }, "required": ["kind"], "additionalProperties": false }, ... ] },
"required": ["question"],  "$schema": "https://json-schema.org/draft/2020-12/schema"   // repeated inside every schema
// requestBody content: application/json, application/x-www-form-urlencoded, multipart/form-data (same schema three times)
// 200: { "$schema": ..., "oneOf": [ {done}, {pending} ] }
// GET /runs/{runId} 404: { "type":"object", "properties": { "error": { kind: const "not_found", message, runId } }, "required": ["error"] }
// GET /runs/{runId}/events: no `responses` entry at all
```

Hono:

```json
"depth":  { "type": "string", "enum": ["quick","standard","deep"], "default": "standard", "description": "Search breadth" },
"source": { "oneOf": [ { "type":"object", "properties": { "kind": { "type":"string", "enum": ["web"] } }, "required": ["kind"] }, ... ] },
"required": ["question"]
// 200: { "oneOf": [ {done}, {pending} ] }
// GET /runs/{runId} 404: { "type":"object", "properties": { "error": { kind: enum ["not_found"], message, runId } }, "required": ["error"] }
// GET /runs/{runId}/events 200: content "text/event-stream", schema { "type": "string" }
```

Full documents: run `bun run compare`, they land in `out/*.openapi.json` (git-ignored).

## The CLI-generator finding

`cli/agw-poc.ts` is the spike-7 runner, copied unmodified (536 lines). Each emitted document was fed to it; requests go
through each framework's fetch handler in-process (no sockets). Per framework: `research run | status | wait` all generated from `x-cli`,
flags `question, depth, profile, source`, enum validation, `--depth huge` exits 2, quick run exits 0, a `deep` run with a tiny wait budget exits 10 with
the exact hint `agw-poc research wait <runId>`, running that hint exits 0, unknown run exits 4.

Least glue: **Hono and Elysia need none; oRPC needs one line.** All three differ in only two places:

| Gap | oRPC | Elysia | Hono | Fix |
|-|-|-|-|-|
| error message | `HTTP 404`: oRPC's body is `{defined, code, status, message, data}`, the runner reads `error.message` | passes through | passes through | one line in the runner: also read top-level `message`; map `code` to `kind` |
| union / object flag | `--source '{"kind":"web"}'` exits 2 | same | same | framework-independent: the runner sends the raw string for flags with no scalar `type`; `JSON.parse` them |

The oRPC row is small because the runner is ours; the generator Scaffold builds owns that mapping, and a typed `code` is a better source for exit codes than
HTTP status alone. The oRPC body shape also removes the ambiguity of an ad-hoc `{ error: { kind } }` per route.

Elysia's documented recipe breaks the CLI: its docs say to pass `mapJsonSchema: { zod: z.toJSONSchema }`. That emits `required: ["question","depth","profile"]`
(zod's default is output mode), the runner then demands `--depth` and `--profile`, and every run exits 2 (`elysia-mapjson` column in the compare output).
Omitting `mapJsonSchema` makes the plugin use zod's Standard JSON Schema, with input/output awareness, and the problem disappears. This is verified against the plugin source
(`standard.jsonSchema[io]`) and the compare run, but it is a trap a copy-paste of the docs walks into.

Not tested: registered/`$ref`'d schemas. The runner does not resolve `$ref` in `requestBody`, and Hono's `.openapi('Name')` and oRPC common schemas would emit them.
The generator must dereference before reading `properties`.

## Toolchain

Same 6 tests (3 frameworks x run + 404) under both runners; seeded defects in `lint-fixtures/bad.ts`.

| Tool | Result |
|-|-|
| `bun test` | 150-200 ms wall for 6 tests, 0 deps |
| `vitest run` 5.0.5 | 0.9-1.2 s wall, works under Bun via `bun run test` only (plain `bun test` runs Bun's own runner) |
| `biome check` 2.6.3 (lint + format) | 0.25-0.5 s on 8 files |
| `oxlint` 1.89.0 | 80-140 ms; `--type-aware` 0.65-1.2 s with `oxlint-tsgolint` 7.0.2005 |
| `oxfmt` 0.74.0 | 80 ms; 0.x beta, not adopted |
| `tsc` 7.0.2 vs `tsc6` 6.0.2 | 1.5-3 s vs 1.2-2.8 s, indistinguishable on this project: both load the same 999 files and ~270 MB, and the host was loaded. Rerun on the real repo. |

- **Test runner: `bun test`.** No project model (filters by path substring, no globs; `--filter` is not a `bun test` flag), so per-package runs go
  `bun run --filter '<pkg>' test`. Default is one shared global per run: pass `--isolate` (or `--parallel`) so a package that sets globals cannot leak into a sibling. Not a drop-in for the Vitest API
  (an open Bun issue shows a Vitest-API file failing under `bun test`), so write tests against `bun:test` from day one.
- **Lint + format: Biome for the gate, oxlint for typed rules.** Both seeded defects (floating promise, async `forEach`) are caught by both. Biome's typed rules
  (`noFloatingPromises`, `noMisusedPromises`) are `nursery` and run on Biome's own inference engine, not `tsc`; oxlint's type-aware mode was declared stable on 2026-07-22 and runs on typescript-go, yet type-aware sits under "Features Not Subject to Semver".
  On my first draft of `compare.ts`, oxlint `--type-aware` flagged 5 issues (`${Buffer}` in templates, a redundant `any` union) that Biome did not, with a different rule set enabled, so it is evidence, not a ranking.
  `oxfmt` is beta; Biome's formatter is stable and covers JSON/CSS/Markdown/YAML.
- **Typecheck: `typescript@7.0.2`.** `typescript@latest` is the native compiler since 2026-07-08; `@typescript/native-preview` is frozen at `7.0.0-dev.20260707.2`, do not install it. The prototype passed with no changes.
  TS 7 ships no programmatic API (7.1 beta, 2026-10-20, adds one): anything that imports `typescript` as a library needs the `@typescript/typescript6` alias. Biome and oxlint do not.

## Risks

1. **oRPC docs trap.** `orpc.dev` documents v2 (beta); stable `1.16.1` is documented at `v1.orpc.dev`. v2 `2.0.0-beta.47` is a breaking line: `eventIterator` becomes `asyncIteratorObject`, the `@orpc/zod/zod4` entry is dropped, zod `>=4.5.0` is required, the default doc version is 3.2.0. Pin `1.16.1`; moving to v2 is its own PR.
2. **oRPC `x-*` is an escape hatch, not a feature.** The `spec` callback replaces/extends the operation object; no doc names `x-` extensions. A thin `cli(x)` helper in the capability layer keeps it from being scattered.
3. **oRPC cannot choose the OpenAPI version** (`3.1.1`, hard-wired in v1). Fine for the runner; a consumer that pins 3.1.0 would object.
4. **Package count.** 25 vs 6 production packages; the supply-chain surface is larger. Bun's 3-day cool-down is on; `hono` `4.13.14`, `oxlint` `1.90.0` and `oxfmt` `0.75.0` were younger than 3 days, so the spike pins the previous patch. Scaffold will hit the same wall: pin what resolves, do not lower the setting.
5. **Elysia 2.** `elysia@1.4.30` is stable, but the maintained line is moving to a complete rewrite (`2.0.0-rc.0`, TypeBox 1.x, route-argument swap). The plugin moved scope (`@elysia/openapi` vs `@elysiajs/openapi`, same version `1.4.16`). This is why Elysia is the runner-up, not the pick.
6. **Zod 4 floor.** oRPC v1 admits `zod >=3.25`; Elysia's Standard JSON Schema path needs a zod that exposes `~standard.jsonSchema` (verified on 4.6.7). Pin zod `4.6.7` in the repo and do not resolve it from peers.
7. **Typed in-process call is oRPC-only**, so the capability layer would be coupled to oRPC (`call`, `ORPCError`). That is deliberate (one door), but it means a framework swap later is a rewrite of the procedure layer, not the handlers. Keep handlers as plain functions of `(input, ctx)`.
8. **Throughput.** Measured 40-85k req/s in-process for oRPC on a loaded host. Orders of magnitude above any workflow call rate here; do not let it count against oRPC, but note the 8x gap to Elysia if a hot path ever appears.
9. **Not covered**: `$ref`/registered schemas through the runner (above), oRPC middleware ordering with step-level journaling (belongs to the runtime spike), `bun test` on the real repo layout, TS 7 speed at repo scale.

## Reproduce

```sh
cd docs/spikes/s3-stack && bun install && timeout 300 bun run compare
bun run typecheck && bun run lint && bun run lint:ox && bun run test && bun run test:vitest
```

`src/shared.ts` holds the schemas, `x-cli` blocks and the fake engine; `src/{orpc,elysia,hono}.ts` hold only wiring; `src/compare.ts` emits the documents and prints every table above.
