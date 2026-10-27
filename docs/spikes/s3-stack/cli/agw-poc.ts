#!/usr/bin/env node
// agw-poc: ONE generic runner that turns a gateway's OpenAPI document (+ `x-cli` per operation)
// into a CLI implementing the ADR-004 agent contract. No per-route code: a new route in the spec
// is a new command. Runs unchanged under `node` (>= 22.18, native type stripping) and `bun`.

import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// The spec is untyped JSON by design (any OpenAPI document); every access below is guarded.
// biome-ignore lint/suspicious/noExplicitAny: spec JSON is external and schema-less here
type J = any

const BIN = 'agw-poc'
const here = dirname(fileURLToPath(import.meta.url))

// ── Exit codes (ADR-004 item 3). THE table; changing it is a breaking change. ────────────────
export const EXIT = {
  ok: 0,
  general: 1,
  usage: 2,
  auth: 3,
  not_found: 4,
  conflict: 5,
  confirmation_required: 6,
  network: 7,
  rate_limited: 8,
  contract_mismatch: 9,
  pending: 10,
} as const
export type ErrorKind = Exclude<keyof typeof EXIT, 'ok'>

export class AgwError extends Error {
  kind: ErrorKind
  hint: string
  retryable: boolean
  details: Record<string, unknown>
  constructor(kind: ErrorKind, message: string, o: { hint?: string; retryable?: boolean; details?: Record<string, unknown> } = {}) {
    super(message)
    this.kind = kind
    this.hint = o.hint ?? ''
    this.retryable = o.retryable ?? false
    this.details = o.details ?? {}
  }
  get exitCode(): number {
    return EXIT[this.kind]
  }
  errorLine(): string {
    return JSON.stringify({ error: { kind: this.kind, message: this.message, hint: this.hint, retryable: this.retryable, details: this.details } })
  }
}
const usage = (message: string, hint = '') => new AgwError('usage', message, { hint })

// ── Spec → commands ───────────────────────────────────────────────────────────────────────────
export interface Flag {
  prop: string
  flag: string
  loc: 'path' | 'query' | 'body'
  schema: J
  required: boolean
}
export interface Command {
  kind: 'call' | 'job' | 'wait'
  path: string[]
  gateway: string
  op: J
  method: string
  urlPath: string
  flags: Flag[]
  positional: string[]
  xcli: J
  mutating: boolean
  summary: string
  statusCmd?: Command
}

const kebab = (s: string) => s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)

export function buildCommands(spec: J): Command[] {
  const cmds: Command[] = []
  for (const [urlPath, item] of Object.entries<J>(spec.paths ?? {})) {
    for (const [method, op] of Object.entries<J>(item)) {
      const x = op?.['x-cli']
      if (!x) continue
      const flags: Flag[] = []
      for (const p of op.parameters ?? []) {
        if (p.in !== 'path' && p.in !== 'query') continue
        flags.push({ prop: p.name, flag: kebab(p.name), loc: p.in, schema: p.schema ?? {}, required: p.required === true || p.in === 'path' })
      }
      const body = op.requestBody?.content?.['application/json']?.schema
      for (const [prop, schema] of Object.entries<J>(body?.properties ?? {})) {
        flags.push({ prop, flag: kebab(prop), loc: 'body', schema, required: (body.required ?? []).includes(prop) })
      }
      cmds.push({
        kind: x.job ? 'job' : 'call',
        path: x.command,
        gateway: x.command[0],
        op,
        method: method.toUpperCase(),
        urlPath,
        flags,
        positional: x.positional ?? flags.filter((f) => f.loc === 'path').map((f) => f.prop),
        xcli: x,
        mutating: x.mutating === true,
        summary: op.summary ?? '',
      })
    }
  }
  // `wait` is declared, not coded: x-cli.job.resume.command names it; it polls statusOperationId.
  for (const c of [...cmds]) {
    const job = c.xcli.job
    if (!job) continue
    const statusCmd = cmds.find((s) => s.op.operationId === job.statusOperationId)
    if (!statusCmd) throw new Error(`x-cli.job.statusOperationId ${job.statusOperationId} not found`)
    cmds.push({ ...statusCmd, kind: 'wait', path: job.resume.command, xcli: { ...statusCmd.xcli, job }, summary: `Block until the job from '${c.path.join(' ')}' is terminal (resume after pending)`, statusCmd })
  }
  return cmds
}

