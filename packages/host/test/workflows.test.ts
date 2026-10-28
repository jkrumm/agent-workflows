import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { captureLogger, startTestHost, type TestHost, until } from './support.ts'

let t: TestHost
beforeAll(async () => {
  t = await startTestHost({ prefix: 'wf' })
})
afterAll(async () => {
  await t.close()
})

const run = async (id: string) => (await t.pool.query(`select * from "${t.schema}".runs where id = $1`, [id])).rows[0]

describe('workflow start', () => {
  test('a run that ends within the wait is 200 done with its output', async () => {
    const { status, body } = await t.json(
      await t.call('/workflows/echo/say', { body: { text: 'hi' }, headers: { prefer: 'wait=10' } }),
    )
    expect(status).toBe(200)
    expect(body).toMatchObject({ workflowId: 'echo.say', status: 'done', output: { text: 'hi' } })
    expect(body.runId).toBeString()
    expect(body.error).toBeUndefined()
  })

  test('no Prefer is wait 0: 202 with the state at that moment, never an error', async () => {
    const { status, body } = await t.json(await t.call('/workflows/hold/open', { body: {} }))
    expect(status).toBe(202)
    expect(['pending', 'running']).toContain(body.status)
    expect(body.output).toBeUndefined()
    await t.call(`/runs/${body.runId}/cancel`, { method: 'POST' })
  })

  test('202 after a short wait, then run wait → 200 once the run ends', async () => {
    const started = await t.json(await t.call('/workflows/hold/open', { body: {}, headers: { prefer: 'wait=0.2' } }))
    expect(started.status).toBe(202)
    const { runId } = started.body

    const still = await t.json(await t.call(`/runs/${runId}/wait`, { method: 'POST', headers: { prefer: 'wait=0.2' } }))
    expect(still.status).toBe(202)
    expect(still.body.status).toBe('running')

    const waiting = t.call(`/runs/${runId}/wait`, { method: 'POST', headers: { prefer: 'wait=20' } })
    await Bun.sleep(100)
    t.gate.release()
    t.gate.reset()
    const ended = await t.json(await waiting)
    expect(ended.status).toBe(200)
    expect(ended.body).toMatchObject({ runId, status: 'done', output: { done: true } })

    expect((await t.json(await t.call(`/runs/${runId}`))).status).toBe(200)
  })

  test('an empty body starts a workflow whose input is all defaults', async () => {
    const response = await t.call('/workflows/echo/say', { method: 'POST', headers: { prefer: 'wait=10' } })
    expect(response.status).toBe(200)
    expect((await response.json()).output).toEqual({ text: 'hello' })
  })

  test('an unknown input key is 400 and starts nothing, on a workflow with defaults too', async () => {
    const before = (await t.pool.query(`select count(*)::int as n from "${t.schema}".runs`)).rows[0].n
    for (const [path, body] of [
      ['/workflows/smoke/ping', { text: 'x', txet: 'typo' }],
      ['/workflows/echo/say', { text: 'x', extra: 1 }],
    ] as const) {
      const { status, body: error } = await t.json(await t.call(path, { body }))
      expect(status).toBe(400)
      expect(error).toMatchObject({ code: 'BAD_REQUEST', status: 400 })
    }
    expect((await t.pool.query(`select count(*)::int as n from "${t.schema}".runs`)).rows[0].n).toBe(before)
    const doc = (await t.host.openapi()) as Record<string, any>
    expect(
      doc.paths['/workflows/smoke/ping'].post.requestBody.content['application/json'].schema.additionalProperties,
    ).toBe(false)
  })

  test('a done run whose output is null keeps `output: null` in every body', async () => {
    const started = await t.json(await t.call('/workflows/nothing/null', { body: {}, headers: { prefer: 'wait=10' } }))
    expect(started.status).toBe(200)
    expect(started.body).toMatchObject({ status: 'done', output: null })
    expect('output' in started.body).toBe(true)
    for (const body of [
      (await t.json(await t.call(`/runs/${started.body.runId}`))).body,
      (await t.json(await t.call(`/runs/${started.body.runId}/wait`, { method: 'POST' }))).body,
    ]) {
      expect(body).toEqual(started.body)
    }
    // ... while a run that has not produced output has no `output` key
    const held = await t.json(await t.call('/workflows/hold/open', { body: {} }))
    expect('output' in held.body).toBe(false)
    await t.call(`/runs/${held.body.runId}/cancel`, { method: 'POST' })
  })

  test('an invalid input is 400 BAD_REQUEST and starts nothing', async () => {
    const before = (await t.pool.query(`select count(*)::int as n from "${t.schema}".runs`)).rows[0].n
    const { status, body } = await t.json(await t.call('/workflows/echo/say', { body: { text: 7 } }))
    expect(status).toBe(400)
    expect(body).toMatchObject({ code: 'BAD_REQUEST', status: 400 })
    expect((await t.pool.query(`select count(*)::int as n from "${t.schema}".runs`)).rows[0].n).toBe(before)
    const junk = await t.json(await t.call('/workflows/echo/say', { body: {}, headers: { prefer: 'wait=soon' } }))
    expect(junk.status).toBe(400)
  })

  test('an Idempotency-Key replay returns the same run, and only one exists', async () => {
    const key = `key-${crypto.randomUUID()}`
    const first = await t.json(
      await t.call('/workflows/echo/say', {
        body: { text: 'once' },
        headers: { 'idempotency-key': key, prefer: 'wait=10' },
      }),
    )
    const second = await t.json(
      await t.call('/workflows/echo/say', {
        body: { text: 'once' },
        headers: { 'idempotency-key': key, prefer: 'wait=10' },
      }),
    )
    expect(second.status).toBe(200)
    expect(second.body.runId).toBe(first.body.runId)
    const count = await t.pool.query(`select count(*)::int as n from "${t.schema}".runs where idempotency_key = $1`, [
      key,
    ])
    expect(count.rows[0].n).toBe(1)
  })

  test('a replay with a different body is 409 CONFLICT naming the key; the first run stands', async () => {
    const key = `conflict-${crypto.randomUUID()}`
    const headers = { 'idempotency-key': key, prefer: 'wait=10' }
    const first = await t.json(await t.call('/workflows/echo/say', { body: { text: 'one' }, headers }))
    const second = await t.json(await t.call('/workflows/echo/say', { body: { text: 'two' }, headers }))
    expect(second.status).toBe(409)
    expect(second.body).toMatchObject({ defined: true, code: 'CONFLICT', status: 409 })
    expect(second.body.message).toContain(`"${key}"`)
    expect(second.body.data).toEqual({ runId: first.body.runId })
    const rows = await t.pool.query(`select input from "${t.schema}".runs where idempotency_key = $1`, [key])
    expect(rows.rows).toEqual([{ input: { text: 'one' } }])
    // the same body still replays; so does a body that differs only in what the defaults fill in
    expect((await t.json(await t.call('/workflows/echo/say', { body: { text: 'one' }, headers }))).body.runId).toBe(
      first.body.runId,
    )
  })

  test('the purpose defaults to prod and follows x-agw-purpose; a bad one is 400', async () => {
    const plain = await t.json(await t.call('/workflows/echo/say', { body: {}, headers: { prefer: 'wait=10' } }))
    const eval_ = await t.json(
      await t.call('/workflows/echo/say', { body: {}, headers: { prefer: 'wait=10', 'x-agw-purpose': 'eval' } }),
    )
    expect((await run(plain.body.runId)).purpose).toBe('prod')
    expect((await run(eval_.body.runId)).purpose).toBe('eval')
    const bad = await t.call('/workflows/echo/say', { body: {}, headers: { 'x-agw-purpose': 'has space' } })
    expect(bad.status).toBe(400)
  })

  test('a failed run is 200 with status failed and error.kind', async () => {
    const { status, body } = await t.json(
      await t.call('/workflows/boom/fail', { body: {}, headers: { prefer: 'wait=10' } }),
    )
    expect(status).toBe(200)
    expect(body.status).toBe('failed')
    expect(body.error).toEqual({ kind: 'step_failed', message: expect.stringContaining('boom') })
    expect(body.output).toBeUndefined()
  })
})

