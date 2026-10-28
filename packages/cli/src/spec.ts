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

function readXCli(raw: Partial<XCli>, path: string, method: string): XCli | undefined {
  if (!Array.isArray(raw.command) || raw.command.length === 0) return undefined
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [])
  const resume = raw.resume && Array.isArray(raw.resume.command) ? raw.resume : undefined
  const kinds = ['capability', 'workflow', 'run'] as const
  const kind = raw.kind ?? 'capability'
  if (!kinds.includes(kind)) throw new Error(`${method.toUpperCase()} ${path}: unknown x-cli.kind "${String(kind)}"`)
  return {
    command: strings(raw.command),
    positional: strings(raw.positional),
    mutating: raw.mutating === true,
    defaultFormat: raw.defaultFormat === 'json' ? 'json' : 'plain',
    ...(typeof raw.stdin === 'string' ? { stdin: raw.stdin } : {}),
    ...(typeof raw.plainField === 'string' ? { plainField: raw.plainField } : {}),
    kind,
    ...(resume ? { resume: { command: strings(resume.command), positional: strings(resume.positional) } } : {}),
  }
}

/** Every operation carrying `x-cli` becomes one command; nothing per command is written by hand. */
export function buildCommands(doc: Document): Command[] {
  const commands: Command[] = []
  const taken = new Set<string>()
  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    for (const [method, op] of Object.entries(item ?? {})) {
      if (!METHODS.includes(method) || !op?.['x-cli']) continue
      const x = readXCli(op['x-cli'], path, method)
      if (!x || taken.has(x.command.join(' '))) continue
      taken.add(x.command.join(' '))
      const fields: Field[] = []
      for (const p of op.parameters ?? []) {
        if (p.in !== 'path' && p.in !== 'query') continue
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
        fields.push({ name, flag: kebab(name), in: 'body', schema, required: (body?.required ?? []).includes(name) })
      }
      const ok = op.responses?.['200'] ?? op.responses?.['202']
      commands.push({
        words: x.command,
        method: method.toUpperCase(),
        path,
        summary: op.summary ?? '',
        description: op.description ?? '',
        x,
        fields,
        hasBody: op.requestBody !== undefined,
        output: deref(doc, ok?.content?.['application/json']?.schema) as Schema | undefined,
      })
    }
  }
  return commands
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