// ── Argv → values ─────────────────────────────────────────────────────────────────────────────
export interface Globals {
  format?: string
  commit: boolean
  dryRun: boolean
  wait?: boolean
  help: boolean
}
export interface Parsed {
  values: Record<string, unknown>
  globals: Globals
}

function globalFlags(cmd: Command): string[] {
  return ['format', ...(cmd.mutating ? ['commit', 'dry-run'] : []), ...(cmd.kind !== 'call' ? ['wait', 'no-wait'] : [])]
}
export function validFlags(cmd: Command): string[] {
  return [...cmd.flags.map((f) => f.flag), ...globalFlags(cmd), 'help'].map((f) => `--${f}`)
}

function coerce(f: Flag, raw: string): unknown {
  const s = f.schema
  const bad = (why: string) => usage(`--${f.flag} ${why}, got: ${raw}`, `see '${BIN} schema' for the input schema`)
  switch (s.type) {
    case 'integer':
    case 'number': {
      const n = Number(raw)
      if (raw.trim() === '' || Number.isNaN(n) || (s.type === 'integer' && !Number.isInteger(n))) throw bad(`must be ${s.type === 'integer' ? 'an integer' : 'a number'}`)
      return n
    }
    case 'boolean':
      if (raw !== 'true' && raw !== 'false') throw bad('must be true or false')
      return raw === 'true'
    default: {
      if (Array.isArray(s.enum) && !s.enum.includes(raw)) throw bad(`must be one of ${s.enum.join(' | ')}`)
      if (s.minLength !== undefined && raw.length < s.minLength) throw bad(`must be at least ${s.minLength} characters`)
      if (s.maxLength !== undefined && raw.length > s.maxLength) throw bad(`must be at most ${s.maxLength} characters`)
      return raw
    }
  }
}

export function parseArgv(cmd: Command, tokens: string[]): Parsed {
  const byFlag = new Map(cmd.flags.map((f) => [f.flag, f]))
  const allowed = new Set(globalFlags(cmd))
  const globals: Globals = { commit: false, dryRun: false, help: false }
  const values: Record<string, unknown> = {}
  const pos: string[] = []
  const unknown = (t: string) => usage(`unknown flag ${t}`, `valid flags: ${validFlags(cmd).join(' ')}`)

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i] as string
    if (t === '--') {
      pos.push(...tokens.slice(i + 1))
      break
    }
    if (t === '-h') {
      globals.help = true
      continue
    }
    if (!t.startsWith('--')) {
      if (t.startsWith('-') && t !== '-') throw unknown(t)
      pos.push(t)
      continue
    }
    const eq = t.indexOf('=')
    const name = eq < 0 ? t.slice(2) : t.slice(2, eq)
    const inline = eq < 0 ? undefined : t.slice(eq + 1)
    const take = (): string => {
      if (inline !== undefined) return inline
      const next = tokens[i + 1]
      if (next === undefined) throw usage(`--${name} requires a value`, `valid flags: ${validFlags(cmd).join(' ')}`)
      i++
      return next
    }
    if (name === 'help') globals.help = true
    else if (allowed.has(name) && name === 'format') {
      globals.format = take()
      if (globals.format !== 'json' && globals.format !== 'plain') throw usage(`--format must be one of json | plain, got: ${globals.format}`)
    } else if (allowed.has(name) && name === 'commit') globals.commit = true
    else if (allowed.has(name) && name === 'dry-run') globals.dryRun = true
    else if (allowed.has(name) && name === 'wait') globals.wait = true
    else if (allowed.has(name) && name === 'no-wait') globals.wait = false
    else {
      const f = byFlag.get(name)
      if (!f) throw unknown(t)
      const raw = f.schema.type === 'boolean' && inline === undefined ? 'true' : take()
      if (f.schema.type === 'array') values[f.prop] = [...((values[f.prop] as unknown[]) ?? []), ...raw.split(',')]
      else values[f.prop] = coerce(f, raw)
    }
  }
  if (globals.help) return { values, globals }

  if (pos.length > cmd.positional.length) throw usage(`unexpected argument '${pos[cmd.positional.length]}'`, `usage: ${usageLine(cmd)}`)
  cmd.positional.forEach((prop, i) => {
    const raw = pos[i]
    if (raw === undefined) return
    const f = byFlag.get(kebab(prop))
    if (f) values[prop] = coerce(f, raw)
  })
  const missing = cmd.flags.filter((f) => f.required && values[f.prop] === undefined)
  if (missing.length > 0) throw usage(`missing required: ${missing.map((f) => (cmd.positional.includes(f.prop) ? `<${f.prop}>` : `--${f.flag}`)).join(', ')}`, `usage: ${usageLine(cmd)}`)
  return { values, globals }
}