test('a failed journal read after the start still reports the run id', async () => {
  let failing = false
  const logger = captureLogger()
  const flaky = await startTestHost({
    prefix: 'flaky',
    logger,
    wrapStore: (store) => ({
      ping: () => store.ping(),
      get: (id) => (failing ? Promise.reject(new Error('connection lost')) : store.get(id)),
    }),
  })
  try {
    failing = true
    const { status, body } = await flaky.json(
      await flaky.call('/workflows/echo/say', { body: { text: 'x' }, headers: { prefer: 'wait=5' } }),
    )
    failing = false
    expect(status).toBe(202)
    expect(body).toMatchObject({ workflowId: 'echo.say', status: 'pending' })
    const row = (await flaky.pool.query(`select status from "${flaky.schema}".runs where id = $1`, [body.runId]))
      .rows[0]
    expect(row).toBeDefined()
    expect(logger.lines.some((l) => l.level === 'error' && l.message.includes('answering 202'))).toBe(true)
  } finally {
    await flaky.close()
  }
})

describe('a held wait survives transient read failures', () => {
  function flakyHost(prefix: string) {
    const control = { fail: 0, reads: 0 }
    const logger = captureLogger()
    const host = startTestHost({
      prefix,
      logger,
      wrapStore: (store) => ({
        ping: () => store.ping(),
        get: (id) => {
          control.reads++
          if (control.fail > 0) {
            control.fail--
            return Promise.reject(new Error('connection reset'))
          }
          return store.get(id)
        },
      }),
    })
    return { control, logger, host }
  }

  test('failed reads are logged and retried inside the wait; the run state still comes back', async () => {
    const { control, logger, host } = flakyHost('retry')
    const h = await host
    try {
      const done = await h.json(
        await h.call('/workflows/echo/say', { body: { text: 'ok' }, headers: { prefer: 'wait=10' } }),
      )
      control.fail = 3
      const waited = await h.json(
        await h.call(`/runs/${done.body.runId}/wait`, { method: 'POST', headers: { prefer: 'wait=10' } }),
      )
      expect(waited.status).toBe(200)
      expect(waited.body).toEqual(done.body)
      const warns = logger.lines.filter((l) => l.level === 'warn' && l.message === 'run state read failed')
      expect(warns.map((w) => w.meta?.attempt)).toEqual([1, 2, 3])
    } finally {
      await h.close()
    }
  })

  test('reads that keep failing end the wait with the error after 5 in a row, long before the deadline', async () => {
    const { control, host } = flakyHost('dead')
    const h = await host
    try {
      const done = await h.json(await h.call('/workflows/echo/say', { body: {}, headers: { prefer: 'wait=10' } }))
      control.fail = Number.POSITIVE_INFINITY
      control.reads = 0
      const started = Date.now()
      const { status, body } = await h.json(
        await h.call(`/runs/${done.body.runId}/wait`, { method: 'POST', headers: { prefer: 'wait=60' } }),
      )
      expect(status).toBe(500)
      expect(body).toMatchObject({ code: 'INTERNAL_SERVER_ERROR', defined: false })
      expect(control.reads).toBe(5)
      expect(Date.now() - started).toBeLessThan(3000)
    } finally {
      await h.close()
    }
  })

  test('the deadline bounds the retries too', async () => {
    const { control, host } = flakyHost('deadline')
    const h = await host
    try {
      const done = await h.json(await h.call('/workflows/echo/say', { body: {}, headers: { prefer: 'wait=10' } }))
      control.fail = Number.POSITIVE_INFINITY
      control.reads = 0
      const started = Date.now()
      // wait=0: a single read, no retry
      const none = await h.call(`/runs/${done.body.runId}/wait`, { method: 'POST' })
      expect(none.status).toBe(500)
      expect(control.reads).toBe(1)
      control.reads = 0
      const short = await h.call(`/runs/${done.body.runId}/wait`, { method: 'POST', headers: { prefer: 'wait=0.1' } })
      expect(short.status).toBe(500)
      expect(control.reads).toBeGreaterThan(1)
      expect(control.reads).toBeLessThan(5)
      expect(Date.now() - started).toBeLessThan(3000)
    } finally {
      await h.close()
    }
  })
})

