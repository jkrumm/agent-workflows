import { afterAll, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { computeFingerprint, type FingerprintInputs, fsFingerprintSource } from '../src/index.ts'

const base: FingerprintInputs = {
  agents: [
    { name: 'brain', files: { 'AGENTS.md': '# brain', 'skills/a.md': 'a' }, route: 'r1' },
    { name: 'web', files: { 'AGENTS.md': '# web' }, route: 'r2' },
  ],
  opencodeVersion: '2.0.32',
}

describe('computeFingerprint', () => {
  test('same inputs, same hash, independent of order', () => {
    const reordered: FingerprintInputs = {
      agents: [
        { name: 'web', files: { 'AGENTS.md': '# web' }, route: 'r2' },
        { name: 'brain', files: { 'skills/a.md': 'a', 'AGENTS.md': '# brain' }, route: 'r1' },
      ],
      opencodeVersion: '2.0.32',
    }
    expect(computeFingerprint('v1', base)).toBe(computeFingerprint('v1', reordered))
    expect(computeFingerprint('v1', base)).toMatch(/^[\da-f]{64}$/)
  })

  test('each input changes it: version, AGENTS.md, a skill, a route, OpenCode', () => {
    const fp = computeFingerprint('v1', base)
    const brain = base.agents[0] as FingerprintInputs['agents'][number]
    const variants: FingerprintInputs[] = [
      { ...base, agents: [{ ...brain, files: { ...brain.files, 'AGENTS.md': '# brain!' } }, ...base.agents.slice(1)] },
      { ...base, agents: [{ ...brain, files: { ...brain.files, 'skills/b.md': 'b' } }, ...base.agents.slice(1)] },
      { ...base, agents: [{ ...brain, route: 'r1b' }, ...base.agents.slice(1)] },
      { ...base, opencodeVersion: '2.0.33' },
    ]
    const all = [computeFingerprint('v2', base), ...variants.map((v) => computeFingerprint('v1', v))]
    expect(new Set([fp, ...all]).size).toBe(all.length + 1)
  })
})

describe('fsFingerprintSource', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agw-fp-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  const agents = join(dir, 'agents')
  mkdirSync(join(agents, 'brain', 'skills', 'nested'), { recursive: true })
  writeFileSync(join(agents, 'brain', 'AGENTS.md'), '# brain')
  writeFileSync(join(agents, 'brain', 'skills', 'nested', 'search.md'), 'search well')
  const calls = join(dir, 'calls')
  const bin = join(dir, 'opencode')
  writeFileSync(bin, `#!/bin/sh\necho x >> "${calls}"\necho "2.0.32"\n`)
  chmodSync(bin, 0o755)

  const source = (env: Record<string, string | undefined> = {}) =>
    fsFingerprintSource({
      agentsDir: agents,
      workflows: { 'research.report': [{ agent: 'brain', route: 'cheap.classify' }] },
      opencodeBin: bin,
      env,
    })

  test('reads AGENTS.md, skills and the OpenCode version once per process', async () => {
    const s = source()
    const first = await s.inputs({ id: 'research.report', version: 'v1' })
    await s.inputs({ id: 'research.report', version: 'v1' })
    expect(first.opencodeVersion).toBe('2.0.32')
    expect(first.agents[0]?.files).toEqual({ 'AGENTS.md': '# brain', 'skills/nested/search.md': 'search well' })
    expect(readFileSync(calls, 'utf8').trim().split('\n')).toHaveLength(1)
  })

  test('a workflow without agents never asks OpenCode', async () => {
    expect(await source().inputs({ id: 'plain', version: 'v1' })).toEqual({ agents: [], opencodeVersion: null })
  })

  test('a route override or an AGENTS.md edit changes the fingerprint; a new process sees the edit', async () => {
    const fp = async (env: Record<string, string | undefined> = {}) =>
      computeFingerprint('v1', await source(env).inputs({ id: 'research.report', version: 'v1' }))
    const before = await fp()
    expect(await fp()).toBe(before)
    expect(await fp({ AGW_ROUTES: JSON.stringify({ 'cheap.classify': { model: 'other-model' } }) })).not.toBe(before)
    writeFileSync(join(agents, 'brain', 'AGENTS.md'), '# brain v2')
    expect(await fp()).not.toBe(before)
  })

  test('a missing agent fails, and is read again next time', async () => {
    const s = fsFingerprintSource({
      agentsDir: agents,
      workflows: { w: [{ agent: 'ghost', route: 'cheap.classify' }] },
      opencodeBin: bin,
    })
    const missing = await s.inputs({ id: 'w', version: 'v1' }).then(
      () => null,
      (err: unknown) => err,
    )
    expect(String(missing)).toContain('ENOENT')
    mkdirSync(join(agents, 'ghost'))
    writeFileSync(join(agents, 'ghost', 'AGENTS.md'), '# ghost')
    expect((await s.inputs({ id: 'w', version: 'v1' })).agents[0]?.files['AGENTS.md']).toBe('# ghost')
  })
})
