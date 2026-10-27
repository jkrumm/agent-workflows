// bun run compare: emits the three OpenAPI docs, scores them, drives the spike-7 runner against each,
// and times the toolchain candidates. Everything is in-process (no listening sockets).
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { run as agw, type Ctx, EXIT } from '../cli/agw-poc.ts'
import { build as buildElysia } from './elysia.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, 'out')
mkdirSync(out, { recursive: true })

type J = any
interface Fw {
  fetch: (r: Request) => Promise<Response>
  spec: () => Promise<unknown>
  inProcess: (i: any) => Promise<any>
}
const names = ['orpc', 'elysia', 'hono'] as const
const fws: Record<string, Fw> = {}
// the documented Elysia + zod recipe (mapJsonSchema: z.toJSONSchema) instead of zod's own Standard JSON Schema
const elysiaDocs = buildElysia({ mapJsonSchema: { zod: z.toJSONSchema } })
const elysiaDocsSpec = await (await elysiaDocs.handle(new Request('http://localhost/openapi/json'))).json()
writeFileSync(join(out, 'elysia-mapjson.openapi.json'), `${JSON.stringify(elysiaDocsSpec, null, 2)}\n`)
writeFileSync(join(out, 'elysia-mapjson.gateways.json'), JSON.stringify({ research: { baseUrl: 'http://app.local', spec: 'elysia-mapjson.openapi.json' } }))
fws['elysia-mapjson'] = { fetch: (r) => elysiaDocs.handle(r), spec: () => elysiaDocsSpec, inProcess: async () => null }
const timing: Record<string, { importMs: number; specMs: number }> = {}
for (const n of names) {
  const t0 = performance.now()
  fws[n] = await import(`./${n}.ts`)
  const t1 = performance.now()
  const s = await fws[n].spec()
  timing[n] = { importMs: t1 - t0, specMs: performance.now() - t1 }
  writeFileSync(join(out, `${n}.openapi.json`), `${JSON.stringify(s, null, 2)}\n`)
  writeFileSync(join(out, `${n}.gateways.json`), JSON.stringify({ research: { baseUrl: 'http://app.local', spec: `${n}.openapi.json` } }))
}
const specs: Record<string, J> = Object.fromEntries(
  [...names, 'elysia-mapjson'].map((n) => [n, JSON.parse(readFileSync(join(out, `${n}.openapi.json`), 'utf8'))]),
)

const table = (title: string, head: string[], rows: (string | number | boolean)[][]) => {
  console.log(`\n### ${title}\n`)
  console.log(`| ${head.join(' | ')} |\n|${head.map(() => '-').join('|')}|`)
  for (const r of rows) console.log(`| ${r.join(' | ')} |`)
}
const count = (o: unknown, pred: (k: string, v: unknown) => boolean): number => {
  let n = 0
  const walk = (x: unknown) => {
    if (Array.isArray(x)) return x.forEach(walk)
    if (x && typeof x === 'object')
      for (const [k, v] of Object.entries(x)) {
        if (pred(k, v)) n++
        walk(v)
      }
  }
  walk(o)
  return n
}

// ---- 1. fidelity -----------------------------------------------------------------------------------------
const bodyOf = (s: J) => s.paths['/run'].post.requestBody.content['application/json'].schema
const fidelity = (n: string) => {
  const s = specs[n]
  const post = s.paths['/run'].post
  const body = bodyOf(s)
  const ok = post.responses['200'].content['application/json'].schema
  const union = (x: J) => x.oneOf ?? x.anyOf
  const sse = s.paths['/runs/{runId}/events'].get.responses?.['200']?.content ?? {}
  return {
    version: s.openapi,
    enum: body.properties.depth.enum?.length === 3,
    default: body.properties.depth.default === 'standard',
    description: body.properties.question.description === 'The research question',
    inputUnion: union(body.properties.source)?.length === 2 && JSON.stringify(body.properties.source).includes('brain'),
    outputUnion: union(ok)?.length === 2,
    requiredInput: JSON.stringify(body.required),
    typedError: !!s.paths['/runs/{runId}'].get.responses['404']?.content,
    xcli: !!post['x-cli'] && !!s.paths['/runs/{runId}'].get['x-cli'],
    mediaTypes: Object.keys(post.requestBody.content).length,
    schemaKeys: count(s, (k) => k === '$schema'),
    refs: count(s, (k) => k === '$ref'),
    sseContentType: Object.keys(sse).join(',') || '(none documented)',
    bytes: JSON.stringify(s).length,
  }
}
const fidNames = [...names, 'elysia-mapjson']
const fid = Object.fromEntries(fidNames.map((n) => [n, fidelity(n)]))
const rowsF: [string, (f: ReturnType<typeof fidelity>) => string | number | boolean][] = [
  ['OpenAPI version emitted', (f) => f.version],
  ['enum rendered', (f) => f.enum],
  ['default rendered', (f) => f.default],
  ['field description kept', (f) => f.description],
  ['discriminated union in input', (f) => f.inputUnion],
  ['response union (done/pending)', (f) => f.outputUnion],
  ['input `required` (want ["question"])', (f) => f.requiredInput],
  ['typed error documented (404 body)', (f) => f.typedError],
  ['x-cli attached to both ops', (f) => f.xcli],
  ['request media types on POST', (f) => f.mediaTypes],
  ['embedded `$schema` keys', (f) => f.schemaKeys],
  ['`$ref` count', (f) => f.refs],
  ['SSE op documents content-type', (f) => f.sseContentType],
  ['document size (bytes)', (f) => f.bytes],
]
table(
  'OpenAPI fidelity',
  ['check', ...fidNames],
  rowsF.map(([label, fn]) => [label, ...fidNames.map((n) => fn(fid[n]!))]),
)

