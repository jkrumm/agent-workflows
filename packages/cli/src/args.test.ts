import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { coerce, helpText, parseArgs } from './args.ts'
import { type Command, type Field, nextWords, resolveCommand } from './spec.ts'

const dir = mkdtempSync(join(tmpdir(), 'agw-cli-args-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const arm = { name: 'arm', flag: 'arm', required: false, schema: { type: 'object' } } as unknown as Field

describe('a JSON flag', () => {
  test('takes inline JSON', () => {
    expect(coerce(arm, '{"params":{"finders":3}}')).toEqual({ params: { finders: 3 } })
  })

  test("takes a JSON file's path and sends its content, never the path", () => {
    const path = join(dir, 'arm.json')
    const content = { routes: { check: { effort: 'low' } }, params: { finders: 5 } }
    writeFileSync(path, JSON.stringify(content))
    expect(coerce(arm, path)).toEqual(content)
  })

  test('a leading @ names the file, the curl form', () => {
    const path = join(dir, 'at.json')
    writeFileSync(path, '{"project":"app"}')
    expect(coerce(arm, `@${path}`)).toEqual({ project: 'app' })
  })

  test('a file that is not JSON names the flag and the file', () => {
    const path = join(dir, 'broken.json')
    writeFileSync(path, '{nope')
    expect(() => coerce(arm, path)).toThrow(`--arm: ${path} is not a JSON file`)
  })

  test('neither JSON nor a file is a usage error', () => {
    expect(() => coerce(arm, join(dir, 'missing.json'))).toThrow('--arm must be JSON or a JSON file')
  })
})

describe('a cwd flag', () => {
  const cwd = { name: 'cwd', flag: 'cwd', required: true, schema: { type: 'string' } } as unknown as Field

  test('a relative path is resolved against the caller, an absolute one is kept', () => {
    expect(coerce(cwd, '.')).toBe(process.cwd())
    expect(coerce(cwd, 'sub/dir')).toBe(join(process.cwd(), 'sub/dir'))
    expect(coerce(cwd, dir)).toBe(dir)
  })
})

describe('a command with commands below it', () => {
  const command = (words: string[], positional: string[] = []): Command =>
    ({
      words,
      method: 'post',
      path: `/${words.join('/')}`,
      summary: '',
      description: '',
      x: { command: words, positional, mutating: false, defaultFormat: 'json', kind: 'workflow' },
      fields: positional.map((name) => ({ name, flag: name, in: 'body', schema: { type: 'string' }, required: false })),
      hasBody: true,
      output: undefined,
    }) satisfies Command
  const review = command(['review'])
  const prepare = command(['review', 'prepare'])
  const commands = [review, prepare]

  test('resolveCommand picks the longest match and leaves flags as the rest', () => {
    expect(resolveCommand(commands, ['review', '--scope', 'head'])?.command).toBe(review)
    expect(resolveCommand(commands, ['review', 'prepare', '--x'])?.command).toBe(prepare)
    expect(resolveCommand(commands, ['review', 'prepare', '--x'])?.rest).toEqual(['--x'])
  })

  test('nextWords lists the word below a complete command', () => {
    expect(nextWords(commands, ['review', 'nope'])).toEqual({ prefix: ['review'], options: ['prepare'] })
  })

  test('the shorter command still rejects a stray bare word', () => {
    expect(() => parseArgs(review, ['stray'])).toThrow("unexpected argument 'stray'")
  })

  test('help lists the subcommands', () => {
    expect(helpText(review, commands)).toContain('subcommands: prepare')
    expect(helpText(prepare, commands)).not.toContain('subcommands')
  })
})
