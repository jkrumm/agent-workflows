// The OpenAPI document is external JSON: every shape below is read defensively, never trusted.
import { createHash } from 'node:crypto'

export interface Schema {
  type?: string | string[]
  enum?: unknown[]
  const?: unknown
  properties?: Record<string, Schema>
  required?: string[]
  anyOf?: Schema[]
  oneOf?: Schema[]
  $ref?: string
  description?: string
  default?: unknown
  [key: string]: unknown
}

export interface XCli {
  command: string[]
  positional: string[]
  mutating: boolean
  defaultFormat: 'json' | 'plain'
  stdin?: string
  plainField?: string
  kind: 'capability' | 'workflow' | 'run'
  resume?: { command: string[]; positional: string[] }
}

interface Parameter {
  name: string
  in: string
  required?: boolean
  schema?: Schema
  description?: string
}

interface Operation {
  operationId?: string
  summary?: string
  description?: string
  parameters?: Parameter[]
  requestBody?: { content?: Record<string, { schema?: Schema }> }
  responses?: Record<string, { content?: Record<string, { schema?: Schema }> }>
  'x-cli'?: Partial<XCli>
}

export interface Document {
  openapi?: string
  info?: { title?: string; version?: string; 'x-contract-sha'?: string }
  paths?: Record<string, Record<string, Operation>>
  components?: Record<string, unknown>
  [key: string]: unknown
}

/** One input property: where it goes on the wire and how argv turns into its value. */
export interface Field {
  name: string
  flag: string
  in: 'path' | 'query' | 'body'
  schema: Schema
  required: boolean
}

export interface Command {
  words: string[]
  method: string
  path: string
  summary: string
  description: string
  x: XCli
  fields: Field[]
  hasBody: boolean
  output: Schema | undefined
}

const METHODS = ['get', 'post', 'put', 'patch', 'delete']

/** Always the CLI's own flags; an operation with an input property of one of these names is skipped. */
export const RESERVED_FLAGS: readonly string[] = ['format', 'commit', 'idempotency-key', 'help']

/** An operation the CLI could not turn into a command, and why; `agw schema` lists it. */
export interface Skipped {
  operation: string
  command?: string
  reason: string
}

export const kebab = (name: string) => name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value === null || typeof value !== 'object') return value
  const sorted: Record<string, unknown> = {}
  for (const key of Object.keys(value).sort()) sorted[key] = canonical((value as Record<string, unknown>)[key])
  return sorted
}

/** sha256 hex of the canonical JSON (keys sorted recursively, no whitespace) without `info['x-contract-sha']`. */
export function contractSha(doc: Document): string {
  const { 'x-contract-sha': _, ...info } = doc.info ?? {}
  const body = JSON.stringify(canonical({ ...doc, ...(doc.info ? { info } : {}) }))
  return createHash('sha256').update(body).digest('hex')
}

export const servedSha = (doc: Document) => doc.info?.['x-contract-sha'] ?? contractSha(doc)

function pointer(doc: Document, ref: string): unknown {
  if (!ref.startsWith('#/')) return undefined
  let node: unknown = doc
  for (const raw of ref.slice(2).split('/')) {
    const key = raw.replaceAll('~1', '/').replaceAll('~0', '~')
    node = node !== null && typeof node === 'object' ? (node as Record<string, unknown>)[key] : undefined
  }
  return node
}

/** Inlines every local `$ref`. A recursive schema keeps its `$ref` where it would loop. */
export function deref(doc: Document, value: unknown, seen: ReadonlySet<string> = new Set()): unknown {
  if (Array.isArray(value)) return value.map((v) => deref(doc, v, seen))
  if (value === null || typeof value !== 'object') return value
  const node = value as Record<string, unknown>
  if (typeof node.$ref === 'string') {
    const ref = node.$ref
    const target = pointer(doc, ref)
    if (seen.has(ref) || target === undefined) return node
    const { $ref: _, ...siblings } = node
    const resolved = deref(doc, target, new Set([...seen, ref]))
    return Object.keys(siblings).length
      ? { ...(resolved as object), ...(deref(doc, siblings, seen) as object) }
      : resolved
  }
  return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, deref(doc, v, seen)]))
}

const KINDS: readonly string[] = ['capability', 'workflow', 'run']
const WORD = /^[A-Za-z0-9][\w.-]*$/

const words = (v: unknown): string[] | undefined =>
  Array.isArray(v) && v.every((w) => typeof w === 'string' && WORD.test(w)) ? (v as string[]) : undefined

const names = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [])

/** An `x-cli` block the CLI cannot honour (no valid words, an unknown kind) skips the operation. */
function readXCli(raw: Partial<XCli>): XCli | string {
  const command = words(raw.command)
  const kind = raw.kind ?? 'capability'
  if (!command?.length) return 'x-cli.command has no valid command words'
  if (!KINDS.includes(kind)) return `unknown x-cli.kind "${String(kind)}"`
  const resumeWords = raw.resume ? words(raw.resume.command) : undefined
  return {
    command,
    positional: names(raw.positional),
    mutating: raw.mutating === true,
    defaultFormat: raw.defaultFormat === 'json' ? 'json' : 'plain',
    ...(typeof raw.stdin === 'string' ? { stdin: raw.stdin } : {}),
    ...(typeof raw.plainField === 'string' ? { plainField: raw.plainField } : {}),
    kind,
    ...(resumeWords?.length ? { resume: { command: resumeWords, positional: names(raw.resume?.positional) } } : {}),
  }
}

