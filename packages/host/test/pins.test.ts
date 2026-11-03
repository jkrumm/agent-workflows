import { afterEach, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OPENCODE_VERSION } from '@agent-workflows/opencode-host'

// scripts/pins.sh reads the installer's version out of the exported constant with sed: a reformatted constant must
// fail here, not silently install nothing.
const pins = join(import.meta.dir, '../../../scripts/pins.sh')
const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function run(args: string[], env: Record<string, string> = {}) {
  const proc = Bun.spawnSync([pins, ...args], { env: { PATH: process.env.PATH ?? '', HOME: '/nonexistent', ...env } })
  return { code: proc.exitCode, out: proc.stdout.toString().trim(), err: proc.stderr.toString().trim() }
}

test('the pinned versions read from the source equal the exported constants', () => {
  expect(run(['version', 'opencode']).out).toBe(OPENCODE_VERSION)
})

test('a relative root override is rejected', () => {
  const result = run(['root', 'opencode'], { AGW_OPENCODE_ROOT: 'relative/dir' })
  expect(result.code).toBe(1)
  expect(result.err).toContain('AGW_OPENCODE_ROOT must be an absolute path')
})

test('check fails naming make install-opencode when the pinned install is missing, passes when it is present', () => {
  const prefix = mkdtempSync(join(tmpdir(), 'agw-pins-'))
  scratch.push(prefix)
  const env = { AGW_OPENCODE_ROOT: join(prefix, 'opencode-bin') }
  const missing = run(['check'], env)
  expect(missing.code).toBe(1)
  expect(missing.err).toContain(`OpenCode ${OPENCODE_VERSION} missing at`)
  expect(missing.err).toContain('make install-opencode')

  const exe = (path: string) => {
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, '#!/bin/sh\n')
    chmodSync(path, 0o755)
  }
  exe(join(env.AGW_OPENCODE_ROOT, OPENCODE_VERSION, 'node_modules/.bin/opencode'))
  const unlinked = run(['check'], env)
  expect(unlinked.code).toBe(1)
  expect(unlinked.err).toContain('current does not point at the pinned OpenCode')

  symlinkSync(join(env.AGW_OPENCODE_ROOT, OPENCODE_VERSION), join(env.AGW_OPENCODE_ROOT, 'current'))
  const present = run(['check'], env)
  expect(present.code).toBe(0)
  expect(present.out).toContain(`opencode ${OPENCODE_VERSION}`)
})