export function usageLine(cmd: Command): string {
  const pos = cmd.positional.map((p) => `<${p}>`).join(' ')
  const opts = cmd.flags
    .filter((f) => !cmd.positional.includes(f.prop))
    .map((f) => {
      const v = Array.isArray(f.schema.enum) ? f.schema.enum.join('|') : (f.schema.type ?? 'value')
      return f.required ? `--${f.flag} <${v}>` : `[--${f.flag} <${v}>]`
    })
  const g = [...(cmd.mutating ? ['[--commit|--dry-run]'] : []), ...(cmd.kind !== 'call' ? ['[--no-wait]'] : []), '[--format json|plain]']
  return [BIN, ...cmd.path, pos, ...opts, ...g].filter(Boolean).join(' ')
}

// ── Values → request ──────────────────────────────────────────────────────────────────────────
export interface Req {
  method: string
  path: string
  body?: Record<string, unknown>
}
export function buildRequest(cmd: Command, values: Record<string, unknown>): Req {
  let path = cmd.urlPath
  const query = new URLSearchParams()
  const body: Record<string, unknown> = {}
  for (const f of cmd.flags) {
    const v = values[f.prop]
    if (v === undefined) continue
    if (f.loc === 'path') path = path.replace(`{${f.prop}}`, encodeURIComponent(String(v)))
    else if (f.loc === 'query') query.set(f.prop, String(v))
    else body[f.prop] = v
  }
  const qs = query.toString()
  const hasBody = cmd.op.requestBody !== undefined
  return { method: cmd.method, path: qs ? `${path}?${qs}` : path, ...(hasBody ? { body } : {}) }
}

// ── HTTP → errors ─────────────────────────────────────────────────────────────────────────────
function errorMessage(data: J, status: number): string {
  const e = data?.error
  if (typeof e === 'string') return e
  if (typeof e?.message === 'string') return e.message
  if (typeof data?.summary === 'string') return data.summary
  return `HTTP ${status}`
}

export function mapHttpError(status: number, data: J, headers: { get(n: string): string | null }): AgwError {
  const message = errorMessage(data, status)
  const retryAfter = headers.get('retry-after')
  const details: Record<string, unknown> = { status, ...(retryAfter ? { retryAfterS: Number(retryAfter) } : {}) }
  if (status === 412 || data?.error?.kind === 'contract_mismatch') {
    return new AgwError('contract_mismatch', message, { hint: data?.error?.hint ?? `refresh the cached spec: reinstall ${BIN} or re-fetch <baseUrl>/openapi.json`, details: { ...details, ...(data?.error?.details ?? {}) } })
  }
  if (status === 401 || status === 403) return new AgwError('auth', message, { hint: 'set the gateway bearer token (see gateways.json auth: env var, then macOS Keychain)', details })
  if (status === 404) return new AgwError('not_found', message, { details })
  if (status === 409) return new AgwError('conflict', message, { details })
  if (status === 429) return new AgwError('rate_limited', message, { retryable: true, hint: retryAfter ? `retry after ${retryAfter}s` : 'retry later', details })
  if (status === 400 || status === 422) return new AgwError('usage', message, { hint: `see '${BIN} schema <command>'`, details })
  if (status >= 500) return new AgwError('general', message, { retryable: true, hint: status === 503 && retryAfter ? `unavailable; retry after ${retryAfter}s` : 'server error; retry', details })
  return new AgwError('general', message, { details })
}

// ── Context (injected in tests) ───────────────────────────────────────────────────────────────
export interface Ctx {
  fetch: typeof fetch
  env: Record<string, string | undefined>
  keychain: (service: string) => string | null
  readFile: (path: string) => Buffer
  isTTY: boolean
  out: (s: string) => void
  err: (s: string) => void
  sleep: (ms: number) => Promise<void>
  now: () => number
  configPath: string
}
interface Gateway {
  name: string
  baseUrl: string
  auth: { bearerEnv?: string; keychainService?: string }
  spec: J
  sha: string
  commands: Command[]
}

