import { usage } from './exit.ts'
import type { Command, Field, Schema } from './spec.ts'

export const BIN = 'agw'

/** Always the CLI's own: an input property with one of these names is not reachable as a flag. */
export const RESERVED_FLAGS = ['format', 'commit', 'idempotency-key', 'help']

export interface Globals {
  format?: 'json' | 'plain'
  commit: boolean
  idempotencyKey?: string
  help: boolean
}

export interface Parsed {
  values: Record<string, unknown>
  globals: Globals
}

/** `scalar` is a union of scalars: the string passes through and the host validates it. */
type FieldType = 'string' | 'number' | 'integer' | 'boolean' | 'enum' | 'scalar' | 'json' | 'any'

const SCALARS = ['string', 'number', 'integer', 'boolean']
const notNull = (s: Schema) => s.type !== 'null'

function unionType(types: FieldType[]): FieldType {
  if (types.every((t) => t === 'enum')) return 'enum'
  if (types.includes('json')) return 'json'
  return types.includes('any') ? 'any' : 'scalar'
}

export function fieldType(schema: Schema): FieldType {
  if (Array.isArray(schema.enum) || schema.const !== undefined) return 'enum'
  const variants = (schema.anyOf ?? schema.oneOf)?.filter(notNull)
  if (variants) {
    const [only] = variants
    if (variants.length === 1 && only) return fieldType(only)
    return variants.length ? unionType(variants.map(fieldType)) : 'any'
  }
  const types = (Array.isArray(schema.type) ? schema.type : [schema.type]).filter(
    (t): t is string => typeof t === 'string' && t !== 'null',
  )
  const [type] = types
  if (type === undefined) return 'any'
  if (types.length > 1) return types.every((t) => SCALARS.includes(t)) ? 'scalar' : 'json'
  return SCALARS.includes(type) ? (type as FieldType) : 'json'
}

function enumValues(schema: Schema): unknown[] {
  if (Array.isArray(schema.enum)) return schema.enum
  if (schema.const !== undefined) return [schema.const]
  return (schema.anyOf ?? schema.oneOf)?.filter(notNull).flatMap(enumValues) ?? []
}

function typeLabel(field: Field): string {
  const type = fieldType(field.schema)
  if (type === 'enum') return enumValues(field.schema).map(String).join('|')
  return type === 'any' || type === 'scalar' ? 'value' : type
}

const isBoolean = (field: Field) => fieldType(field.schema) === 'boolean'

function parseBoolean(label: string, raw: string): boolean {
  if (raw !== 'true' && raw !== 'false') throw usage(`${label} must be true or false, got: ${raw}`)
  return raw === 'true'
}

export function coerce(field: Field, raw: string, label = `--${field.flag}`): unknown {
  const bad = (why: string) => usage(`${label} ${why}, got: ${raw}`, `${BIN} schema <command…> prints the input schema`)
  switch (fieldType(field.schema)) {
    case 'string':
    case 'scalar':
      return raw
    case 'number':
    case 'integer': {
      const n = Number(raw)
      const integer = fieldType(field.schema) === 'integer'
      if (raw.trim() === '' || !Number.isFinite(n) || (integer && !Number.isInteger(n)))
        throw bad(integer ? 'must be an integer' : 'must be a number')
      return n
    }
    case 'boolean':
      return parseBoolean(label, raw)
    case 'enum': {
      const match = enumValues(field.schema).find((v) => String(v) === raw)
      if (match === undefined) throw bad(`must be one of ${typeLabel(field)}`)
      return match
    }
    case 'json':
      try {
        return JSON.parse(raw)
      } catch {
        throw bad('must be JSON')
      }
    case 'any':
      try {
        return JSON.parse(raw)
      } catch {
        return raw
      }
  }
}

function globalFlags(command: Command): string[] {
  return [
    'format',
    ...(command.x.mutating ? ['commit'] : []),
    ...(command.x.kind === 'workflow' || command.x.mutating ? ['idempotency-key'] : []),
  ]
}

const flagFields = (command: Command) =>
  command.fields.filter((f) => !command.x.positional.includes(f.name) && !RESERVED_FLAGS.includes(f.flag))

export function validFlags(command: Command): string[] {
  return [
    ...flagFields(command).flatMap((f) => (isBoolean(f) ? [f.flag, `no-${f.flag}`] : [f.flag])),
    ...globalFlags(command),
    'help',
  ].map((f) => `--${f}`)
}

const flagSyntax = (f: Field) => (isBoolean(f) ? `--${f.flag}|--no-${f.flag}` : `--${f.flag} <${typeLabel(f)}>`)

export function usageLine(command: Command): string {
  const positional = command.x.positional.map((name) => {
    const field = command.fields.find((f) => f.name === name)
    return field?.required && command.x.stdin !== name ? `<${name}>` : `[${name}]`
  })
  const flags = flagFields(command).map((f) => (f.required ? flagSyntax(f) : `[${flagSyntax(f)}]`))
  const globals = globalFlags(command).map((g) =>
    g === 'format' ? '[--format json|plain]' : g === 'commit' ? '[--commit]' : '[--idempotency-key <key>]',
  )
  return [BIN, ...command.words, ...positional, ...flags, ...globals].join(' ')
}

