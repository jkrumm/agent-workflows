import { expect, test } from 'bun:test'
import { resolve } from 'node:path'

/**
 * Lint: a capability call carries the step's whole call context (`scope.callContext`). A call whose options are built
 * by hand from the scope's parts can drop the arm, and inside an armed eval run that call then resolves the plain route
 * table. So every `.call(` under packages/**\/src whose arguments name `attribution` must also name `arm` or pass
 * `callContext` (as is, or spread to wrap `addUsage`).
 */
const ROOT = resolve(import.meta.dir, '../../..')
const CALL = /\.call\(/g

/** The text between a `.call(` and its closing parenthesis (strings and nesting counted, comments not). */
function argumentsOf(source: string, open: number): string {
  let depth = 1
  let quote: string | null = null
  for (let i = open; i < source.length; i++) {
    const c = source[i]
    if (quote) {
      if (c === '\\') i++
      else if (c === quote) quote = null
      continue
    }
    if (c === "'" || c === '"' || c === '`') quote = c
    else if (c === '(') depth++
    else if (c === ')' && --depth === 0) return source.slice(open, i)
  }
  return source.slice(open)
}

function handBuiltContexts(source: string, file: string): string[] {
  const found: string[] = []
  for (const match of source.matchAll(CALL)) {
    const index = match.index ?? 0
    const lineStart = source.lastIndexOf('\n', index) + 1
    const prefix = source.slice(lineStart, index).trimStart()
    if (prefix.startsWith('//') || prefix.startsWith('*') || prefix.startsWith('/*')) continue
    const args = argumentsOf(source, index + match[0].length)
    if (!/\battribution\b/.test(args) || /\barm\b|\bcallContext\b/.test(args)) continue
    const line = source.slice(0, index).split('\n').length
    found.push(`${file}:${line}: pass the step's callContext (it carries the run's arm), not a hand-built context`)
  }
  return found
}

test('every capability call under packages/**/src carries the step call context, the arm included', async () => {
  const violations: string[] = []
  for await (const file of new Bun.Glob('packages/*/src/**/*.{ts,tsx}').scan({ cwd: ROOT })) {
    if (/\.test\.tsx?$/.test(file)) continue
    violations.push(...handBuiltContexts(await Bun.file(resolve(ROOT, file)).text(), file))
  }
  expect(violations).toEqual([])
})

test('the lint flags a hand-built context without the arm and accepts the call context', () => {
  const source = [
    "registry.call('llm.title', { text }, { addUsage, signal, attribution })",
    "registry.call('llm.title', { text }, callContext)",
    "registry.call('llm.title', { text: f(a) }, { ...callContext, addUsage: (u) => tally(u) })",
    "registry.call('llm.title', { text }, { addUsage, signal, attribution, arm })",
    'deps.cover.call(request, {\n  signal,\n  attribution: scope.attribution,\n})',
    'fn.call(this, x)',
  ].join('\n')
  expect(handBuiltContexts(source, 'f.ts')).toEqual([
    "f.ts:1: pass the step's callContext (it carries the run's arm), not a hand-built context",
    "f.ts:5: pass the step's callContext (it carries the run's arm), not a hand-built context",
  ])
})