function loadGateways(ctx: Ctx): Gateway[] {
  const cfg = JSON.parse(ctx.readFile(ctx.configPath).toString('utf8'))
  return Object.entries<J>(cfg).map(([name, g]) => {
    const raw = ctx.readFile(resolve(dirname(ctx.configPath), g.spec))
    const spec = JSON.parse(raw.toString('utf8'))
    const baseUrl = (ctx.env[`AGW_${name.toUpperCase()}_URL`] ?? g.baseUrl).replace(/\/+$/, '')
    return { name, baseUrl, auth: g.auth ?? {}, spec, sha: createHash('sha256').update(raw).digest('hex'), commands: buildCommands(spec) }
  })
}

export function resolveToken(auth: Gateway['auth'], ctx: Pick<Ctx, 'env' | 'keychain'>): string | null {
  const fromEnv = auth.bearerEnv ? ctx.env[auth.bearerEnv]?.trim() : undefined
  if (fromEnv) return fromEnv
  return auth.keychainService ? ctx.keychain(auth.keychainService) : null
}

async function send(ctx: Ctx, gw: Gateway, cmd: Command, req: Req): Promise<J> {
  const needsAuth = (cmd.op.security ?? gw.spec.security ?? []).length > 0
  const headers: Record<string, string> = { accept: 'application/json', 'x-contract-sha': gw.sha }
  if (needsAuth) {
    const token = resolveToken(gw.auth, ctx)
    if (!token) throw new AgwError('auth', 'no bearer token', { hint: `set ${gw.auth.bearerEnv ?? 'the token env var'}${gw.auth.keychainService ? ` or store macOS Keychain generic password service "${gw.auth.keychainService}"` : ''}` })
    headers.authorization = `Bearer ${token}`
  }
  if (req.body !== undefined) headers['content-type'] = 'application/json'
  let res: Response
  try {
    res = await ctx.fetch(gw.baseUrl + req.path, { method: req.method, headers, ...(req.body !== undefined ? { body: JSON.stringify(req.body) } : {}), signal: AbortSignal.timeout(30_000) })
  } catch (e) {
    throw new AgwError('network', `${gw.name} unreachable at ${gw.baseUrl}: ${e instanceof Error ? e.message : String(e)}`, { retryable: true, hint: 'check the gateway is up and reachable, then retry' })
  }
  const text = await res.text()
  let data: J = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = { error: text.slice(0, 200) }
  }
  if (!res.ok) throw mapHttpError(res.status, data, res.headers)
  return data
}

// ── Output ────────────────────────────────────────────────────────────────────────────────────
const dig = (o: J, path: string): unknown => path.split('.').reduce((a, k) => a?.[k], o)

export function render(data: J, format: string, cmd: Command): string {
  if (format === 'json') return JSON.stringify(data)
  const field = cmd.xcli.plainField ? dig(data, cmd.xcli.plainField) : undefined
  if (typeof field === 'string') return field
  return Object.entries(data ?? {})
    .filter(([, v]) => v === null || typeof v !== 'object')
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n')
}

// ── Execution ─────────────────────────────────────────────────────────────────────────────────
function budgetS(env: Ctx['env']): number {
  const n = Number(env.AGW_WAIT_BUDGET_S)
  return Number.isFinite(n) && n > 0 ? n : 110
}

