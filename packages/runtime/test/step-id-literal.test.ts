import { expect, test } from 'bun:test'
import { resolve } from 'node:path'

/**
 * Lint: step ids are literals (concept §3). A computed id silently creates a new step on replay, so every
 * `ctx.step|effect|agent|workflow|score|continue(` under packages/**\/src must start with a string literal.
 */
const ROOT = resolve(import.meta.dir, '../../..')
const CALL = /\bctx\s*\.\s*(step|effect|agent|workflow|score|continue)\s*\(\s*/g

function findComputedStepIds(source: string, file: string): string[] {
  const found: string[] = []
  for (const match of source.matchAll(CALL)) {
    const index = match.index ?? 0
    const lineStart = source.lastIndexOf('\n', index) + 1
    const prefix = source.slice(lineStart, index).trimStart()
    if (prefix.startsWith('//') || prefix.startsWith('*') || prefix.startsWith('/*')) continue
    const rest = source.slice(index + match[0].length)
    if (/^(['"])(?:(?!\1)[^\\\n]|\\.)*\1\s*,/.test(rest) || /^`[^`$]*`\s*,/.test(rest)) continue
    const line = source.slice(0, index).split('\n').length
    found.push(`${file}:${line}: ctx.${match[1]}() needs a string-literal step id`)
  }
  return found
}

test('every ctx step call under packages/**/src uses a literal step id', async () => {
  const violations: string[] = []
  for await (const file of new Bun.Glob('packages/*/src/**/*.{ts,tsx}').scan({ cwd: ROOT })) {
    violations.push(...findComputedStepIds(await Bun.file(resolve(ROOT, file)).text(), file))
  }
  expect(violations).toEqual([])
})

test('the lint flags computed ids and accepts literals', () => {
  const source = [
    "await ctx.step('ok', () => 1)",
    'await ctx.agent("fine", spec)',
    'await ctx.effect(`plain`, fn)',
    `await ctx.step(\`id-$${'{i}'}\`, fn)`,
    'await ctx.workflow(name, child, inputs)',
    'await ctx.score(gateId, draft)',
    "await ctx.continue('revise', draft, feedback)",
    '// ctx.step(id, fn) in a comment',
    'await ctx.step(',
    "  'multi-line',",
    '  fn)',
  ].join('\n')
  expect(findComputedStepIds(source, 'x.ts')).toEqual([
    'x.ts:4: ctx.step() needs a string-literal step id',
    'x.ts:5: ctx.workflow() needs a string-literal step id',
    'x.ts:6: ctx.score() needs a string-literal step id',
  ])
})