function buildCommand(doc: Document, path: string, method: string, op: Operation, x: XCli): Command | string {
  const fields: Field[] = []
  for (const p of Array.isArray(op.parameters) ? op.parameters : []) {
    if ((p?.in !== 'path' && p?.in !== 'query') || typeof p.name !== 'string') continue
    const schema = deref(doc, { ...(p.schema ?? {}), ...(p.description ? { description: p.description } : {}) })
    fields.push({
      name: p.name,
      flag: kebab(p.name),
      in: p.in,
      schema: schema as Schema,
      required: p.in === 'path' || p.required === true,
    })
  }
  const body = deref(doc, op.requestBody?.content?.['application/json']?.schema) as Schema | undefined
  for (const [name, schema] of Object.entries(body?.properties ?? {})) {
    fields.push({
      name,
      flag: kebab(name),
      in: 'body',
      schema: schema ?? {},
      required: (body?.required ?? []).includes(name),
    })
  }
  const reserved = fields.find((f) => !x.positional.includes(f.name) && RESERVED_FLAGS.includes(f.flag))
  if (reserved) return `input property "${reserved.name}" collides with the reserved flag --${reserved.flag}`
  const ok = op.responses?.['200'] ?? op.responses?.['202']
  return {
    words: x.command,
    method: method.toUpperCase(),
    path,
    summary: typeof op.summary === 'string' ? op.summary : '',
    description: typeof op.description === 'string' ? op.description : '',
    x,
    fields,
    hasBody: op.requestBody !== undefined,
    output: deref(doc, ok?.content?.['application/json']?.schema) as Schema | undefined,
  }
}

/**
 * Every operation carrying a usable `x-cli` becomes one command; nothing per command is written by
 * hand. An operation the CLI cannot read is skipped with its reason and never takes the others down.
 */
export function buildCommands(doc: Document): { commands: Command[]; skipped: Skipped[] } {
  const commands: Command[] = []
  const skipped: Skipped[] = []
  const taken = new Set<string>()
  const paths = doc.paths !== null && typeof doc.paths === 'object' ? doc.paths : {}
  for (const [path, rawItem] of Object.entries(paths)) {
    const item = deref(doc, rawItem)
    if (item === null || typeof item !== 'object') continue
    for (const [method, rawOp] of Object.entries(item as Record<string, unknown>)) {
      if (!METHODS.includes(method) || rawOp === null || typeof rawOp !== 'object') continue
      const op = deref(doc, rawOp) as Operation
      if (!op['x-cli']) continue
      const operation = `${method.toUpperCase()} ${path}`
      const x = readXCli(op['x-cli'])
      if (typeof x === 'string') {
        skipped.push({ operation, reason: x })
        continue
      }
      const command = x.command.join(' ')
      const skip = (reason: string) => skipped.push({ operation, command, reason })
      if (taken.has(command)) {
        skip('another operation already maps to this command')
        continue
      }
      try {
        const built = buildCommand(doc, path, method, op, x)
        if (typeof built === 'string') skip(built)
        else {
          commands.push(built)
          taken.add(command)
        }
      } catch (error) {
        skip(`malformed operation: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }
  return { commands, skipped }
}

/** The longest command whose words prefix argv. */
export function resolveCommand(commands: Command[], argv: string[]): { command: Command; rest: string[] } | undefined {
  let best: Command | undefined
  for (const c of commands) {
    if (c.words.length > argv.length || !c.words.every((w, i) => argv[i] === w)) continue
    if (!best || c.words.length > best.words.length) best = c
  }
  return best ? { command: best, rest: argv.slice(best.words.length) } : undefined
}

/** For an unknown command: the words that could follow the longest known prefix. */
export function nextWords(commands: Command[], argv: string[]): { prefix: string[]; options: string[] } {
  const words = argv.filter((w) => !w.startsWith('-'))
  for (let n = words.length; n >= 0; n--) {
    const prefix = words.slice(0, n)
    const below = commands.filter((c) => c.words.length > n && prefix.every((w, i) => c.words[i] === w))
    if (below.length) return { prefix, options: [...new Set(below.map((c) => c.words[n] as string))].sort() }
  }
  return { prefix: [], options: [] }
}

/**
 * How a command waits on a run: a workflow resumes with its `x-cli.resume`, and the command a resume
 * names (`run wait`) resumes with itself. Anything else returns its answer as is.
 */
export function waitPlan(commands: Command[], command: Command): { resume: XCli['resume'] } | undefined {
  if (command.x.kind === 'workflow') return { resume: command.x.resume }
  const key = command.words.join(' ')
  if (!commands.some((c) => c.x.resume?.command.join(' ') === key)) return undefined
  return { resume: { command: command.words, positional: command.x.positional } }
}
