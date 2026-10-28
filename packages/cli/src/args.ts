import { usage } from './exit.ts'
import type { Command, Field, Schema } from './spec.ts'

export const BIN = 'agw'

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

type FieldType = 'string' | 'number' | 'integer' | 'boolean' | 'enum' | 'json' | 'any'

const notNull = (s: Schema) => s.type !== 'null'

export function fieldType(schema: Schema): FieldType {
  if (Array.isArray(schema.enum) || schema.const !== undefined) return 'enum'
  const variants = (schema.anyOf ?? schema.oneOf)?.filter(notNull)
  if (variants) return variants.length === 1 && variants[0] ? fieldType(variants[0]) : 'json'
  const types = (Array.isArray(schema.type) ? schema.type : [schema.type]).filter((t) => t && t !== 'null')
  const [type] = types
  if (types.length !== 1) return types.length ? 'json' : 'any'
  if (type === 'string' || type === 'number' || type === 'integer' || type === 'boolean') return type
  return 'json'
}

function enumValues(schema: Schema): unknown[] {
  if (Array.isArray(schema.enum)) return schema.enum
  if (schema.const !== undefined) return [schema.const]
  const variant = (schema.anyOf ?? schema.oneOf)?.find(notNull)
  return variant ? enumValues(variant) : []
}

function typeLabel(field: Field): string {
  const type = fieldType(field.schema)
  if (type === 'enum') return enumValues(field.schema).map(String).join('|')
  return type === 'any' ? 'value' : type
}

export function coerce(field: Field, raw: string, label = `--${field.flag}`): unknown {
  const bad = (why: string) => usage(`${label} ${why}, got: ${raw}`, `${BIN} schema <command…> prints the input schema`)
  switch (fieldType(field.schema)) {
    case 'string':
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
      if (raw !== 'true' && raw !== 'false') throw bad('must be true or false')
      return raw === 'true'
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

/** Input properties shadow a global flag of the same name: `llm summarize --format bullets` is its input. */
function globalFlags(command: Command): string[] {
  const own = new Set(command.fields.map((f) => f.flag))
  return [
    ...(own.has('format') ? [] : ['format']),
    ...(command.x.mutating ? ['commit'] : []),
    ...(command.x.kind === 'workflow' || command.x.mutating ? ['idempotency-key'] : []),
  ]
}

const flagFields = (command: Command) => command.fields.filter((f) => !command.x.positional.includes(f.name))

export function validFlags(command: Command): string[] {
  return [...flagFields(command).map((f) => f.flag), ...globalFlags(command), 'help'].map((f) => `--${f}`)
}

export function usageLine(command: Command): string {
  const positional = command.x.positional.map((name) => {
    const field = command.fields.find((f) => f.name === name)
    return field?.required && command.x.stdin !== name ? `<${name}>` : `[${name}]`
  })
  const flags = flagFields(command).map((f) =>
    f.required ? `--${f.flag} <${typeLabel(f)}>` : `[--${f.flag} <${typeLabel(f)}>]`,
  )
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
      typeLabel(f),
      f.required ? 'required' : '',
      f.schema.default !== undefined ? `default ${JSON.stringify(f.schema.default)}` : '',
      command.x.stdin === f.name ? 'read from stdin when omitted' : '',
    ].filter(Boolean)
    return `  ${label.padEnd(22)} ${facts.join(', ')}${f.schema.description ? ` — ${f.schema.description}` : ''}`
  }
  const positional = command.fields.filter((f) => command.x.positional.includes(f.name))
  if (positional.length) lines.push('', 'arguments:', ...positional.map((f) => describe(f, `<${f.name}>`)))
  const flags = flagFields(command)
  if (flags.length) lines.push('', 'flags:', ...flags.map((f) => describe(f, `--${f.flag}`)))
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
  const unknown = (token: string) => usage(`unknown flag ${token}`, `valid flags: ${validFlags(command).join(' ')}`)

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
      if (name === 'commit') parsed.globals.commit = true
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
    if (negated && fieldType(negated.schema) === 'boolean' && inline === undefined) {
      parsed.values[negated.name] = false
      continue
    }
    if (!field) throw unknown(token)
    const boolean = fieldType(field.schema) === 'boolean'
    parsed.values[field.name] = coerce(field, boolean && inline === undefined ? 'true' : value())
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

/** Run after stdin is read, so a property that came from stdin counts as given. */
export function assertRequired(command: Command, values: Record<string, unknown>): void {
  const missing = command.fields.filter((f) => f.required && values[f.name] === undefined)
  if (!missing.length) return
  const label = (f: Field) => (command.x.positional.includes(f.name) ? `<${f.name}>` : `--${f.flag}`)
  const stdin = missing.some((f) => f.name === command.x.stdin) ? ` (or pipe ${command.x.stdin} on stdin)` : ''
  throw usage(`missing ${missing.map(label).join(', ')}${stdin}`, `usage: ${usageLine(command)}`)
}

export function coerceStdin(command: Command, text: string): unknown {
  const field = command.fields.find((f) => f.name === command.x.stdin)
  if (!field) return text
  const type = fieldType(field.schema)
  return type === 'string' || type === 'any' ? text : coerce(field, text.trim(), 'stdin')
}
