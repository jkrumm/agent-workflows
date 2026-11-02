// scripts/opencode-safe: which base it probes and what counts as up. A stand-in endpoint (Bun.serve) records the probed
// path and answers /health with `health`; a stand-in `opencode` on PATH prints its arguments, so a run that passes the
// probe is visible.
import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRIPT = join(import.meta.dir, '../../../scripts/opencode-safe')
const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

type Answer = { status?: number; health?: { status: number; body: unknown } }

async function run(env: Record<string, string>, answer: Answer = {}) {
  const probed: string[] = []
  const health = answer.health ?? { status: 200, body: { status: 'ok', version: 'x', build: 'b' } }
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname
      probed.push(path)
      if (path === '/health') return Response.json(health.body, { status: health.status })
      return new Response('', { status: answer.status ?? 404 })
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
  test('AGW_GATEWAY_URL: the gateway is probed at /health, status ok runs opencode', async () => {
    const r = await run({ AGW_GATEWAY_URL: '<origin>/', IU_BASE_URL: 'http://127.0.0.1:1/anthropic' })
    expect(r.probed).toEqual(['/health'])
    expect(r).toMatchObject({ code: 0, out: 'opencode run hi\n' })
  })

  test('an explicit IU_OPENAI_BASE wins over AGW_GATEWAY_URL and is probed as an OpenAI base', async () => {
    const r = await run({ IU_OPENAI_BASE: '<origin>/openai/v1', AGW_GATEWAY_URL: 'http://127.0.0.1:1' })
    expect(r.probed).toEqual(['/openai/v1'])
    expect(r.code).toBe(0)
  })

  test('IU_BASE_URL is rewritten to /openai/v1 when nothing else is set; any sub-500 counts there', async () => {
    const r = await run({ IU_BASE_URL: '<origin>/anthropic' }, { status: 401 })
    expect(r.probed).toEqual(['/openai/v1'])
    expect(r.code).toBe(0)
  })

  test('the gateway needs status ok: degraded, a 5xx or a sub-500 that is not ok refuses with 75', async () => {
    for (const health of [
      { status: 200, body: { status: 'degraded', version: 'x' } },
      { status: 503, body: { status: 'ok' } },
      { status: 404, body: { error: 'not found' } },
    ]) {
      const r = await run({ AGW_GATEWAY_URL: '<origin>' }, { health })
      expect(r.code).toBe(75)
      expect(r.out).toBe('')
      expect(r.err).toContain("the gateway's /health is not ok")
    }
  })

  test('a 5xx on an IU base refuses with 75; nothing set and no Keychain item refuses with 78', async () => {
    const down = await run({ IU_OPENAI_BASE: '<origin>/openai/v1' }, { status: 503 })
    expect(down.code).toBe(75)
    const none = await run({})
    expect(none.code).toBe(78)
    expect(none.err).toContain('AGW_GATEWAY_URL')
  })
})