async function waitForJob(ctx: Ctx, gw: Gateway, cmd: Command, jobId: string, startMs: number, emit: (d: J) => void): Promise<number> {
  const job = cmd.xcli.job
  const statusCmd = cmd.statusCmd ?? gw.commands.find((c) => c.op.operationId === job.statusOperationId)!
  const budgetMs = budgetS(ctx.env) * 1000
  const pollMs = Number(ctx.env.AGW_POLL_MS) || 2000
  const resume = `${BIN} ${job.resume.command.join(' ')} ${jobId}`
  let last: J = null
  let netErr: AgwError | null = null
  for (;;) {
    try {
      last = { [job.idField]: jobId, ...(await send(ctx, gw, statusCmd, buildRequest(statusCmd, { [statusCmd.positional[0] as string]: jobId }))) }
      netErr = null
      if (job.terminal.includes(last[job.statusField])) {
        emit(last)
        if (last[job.statusField] === job.successStatus) return EXIT.ok
        throw new AgwError('general', `job ${last[job.statusField]}: ${last.error ?? 'no reason given'}`, { hint: `${BIN} ${statusCmd.path.join(' ')} ${jobId}`, details: { [job.idField]: jobId, status: last[job.statusField] } })
      }
    } catch (e) {
      if (!(e instanceof AgwError) || e.kind !== 'network') throw e
      netErr = e
    }
    const elapsed = ctx.now() - startMs
    if (elapsed + pollMs > budgetMs) break
    await ctx.sleep(pollMs)
  }
  if (last) emit(last)
  const elapsedS = Math.round((ctx.now() - startMs) / 1000)
  if (netErr) throw new AgwError('network', netErr.message, { retryable: true, hint: resume, details: { [job.idField]: jobId, elapsedS } })
  throw new AgwError('pending', `still ${last?.[job.statusField] ?? 'unknown'} after ${elapsedS}s (budget ${budgetS(ctx.env)}s); the job keeps running server-side`, {
    retryable: true,
    hint: resume,
    details: { [job.idField]: jobId, status: last?.[job.statusField], elapsedS, budgetS: budgetS(ctx.env) },
  })
}

async function execute(ctx: Ctx, gw: Gateway, cmd: Command, tokens: string[]): Promise<number> {
  const { values, globals } = parseArgv(cmd, tokens)
  if (globals.help) {
    ctx.out(`${usageLine(cmd)}\n\n${cmd.summary}\n${cmd.op.description ?? ''}\n`)
    return EXIT.ok
  }
  const format = globals.format ?? (ctx.isTTY ? (cmd.xcli.defaultFormat ?? 'json') : 'json')
  const emit = (d: J) => ctx.out(`${render(d, format, cmd)}\n`)
  const start = ctx.now()

  if (cmd.kind === 'wait') {
    return waitForJob(ctx, gw, cmd, String(values[cmd.positional[0] as string]), start, emit)
  }

  // Mutating: --commit or a typed refusal (non-TTY never gets a prompt, ADR-004 item 4).
  if (cmd.mutating && !globals.commit) {
    if (!globals.dryRun && !ctx.isTTY) throw new AgwError('confirmation_required', `${cmd.path.join(' ')} changes state`, { hint: `re-run with --commit (or --dry-run to preview): ${usageLine(cmd)}` })
    if (cmd.flags.some((f) => f.prop === 'idempotencyKey') && values.idempotencyKey === undefined) values.idempotencyKey = '<generated at commit>'
    ctx.out(`${JSON.stringify({ dryRun: true, request: { method: cmd.method, url: gw.baseUrl + buildRequest(cmd, values).path, body: buildRequest(cmd, values).body } })}\n`)
    return EXIT.ok
  }
  // An idempotency key is always sent on a committed mutation, so a retried call returns the original.
  if (cmd.mutating && cmd.flags.some((f) => f.prop === 'idempotencyKey') && values.idempotencyKey === undefined) values.idempotencyKey = randomUUID()

  const data = await send(ctx, gw, cmd, buildRequest(cmd, values))
  if (cmd.kind === 'job') {
    const job = cmd.xcli.job
    if (globals.wait === false) {
      emit(data)
      return EXIT.ok
    }
    return waitForJob(ctx, gw, { ...cmd, kind: 'job' }, String(data[job.idField]), start, emit)
  }
  emit(data)
  return EXIT.ok
}

// ── schema / help ─────────────────────────────────────────────────────────────────────────────
function inputSchema(cmd: Command): J {
  return {
    type: 'object',
    properties: Object.fromEntries(cmd.flags.map((f) => [f.prop, { ...f.schema, 'x-flag': `--${f.flag}`, 'x-in': f.loc }])),
    required: cmd.flags.filter((f) => f.required).map((f) => f.prop),
    'x-positional': cmd.positional,
  }
}
function describe(gw: Gateway, cmd: Command, full: boolean): J {
  const base = { command: cmd.path.join(' '), summary: cmd.summary, mutating: cmd.mutating, kind: cmd.kind, usage: usageLine(cmd) }
  if (!full) return base
  const responses = (cmd.statusCmd ?? cmd).op.responses ?? {}
  const schemaOf = (r: J) => r?.content?.['application/json']?.schema
  return {
    ...base,
    contractSha: gw.sha,
    input: inputSchema(cmd),
    output: schemaOf(responses['200']),
    errors: Object.fromEntries(Object.entries<J>(responses).filter(([s]) => s !== '200').map(([s, r]) => [s, schemaOf(r)])),
    'x-cli': cmd.xcli,
  }
}

