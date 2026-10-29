import { afterEach, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OPENCODE_VERSION } from '@agent-workflows/opencode-host'
import { REACT_DOCTOR_VERSION } from '../src/workflows/review/react-doctor.ts'

// scripts/pins.sh reads the installers' versions out of the exported constants with sed: a reformatted constant must
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
  expect(run(['version', 'react-doctor']).out).toBe(REACT_DOCTOR_VERSION)
})

test('a relative root override is rejected', () => {
  const result = run(['root', 'opencode'], { AGW_OPENCODE_ROOT: 'relative/dir' })
  expect(result.code).toBe(1)
  expect(result.err).toContain('AGW_OPENCODE_ROOT must be an absolute path')
})

test('check fails naming make install-opencode when a pinned install is missing, passes when both are present', () => {
  const prefix = mkdtempSync(join(tmpdir(), 'agw-pins-'))
  scratch.push(prefix)
  const env = {
    AGW_OPENCODE_ROOT: join(prefix, 'opencode-bin'),
    AGW_REACT_DOCTOR_ROOT: join(prefix, 'react-doctor'),
  }
  const missing = run(['check'], env)
  expect(missing.code).toBe(1)
  expect(missing.err).toContain(`OpenCode ${OPENCODE_VERSION} missing at`)
  expect(missing.err).toContain(`react-doctor ${REACT_DOCTOR_VERSION} missing at`)
  expect(missing.err).toContain('make install-opencode')

  const exe = (path: string) => {
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, '#!/bin/sh\n')
    chmodSync(path, 0o755)
  }
  exe(join(env.AGW_OPENCODE_ROOT, OPENCODE_VERSION, 'node_modules/.bin/opencode'))
  exe(join(env.AGW_REACT_DOCTOR_ROOT, REACT_DOCTOR_VERSION, 'node_modules/.bin/react-doctor'))
  const unlinked = run(['check'], env)
  expect(unlinked.code).toBe(1)
  expect(unlinked.err).toContain('current does not point at the pinned OpenCode')

  symlinkSync(join(env.AGW_OPENCODE_ROOT, OPENCODE_VERSION), join(env.AGW_OPENCODE_ROOT, 'current'))
  const present = run(['check'], env)
  expect(present.code).toBe(0)
  expect(present.out).toContain(`opencode ${OPENCODE_VERSION}`)
})