// ---- 2. in-process, SSE, throughput ---------------------------------------------------------------------
const post = (fw: Fw, body: unknown) =>
  fw.fetch(new Request('http://localhost/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }))
const coldRuns = (args: string[]) => {
  const ms: number[] = []
  for (let i = 0; i < 5; i++) {
    const t = performance.now()
    Bun.spawnSync(['bun', ...args], { cwd: root })
    ms.push(performance.now() - t)
  }
  return ms.sort((a, b) => a - b)[2]!
}
const baseline = coldRuns(['-e', ''])
const coldMs = (n: string) => Math.round(coldRuns(['src/cold.ts', n]) - baseline)
const inproc: Record<string, Record<string, string | number | boolean>> = {}
for (const n of names) {
  const fw = fws[n]!
  const good = await fw.inProcess({ question: 'abc def', depth: 'quick' }).then(
    (r) => r,
    (e) => ({ threw: String(e?.code ?? e) }),
  )
  const bad = await fw.inProcess({ question: 'a' }).then(
    (r) => r,
    (e) => ({ threw: String(e?.code ?? e) }),
  )
  const body = good?.body ?? good
  const unknownEvents = await fw.fetch(new Request('http://localhost/runs/nope/events'))
  const idRes = (await (await post(fw, { question: 'abc def', depth: 'deep' })).json()) as { runId: string }
  const ev = await fw.fetch(new Request(`http://localhost/runs/${idRes.runId}/events`))
  const text = await ev.text()
  const events = (text.match(/^data:/gm) ?? []).length
  let reqs = 0
  const t0 = performance.now()
  while (performance.now() - t0 < 500) {
    await fw.fetch(new Request(`http://localhost/runs/${idRes.runId}`))
    reqs++
  }
  inproc[n] = {
    typedCall: typeof good === 'object' && !('status' in good && 'body' in good),
    defaultApplied: JSON.stringify(body).includes('profile=yolo'),
    invalidRejected: JSON.stringify(bad).match(/BAD_REQUEST|422|400|threw/) !== null,
    sseContentType: ev.headers.get('content-type') ?? '',
    sseEvents: events,
    sseUnknownRun: `${unknownEvents.status} ${(unknownEvents.headers.get('content-type') ?? '').split(';')[0]}`,
    rps: Math.round((reqs / (performance.now() - t0)) * 1000),
    coldMs: coldMs(n),
    specMs: Math.round(timing[n]!.specMs),
  }
}
const orpcMw = await import('./orpc.ts')
const mw0 = orpcMw.stats.middleware
await orpcMw.inProcess({ question: 'abc def', depth: 'quick' })
const mwAfterImport = orpcMw.stats.middleware - mw0
await post(fws.orpc!, { question: 'abc def', depth: 'quick' })
const mwAfterHttp = orpcMw.stats.middleware - mw0 - mwAfterImport
console.log(`\noRPC middleware hits: import-style call=${mwAfterImport}, HTTP call=${mwAfterHttp} (same .use() on both paths)`)
const rowsI: [string, string][] = [
  ['in-process call is a typed function (no Request)', 'typedCall'],
  ['defaults applied in-process', 'defaultApplied'],
  ['invalid input rejected in-process', 'invalidRejected'],
  ['SSE content-type', 'sseContentType'],
  ['SSE events received (want 4)', 'sseEvents'],
  ['SSE on unknown run: status + content-type (want 404 json)', 'sseUnknownRun'],
  ['GET /runs/{id} via fetch handler, req/s', 'rps'],
  ['cold start: bun + import + build + emit spec (ms, median of 5)', 'coldMs'],
  ['emit OpenAPI (ms)', 'specMs'],
]
table(
  'Runtime',
  ['check', ...names],
  rowsI.map(([label, key]) => [label, ...names.map((n) => inproc[n]![key]!)]),
)

// ---- 3. spike-7 runner (cli/agw-poc.ts, copied unmodified) against each emitted document ----------------
async function cli(n: string, argv: string[], env: Record<string, string> = {}) {
  const outL: string[] = []
  const errL: string[] = []
  const fw = fws[n]!
  const ctx: Ctx = {
    fetch: ((url: string, init: RequestInit) => fw.fetch(new Request(url.replace('http://app.local', 'http://localhost'), init))) as typeof fetch,
    env: { AGW_POLL_MS: '30', ...env },
    keychain: () => null,
    readFile: (p) => readFileSync(p),
    isTTY: false,
    out: (s) => outL.push(s),
    err: (s) => errL.push(s),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
    configPath: join(out, `${n}.gateways.json`),
  }
  const code = await agw(argv, ctx)
  return { code, out: outL.join(''), err: errL.join('') }
}
const errOf = (r: { err: string }) => {
  try {
    return JSON.parse(r.err.trim().split('\n').at(-1) ?? '{}').error ?? {}
  } catch {
    return {}
  }
}
const cliRes: Record<string, Record<string, string | number | boolean>> = {}
const cliNames = [...names, 'elysia-mapjson']
for (const n of cliNames) {
  const schema = await cli(n, ['schema', 'research', 'run'])
  const s = JSON.parse(schema.out)
  const cmds = JSON.parse((await cli(n, ['schema'])).out).gateways.research.commands.map((c: J) => c.command)
  const quick = await cli(n, ['research', 'run', 'abc def', '--depth', 'quick', '--commit'])
  const defaulted = await cli(n, ['research', 'run', 'abc def', '--commit'], { AGW_WAIT_BUDGET_S: '0.1' }) // depth omitted -> server default (standard, 120ms)
  const pending = await cli(n, ['research', 'run', 'abc def', '--depth', 'deep', '--commit'], { AGW_WAIT_BUDGET_S: '0.1' })
  const hint = errOf(pending).hint as string | undefined
  const resumed = pending.code === EXIT.pending && hint ? await cli(n, hint.replace(/^agw-poc /, '').split(' ')) : { code: -1, out: '', err: '' }
  const unionFlag = await cli(n, ['research', 'run', 'abc def', '--depth', 'quick', '--source', '{"kind":"web"}', '--commit'])
  const notFound = await cli(n, ['research', 'status', 'nope'])
  const badEnum = await cli(n, ['research', 'run', 'abc def', '--depth', 'huge', '--commit'])
  cliRes[n] = {
    commands: cmds.join(', '),
    'run flags': Object.keys(s.input.properties).join(','),
    'required flags': JSON.stringify(s.input.required),
    'run quick -> exit': quick.code,
    'run w/o --depth -> exit (0|10 = ok)': defaulted.code,
    'deep, tiny budget -> exit (want 10)': pending.code,
    'resume hint is exact': hint ?? '(none)',
    'resume -> exit (want 0)': resumed.code,
    'status nope -> exit (want 4)': notFound.code,
    'status nope -> message': errOf(notFound).message ?? '(none)',
    '--depth huge -> exit (want 2)': badEnum.code,
    "--source '{json}' (union flag) -> exit (want 0)": unionFlag.code,
  }
}
table(
  'CLI generator (spike-7 runner, unmodified)',
  ['check', ...cliNames],
  Object.keys(cliRes.orpc!).map((k) => [k, ...cliNames.map((n) => `${cliRes[n]![k]}`)]),
)

// ---- 4. footprint ----------------------------------------------------------------------------------------
const nm = join(root, 'node_modules')
const pkgDir = (name: string) => join(nm, name)
const closure = (roots: string[]) => {
  const seen = new Set<string>()
  const walk = (name: string) => {
    if (seen.has(name) || !existsSync(join(pkgDir(name), 'package.json'))) return
    seen.add(name)
    const p = JSON.parse(readFileSync(join(pkgDir(name), 'package.json'), 'utf8'))
    const requiredPeers = Object.keys(p.peerDependencies ?? {}).filter((d) => !p.peerDependenciesMeta?.[d]?.optional)
    for (const d of [...Object.keys(p.dependencies ?? {}), ...requiredPeers]) walk(d)
  }
  roots.forEach(walk)
  return seen
}
const dirSize = (d: string): number =>
  readdirSync(d, { withFileTypes: true }).reduce((a, e) => a + (e.isDirectory() ? dirSize(join(d, e.name)) : statSync(join(d, e.name)).size), 0)
const stacks: Record<string, string[]> = {
  orpc: ['@orpc/server', '@orpc/openapi', '@orpc/zod'],
  elysia: ['elysia', '@elysia/openapi'],
  hono: ['hono', '@hono/zod-openapi'],
}
const loc = (f: string) =>
  readFileSync(join(root, 'src', f), 'utf8')
    .split('\n')
    .filter((l) => l.trim() && !l.trim().startsWith('//')).length
const foot: Record<string, Record<string, string | number>> = {}
for (const n of names) {
  const c = closure(stacks[n]!)
  // zod and typescript are shared by every candidate (typescript is a non-optional peer of @elysia/openapi, a build tool here)
  c.delete('zod')
  c.delete('typescript')
  foot[n] = {
    'wiring LOC (src/<fw>.ts)': loc(`${n}.ts`),
    'prod packages in closure (deps + required peers, excl. zod, typescript)': c.size,
    'unpacked size, MB': (Array.from(c).reduce((a, p) => a + dirSize(pkgDir(p)), 0) / 1e6).toFixed(1),
  }
}
table(
  'Footprint',
  ['metric', ...names],
  Object.keys(foot.orpc!).map((k) => [k, ...names.map((n) => foot[n]![k]!)]),
)

// ---- 5. toolchain ------------------------------------------------------------------------------------------
const bin = (b: string) => join(nm, '.bin', b)
function time(cmd: string[], runs = 5) {
  const ms: number[] = []
  let last = { code: 0, text: '' }
  for (let i = 0; i < runs; i++) {
    const t = performance.now()
    const r = Bun.spawnSync(cmd, { cwd: root, stdout: 'pipe', stderr: 'pipe', timeout: 120_000 })
    ms.push(performance.now() - t)
    last = { code: r.exitCode ?? -1, text: `${r.stdout.toString()}${r.stderr.toString()}` }
  }
  ms.sort((a, b) => a - b)
  return { ms: Math.round(ms[Math.floor(ms.length / 2)]!), ...last }
}
const diag = (t: string) => {
  const tsErrors = (t.match(/error TS/g) ?? []).length
  if (tsErrors) return `${tsErrors} TS errors`
  const line = t
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^(Found|Checked|Finished|Ran|\d+ pass|Tests |Test Files|Finished in)/.test(l))
  return line.length ? line.slice(-2).join('; ') : 'clean (no output)'
}
const tools: [string, string[]][] = [
  ['tsc 7.0 (native) --noEmit', [bin('tsc'), '--noEmit']],
  ['tsc 6.0 (@typescript/typescript6) --noEmit', [bin('tsc6'), '--noEmit']],
  ['bun test (3 frameworks, 6 tests)', ['bun', 'test', './tests/proto.bun.test.ts']],
  ['vitest run (same tests)', [bin('vitest'), 'run']],
  ['biome check (lint+format)', [bin('biome'), 'check', 'src', 'tests']],
  ['oxlint (no type info)', [bin('oxlint'), '-c', '.oxlintrc.json', 'src', 'tests']],
  ['oxlint --type-aware', [bin('oxlint'), '-c', '.oxlintrc.json', '--type-aware', 'src', 'tests']],
  ['oxfmt --check', [bin('oxfmt'), '--check', 'src', 'tests']],
]
const rowsT = tools.map(([label, cmd]) => {
  const r = time(cmd)
  return [label, r.ms, r.code, diag(r.text)]
})
table('Toolchain (median of 5, wall ms, incl. process start)', ['tool', 'ms', 'exit', 'diagnostics'], rowsT)

// does each linter catch the seeded floating promise?
const catches = (cmd: string[], needle: RegExp) =>
  needle.test(((r) => `${r.stdout.toString()}${r.stderr.toString()}`)(Bun.spawnSync(cmd, { cwd: root, timeout: 120_000 })))
table(
  'Seeded type-aware defect (lint-fixtures/bad.ts: floating promise + async forEach)',
  ['linter', 'flags no-floating-promises', 'flags no-misused-promises'],
  [
    [
      'biome (nursery + types domain)',
      catches([bin('biome'), 'lint', 'lint-fixtures'], /noFloatingPromises/),
      catches([bin('biome'), 'lint', 'lint-fixtures'], /noMisusedPromises/),
    ],
    [
      'oxlint --type-aware',
      catches([bin('oxlint'), '-c', '.oxlintrc.json', '--type-aware', 'lint-fixtures'], /no-floating-promises/),
      catches([bin('oxlint'), '-c', '.oxlintrc.json', '--type-aware', 'lint-fixtures'], /no-misused-promises/),
    ],
  ],
)
console.log(`\nexit codes table in use: pending=${EXIT.pending}`)
