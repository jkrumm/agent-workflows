// scripts/opencode-safe: which base it probes. A stand-in endpoint (Bun.serve) records the probed path; a stand-in
// `opencode` on PATH prints its arguments, so a run that passes the probe is visible.
import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRIPT = join(import.meta.dir, '../../../scripts/opencode-safe')
const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

async function run(env: Record<string, string>, status = 404) {
  const probed: string[] = []
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      probed.push(new URL(request.url).pathname)
      return new Response('', { status })
    },
  })
  const bin = mkdtempSync(join(tmpdir(), 'agw-opencode-safe-'))
  cleanups.push(() => {
    void server.stop(true)
    rmSync(bin, { recursive: true, force: true })
  })
  writeFileSync(join(bin, 'opencode'), '#!/bin/sh\necho "opencode $*"\n')
  chmodSync(join(bin, 'opencode'), 0o755)
  // `security` is shadowed so the Keychain is never read.
  writeFileSync(join(bin, 'security'), '#!/bin/sh\nexit 44\n')
  chmodSync(join(bin, 'security'), 0o755)
  const origin = `http://127.0.0.1:${server.port}`
  const resolved = Object.fromEntries(Object.entries(env).map(([k, v]) => [k, v.replace('<origin>', origin)]))
  const proc = Bun.spawn(['bash', SCRIPT, 'run', 'hi'], {
    env: { PATH: `${bin}:/usr/bin:/bin`, ...resolved },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, out, err, probed }
}

describe('opencode-safe', () => {
  test('AGW_GATEWAY_URL wins: the gateway origin is probed at /openai/v1, then opencode runs', async () => {
    const r = await run({ AGW_GATEWAY_URL: '<origin>/', IU_OPENAI_BASE: 'http://127.0.0.1:1/openai/v1' })
    expect(r.probed).toEqual(['/openai/v1'])
    expect(r).toMatchObject({ code: 0, out: 'opencode run hi\n' })
  })

  test('without it, the present chain: IU_OPENAI_BASE, then IU_BASE_URL rewritten to /openai/v1', async () => {
    expect((await run({ IU_OPENAI_BASE: '<origin>/openai/v1' })).probed).toEqual(['/openai/v1'])
    const derived = await run({ IU_BASE_URL: '<origin>/anthropic' })
    expect(derived.probed).toEqual(['/openai/v1'])
    expect(derived.code).toBe(0)
  })

  test('a 5xx from the gateway refuses with 75; nothing set and no Keychain item refuses with 78', async () => {
    const down = await run({ AGW_GATEWAY_URL: '<origin>' }, 503)
    expect(down.code).toBe(75)
    expect(down.out).toBe('')
    const none = await run({})
    expect(none.code).toBe(78)
    expect(none.err).toContain('AGW_GATEWAY_URL')
  })
})
