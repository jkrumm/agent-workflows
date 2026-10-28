import { afterAll, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { computeFingerprint } from '@agent-workflows/middleware'
import { basePolicyDigest } from '@agent-workflows/opencode-host'
import { hostFingerprintSource } from '../src/boot.ts'

describe('the host’s fingerprint source', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agw-fpwire-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))
  const agents = join(dir, 'agents')
  mkdirSync(join(agents, 'angle'), { recursive: true })
  writeFileSync(join(agents, 'angle', 'AGENTS.md'), '# angle')
  const bin = join(dir, 'opencode')
  writeFileSync(bin, '#!/bin/sh\necho "2.0.32"\n')
  chmodSync(bin, 0o755)
  const source = () =>
    hostFingerprintSource({
      agentsDir: agents,
      workflows: { review: [{ agent: 'angle', route: 'review.angle' }] },
      opencodeBin: bin,
    })
  const fingerprint = async () => computeFingerprint('v1', await source().inputs({ id: 'review', version: 'v1' }))

  test('carries the base policy digest, so a change to the default policy moves the fingerprint', async () => {
    expect((await source().inputs({ id: 'review', version: 'v1' })).hostPolicy).toBe(basePolicyDigest())
  })

  test('an agent.json route or permissions edit moves it, an unrelated file does not', async () => {
    const before = await fingerprint()
    writeFileSync(join(agents, 'angle', 'README.md'), 'notes')
    expect(await fingerprint()).toBe(before)
    writeFileSync(join(agents, 'angle', 'agent.json'), JSON.stringify({ route: 'review.angle' }))
    const routed = await fingerprint()
    expect(routed).not.toBe(before)
    writeFileSync(join(agents, 'angle', 'agent.json'), JSON.stringify({ route: 'review.synthesis' }))
    const moved = await fingerprint()
    expect(moved).not.toBe(routed)
    writeFileSync(
      join(agents, 'angle', 'agent.json'),
      JSON.stringify({ route: 'review.synthesis', permissions: { shell: true } }),
    )
    expect(await fingerprint()).not.toBe(moved)
  })
})
