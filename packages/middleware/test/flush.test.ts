import { afterAll, describe, expect, test } from 'bun:test'

type Received = { path: string; authorization: string | null; custom: string | null; body: string }

const received: Received[] = []
let status = 200
const receiver = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  async fetch(req) {
    const body = Buffer.from(await req.arrayBuffer()).toString('latin1')
    received.push({
      path: new URL(req.url).pathname,
      authorization: req.headers.get('authorization'),
      custom: req.headers.get('x-agw-test'),
      body,
    })
    return new Response(null, { status })
  },
})

afterAll(() => receiver.stop(true))

async function runChild(mode: string, signal?: NodeJS.Signals) {
  received.length = 0
  const child = Bun.spawn(['bun', `${import.meta.dir}/flush/child.ts`, mode], {
    env: {
      ...process.env,
      OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${receiver.port}`,
      OTEL_EXPORTER_OTLP_HEADERS: 'authorization=Bearer test-key,x-agw-test=1',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const reader = child.stdout.getReader()
  const { value } = await reader.read()
  expect(new TextDecoder().decode(value)).toContain('ready')
  if (signal) child.kill(signal)
  const timer = setTimeout(() => child.kill('SIGKILL'), 10_000)
  await child.exited
  clearTimeout(timer)
  return { child, stderr: await new Response(child.stderr).text() }
}

describe('installFlush in a subprocess', () => {
  test('SIGTERM: onSignal, spans reach the receiver with the env headers, the process ends by the signal', async () => {
    status = 200
    const { child, stderr } = await runChild('signal', 'SIGTERM')
    expect(child.signalCode).toBe('SIGTERM')
    expect(stderr).toContain('onSignal SIGTERM')
    expect(received).toHaveLength(1)
    // The exporter reads OTEL_EXPORTER_OTLP_ENDPOINT and OTEL_EXPORTER_OTLP_HEADERS itself on Bun.
    expect(received[0]).toMatchObject({ path: '/v1/traces', authorization: 'Bearer test-key', custom: '1' })
    expect(received[0]?.body).toContain('agw.run flush.test')
    expect(received[0]?.body).toContain('agw.step one')
    expect(stderr).not.toContain('ERROR')
  }, 20_000)

  test('SIGINT is re-raised the same way', async () => {
    status = 200
    const { child } = await runChild('signal', 'SIGINT')
    expect(child.signalCode).toBe('SIGINT')
    expect(received).toHaveLength(1)
  }, 20_000)

  test('unhandled rejection: logged, flushed, exit 1', async () => {
    status = 200
    const { child, stderr } = await runChild('crash')
    expect(child.exitCode).toBe(1)
    expect(stderr).toContain('unhandledRejection')
    expect(received[0]?.body).toContain('agw.run flush.test')
  }, 20_000)

  test('a failed export and dropped spans are logged, never silent', async () => {
    status = 500
    const failed = await runChild('signal', 'SIGTERM')
    expect(failed.child.signalCode).toBe('SIGTERM')
    expect(failed.stderr).toContain('ERROR telemetry: span export failed')

    status = 200
    const dropped = await runChild('drop', 'SIGTERM')
    expect(dropped.stderr).toContain('ERROR telemetry: spans dropped before export')
  }, 30_000)
})