export function helpText(command: Command): string {
  const lines = [`usage: ${usageLine(command)}`, '']
  if (command.summary) lines.push(command.summary)
  if (command.description) lines.push(command.description)
  const describe = (f: Field, label: string) => {
    const facts = [
      isBoolean(f) ? '' : typeLabel(f),
      f.required ? 'required' : '',
      f.schema.default !== undefined ? `default ${JSON.stringify(f.schema.default)}` : '',
      command.x.stdin === f.name ? 'read from stdin when omitted' : '',
    ].filter(Boolean)
    return `  ${label.padEnd(22)} ${facts.join(', ')}${f.schema.description ? ` — ${f.schema.description}` : ''}`
  }
  const positional = command.fields.filter((f) => command.x.positional.includes(f.name))
  if (positional.length) lines.push('', 'arguments:', ...positional.map((f) => describe(f, `<${f.name}>`)))
  const flags = flagFields(command)
  if (flags.length)
    lines.push(
      '',
      'flags:',
      ...flags.map((f) => describe(f, isBoolean(f) ? `--${f.flag}, --no-${f.flag}` : `--${f.flag}`)),
    )
  const notes = [
    command.x.mutating ? 'mutating: needs --commit when stdin is not a TTY' : '',
    command.x.kind === 'workflow'
      ? 'waits up to AGW_WAIT_BUDGET_S (default 110 s), then exits 10 with the resume command'
      : '',
  ].filter(Boolean)
  if (notes.length) lines.push('', ...notes)
  return `${lines.join('\n')}\n`
}

export function parseArgs(command: Command, tokens: string[]): Parsed {
  const byFlag = new Map(flagFields(command).map((f) => [f.flag, f]))
  const globals = new Set(globalFlags(command))
  const parsed: Parsed = { values: {}, globals: { commit: false, help: false } }
  const positional: string[] = []
  const unknown = (token: string) =>
    usage(`unknown flag ${token}`, `valid flags: ${validFlags(command).join(' ')}`, true)

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] as string
    if (token === '--') {
      positional.push(...tokens.slice(i + 1))
      break
    }
    if (token === '-h' || token === '--help') {
      parsed.globals.help = true
      continue
    }
    if (!token.startsWith('--')) {
      if (token.startsWith('-') && token !== '-' && Number.isNaN(Number(token))) throw unknown(token)
      positional.push(token)
      continue
    }
    const eq = token.indexOf('=')
    const name = eq < 0 ? token.slice(2) : token.slice(2, eq)
    const inline = eq < 0 ? undefined : token.slice(eq + 1)
    const value = (): string => {
      if (inline !== undefined) return inline
      const next = tokens[i + 1]
      if (next === undefined) throw usage(`--${name} needs a value`, `usage: ${usageLine(command)}`)
      i++
      return next
    }
    if (globals.has(name)) {
      if (name === 'commit') parsed.globals.commit = inline === undefined || parseBoolean('--commit', inline)
      else if (name === 'idempotency-key') parsed.globals.idempotencyKey = value()
      else {
        const format = value()
        if (format !== 'json' && format !== 'plain') throw usage(`--format must be json or plain, got: ${format}`)
        parsed.globals.format = format
      }
      continue
    }
    const field = byFlag.get(name)
    const negated = !field && name.startsWith('no-') ? byFlag.get(name.slice(3)) : undefined
    if (negated && isBoolean(negated) && inline === undefined) {
      parsed.values[negated.name] = false
      continue
    }
    if (!field) throw unknown(token)
    parsed.values[field.name] = coerce(field, isBoolean(field) && inline === undefined ? 'true' : value())
  }
  if (parsed.globals.help) return parsed

  const names = command.x.positional
  if (positional.length > names.length) {
    throw usage(`unexpected argument '${positional[names.length]}'`, `usage: ${usageLine(command)}`)
  }
  positional.forEach((raw, i) => {
    const field = command.fields.find((f) => f.name === names[i])
    if (field) parsed.values[field.name] = coerce(field, raw, `<${field.name}>`)
  })
  return parsed
}

/** `.` and `..` in a path segment would address another route; any encoding of them counts. */
function isDotSegment(value: string): boolean {
  let current = value
  for (let i = 0; i < 4; i++) {
    if (current === '.' || current === '..') return true
    let decoded: string
    try {
      decoded = decodeURIComponent(current)
    } catch {
      return false
    }
    if (decoded === current) return false
    current = decoded
  }
  return false
}

/** Run after stdin is read, so a property that came from stdin counts as given. */
export function assertValues(command: Command, values: Record<string, unknown>): void {
  const label = (f: Field) => (command.x.positional.includes(f.name) ? `<${f.name}>` : `--${f.flag}`)
  const missing = command.fields.filter((f) => f.required && values[f.name] === undefined)
  if (missing.length) {
    const stdin = missing.some((f) => f.name === command.x.stdin) ? ` (or pipe ${command.x.stdin} on stdin)` : ''
    throw usage(`missing ${missing.map(label).join(', ')}${stdin}`, `usage: ${usageLine(command)}`, true)
  }
  for (const f of command.fields) {
    const value = values[f.name]
    if (
      f.in === 'path' &&
      value !== undefined &&
      isDotSegment(typeof value === 'string' ? value : JSON.stringify(value))
    ) {
      throw usage(`${label(f)} must not be '.' or '..', got: ${String(value)}`)
    }
  }
}

export function coerceStdin(command: Command, text: string): unknown {
  const field = command.fields.find((f) => f.name === command.x.stdin)
  if (!field) return text
  const type = fieldType(field.schema)
  return type === 'string' || type === 'scalar' || type === 'any' ? text : coerce(field, text.trim(), 'stdin')
}