function schemaCommand(ctx: Ctx, gateways: Gateway[], rest: string[], format: string): number {
  const print = (d: J) => ctx.out(`${format === 'plain' ? JSON.stringify(d, null, 2) : JSON.stringify(d)}\n`)
  if (rest.includes('--exit-codes')) {
    print({ exitCodes: EXIT })
    return EXIT.ok
  }
  const words = rest.filter((w) => !w.startsWith('--'))
  const flagged = rest.find((w) => w.startsWith('--'))
  if (flagged) throw usage(`unknown flag ${flagged}`, 'valid flags: --exit-codes --format')
  if (words.length === 0) {
    print({ exitCodes: EXIT, gateways: Object.fromEntries(gateways.map((g) => [g.name, { baseUrl: g.baseUrl, contractSha: g.sha, commands: g.commands.map((c) => describe(g, c, false)) }])) })
    return EXIT.ok
  }
  const gw = gateways.find((g) => g.name === words[0])
  if (!gw) throw usage(`unknown gateway '${words[0]}'`, `gateways: ${gateways.map((g) => g.name).join(', ')}`)
  const matches = gw.commands.filter((c) => words.every((w, i) => c.path[i] === w))
  if (matches.length === 0) throw usage(`unknown command '${words.join(' ')}'`, `commands: ${gw.commands.map((c) => c.path.join(' ')).join(', ')}`)
  print(matches.length === 1 && matches[0]!.path.length === words.length ? describe(gw, matches[0]!, true) : matches.map((c) => describe(gw, c, true)))
  return EXIT.ok
}

export async function run(argv: string[], ctx: Ctx): Promise<number> {
  try {
    const gateways = loadGateways(ctx)
    const [first, ...rest] = argv
    if (first === undefined || first === '--help' || first === '-h') {
      ctx.out(`${BIN} <gateway> <command> [args]   |   ${BIN} schema [gateway [command…]] [--exit-codes]\n\n${gateways.flatMap((g) => g.commands.map((c) => `  ${usageLine(c)}`)).join('\n')}\n`)
      return EXIT.ok
    }
    if (first === 'schema') {
      const i = rest.indexOf('--format')
      const format = i >= 0 ? (rest[i + 1] ?? 'json') : ctx.isTTY ? 'plain' : 'json'
      return schemaCommand(ctx, gateways, i >= 0 ? rest.filter((_, j) => j !== i && j !== i + 1) : rest, format)
    }
    const gw = gateways.find((g) => g.name === first)
    if (!gw) throw usage(`unknown gateway '${first}'`, `gateways: ${gateways.map((g) => g.name).join(', ')}; or '${BIN} schema'`)
    const cmd = gw.commands.find((c) => c.path.slice(1).every((w, i) => rest[i] === w) && rest.length >= c.path.length - 1)
    if (!cmd) throw usage(`unknown command '${[first, rest[0]].filter(Boolean).join(' ')}'`, `commands: ${gw.commands.map((c) => c.path.join(' ')).join(', ')}`)
    return await execute(ctx, gw, cmd, rest.slice(cmd.path.length - 1))
  } catch (e) {
    if (e instanceof AgwError) {
      ctx.err(`${e.errorLine()}\n`)
      return e.exitCode
    }
    const msg = e instanceof Error ? e.message : String(e)
    ctx.err(`${new AgwError('general', msg).errorLine()}\n`)
    return EXIT.general
  }
}

function keychain(service: string): string | null {
  try {
    return execFileSync('security', ['find-generic-password', '-s', service, '-w'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null
  } catch {
    return null
  }
}

if (import.meta.main) {
  process.exitCode = await run(process.argv.slice(2), {
    fetch,
    env: process.env,
    keychain,
    readFile: (p) => readFileSync(p),
    isTTY: process.stdout.isTTY === true,
    out: (s) => process.stdout.write(s),
    err: (s) => process.stderr.write(s),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
    configPath: process.env.AGW_CONFIG ?? resolve(here, 'gateways.json'),
  })
}