describe('run ops', () => {
  test('status and wait of an unknown run are 404 NOT_FOUND', async () => {
    for (const [path, method] of [
      ['/runs/nope', 'GET'],
      ['/runs/nope/wait', 'POST'],
      ['/runs/nope/cancel', 'POST'],
    ] as const) {
      const { status, body } = await t.json(await t.call(path, { method }))
      expect(status).toBe(404)
      expect(body).toMatchObject({ code: 'NOT_FOUND', status: 404, message: 'Run nope not found' })
    }
  })

  test('cancel of a running run ends it cancelled (200 with its state)', async () => {
    const started = await t.json(await t.call('/workflows/hold/open', { body: {}, headers: { prefer: 'wait=0.2' } }))
    expect(started.body.status).toBe('running')
    const { status, body } = await t.json(await t.call(`/runs/${started.body.runId}/cancel`, { method: 'POST' }))
    expect(status).toBe(200)
    expect(body).toMatchObject({ runId: started.body.runId, status: 'cancelled', error: { kind: 'cancelled' } })
    const row = await until(async () => {
      const r = await run(started.body.runId)
      return r.status === 'cancelled' ? r : null
    }, 'cancelled row')
    expect(row.finished_at).not.toBeNull()
  })

  test('cancel validates Prefer before it cancels: a 400 changes nothing', async () => {
    const started = await t.json(await t.call('/workflows/hold/open', { body: {}, headers: { prefer: 'wait=0.2' } }))
    const bad = await t.call(`/runs/${started.body.runId}/cancel`, { method: 'POST', headers: { prefer: 'wait=soon' } })
    expect(bad.status).toBe(400)
    expect((await run(started.body.runId)).cancel_requested_at).toBeNull()
    expect((await t.json(await t.call(`/runs/${started.body.runId}`))).body.status).toBe('running')
    await t.call(`/runs/${started.body.runId}/cancel`, { method: 'POST' })
  })

  test('cancel with an explicit wait=0 does not hold for the default grace', async () => {
    const started = await t.json(await t.call('/workflows/hold/open', { body: {}, headers: { prefer: 'wait=0.2' } }))
    const at = Date.now()
    const { status } = await t.json(
      await t.call(`/runs/${started.body.runId}/cancel`, { method: 'POST', headers: { prefer: 'wait=0' } }),
    )
    expect([200, 202]).toContain(status)
    expect(Date.now() - at).toBeLessThan(2000)
    await until(async () => (await run(started.body.runId)).status === 'cancelled', 'cancelled row')
  })

  test('cancel of an ended run is 200 with its state, every time', async () => {
    const done = await t.json(
      await t.call('/workflows/echo/say', { body: { text: 'x' }, headers: { prefer: 'wait=10' } }),
    )
    for (let i = 0; i < 2; i++) {
      const again = await t.json(await t.call(`/runs/${done.body.runId}/cancel`, { method: 'POST' }))
      expect(again.status).toBe(200)
      expect(again.body).toEqual(done.body)
    }
    const failed = await t.json(await t.call('/workflows/boom/fail', { body: {}, headers: { prefer: 'wait=10' } }))
    const cancelFailed = await t.json(await t.call(`/runs/${failed.body.runId}/cancel`, { method: 'POST' }))
    expect(cancelFailed.body.status).toBe('failed')
  })

  test('run wait on an ended run answers at once, wait or not', async () => {
    const done = await t.json(await t.call('/workflows/echo/say', { body: {}, headers: { prefer: 'wait=10' } }))
    const started = Date.now()
    const waited = await t.json(
      await t.call(`/runs/${done.body.runId}/wait`, { method: 'POST', headers: { prefer: 'wait=30' } }),
    )
    expect(waited.status).toBe(200)
    expect(waited.body).toEqual(done.body)
    expect(Date.now() - started).toBeLessThan(2000)
  })

  test('a wait stops when the client goes away', async () => {
    const started = await t.json(await t.call('/workflows/hold/open', { body: {}, headers: { prefer: 'wait=0.1' } }))
    const abort = new AbortController()
    const waiting = t.host.fetch(
      new Request(`http://127.0.0.1:7791/runs/${started.body.runId}/wait`, {
        method: 'POST',
        headers: { authorization: `Bearer ${(await import('./support.ts')).SECRET}`, prefer: 'wait=200' },
        signal: abort.signal,
      }),
    )
    await Bun.sleep(100)
    abort.abort()
    const outcome = await Promise.race([
      waiting.then(
        () => 'returned',
        () => 'returned',
      ),
      Bun.sleep(3000).then(() => 'hung'),
    ])
    expect(outcome).toBe('returned')
    await t.call(`/runs/${started.body.runId}/cancel`, { method: 'POST' })
  })
})
