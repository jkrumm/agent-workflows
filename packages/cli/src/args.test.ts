import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { coerce } from './args.ts'
import type { Field } from './spec.ts'

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

  test('a file that is not JSON names the flag and the file', () => {
    const path = join(dir, 'broken.json')
    writeFileSync(path, '{nope')
    expect(() => coerce(arm, path)).toThrow(`--arm: ${path} is not a JSON file`)
  })

  test('neither JSON nor a file is a usage error', () => {
    expect(() => coerce(arm, join(dir, 'missing.json'))).toThrow('--arm must be JSON or a JSON file')
  })
})
