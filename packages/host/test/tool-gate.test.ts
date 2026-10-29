import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Json, Usage } from '@agent-workflows/runtime'
import { type CapabilityCall, MAX_BODY_BYTES, type ToolCallRecord, ToolGate } from '../src/tool-gate/index.ts'

const usage = (cost: number): Usage => ({
  model: 'm',
  tokens: { input: 0, output: 0, cacheRead: 0, reasoning: 0 },
  cost,
  costSource: 'rate',
})

type Answer = { ok: boolean; result?: Json; error?: string; code?: string }

let dir: string
let gate: ToolGate
let capabilityCalls: { id: string; input: Json }[]
let errors: string[]
let capability: CapabilityCall

/** The default capability: answers with its id and input, and reports a cost of 1. */
const echo: CapabilityCall = async (id, input, { addUsage }) => {
  capabilityCalls.push({ id, input })
  addUsage(usage(1))
  return { id, input }
}

function makeGate(call: CapabilityCall = echo) {
  capability = call
  // Session ids in these tests are the step key itself.
  return new ToolGate({
    stateDir: dir,
    call: (id, input, scope) => capability(id, input, scope),
    belongsTo: (sessionId, stepKey) => sessionId === stepKey,
    logger: { warn: () => {}, error: (m) => errors.push(m) },
  })
}

async function gateFile() {
  return (await Bun.file(join(dir, 'gate.json')).json()) as { url: string; key: string }
}

/** What an agent's plugin does: POST the tool call with its session id and (by default) the gate's key. */
async function post(tool: string, session: string, args: Record<string, Json> = {}, key?: string | null) {
  const file = await gateFile()
  const token = key === undefined ? file.key : key
  const response = await fetch(`${file.url}/tool/${tool}`, {
    method: 'POST',
    headers: { ...(token === null ? {} : { authorization: `Bearer ${token}` }), 'content-type': 'application/json' },
    body: JSON.stringify({ sessionID: session, args }),
  })
  return { status: response.status, body: (await response.json()) as Answer }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agw-tool-gate-'))
  capabilityCalls = []
  errors = []
  gate = makeGate()
})
afterEach(async () => {
  await gate.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('grants', () => {
  test('two concurrent grants hold their own tools: a run reaches neither the other tool set nor the other session', async () => {
    const closeA = gate.open({ runId: 'a', stepId: 's', tools: { find: 'cap.find' } })
    const closeB = gate.open({ runId: 'b', stepId: 's', tools: { read: 'cap.read', list: 'cap.list' } })

    expect((await post('find', 'a:s', { q: 1 })).body).toEqual({
      ok: true,
      result: { id: 'cap.find', input: { q: 1 } },
    })
    expect((await post('read', 'b:s', { p: 2 })).body).toEqual({
      ok: true,
      result: { id: 'cap.read', input: { p: 2 } },
    })
    expect((await post('list', 'b:s')).body.ok).toBe(true)

    // Another grant's tool, from either side, and a tool nobody holds.
    for (const [tool, session] of [
      ['read', 'a:s'],
      ['list', 'a:s'],
      ['find', 'b:s'],
      ['nothing', 'a:s'],
    ] as const) {
      const refused = await post(tool, session)
      expect(refused.status).toBe(403)
      expect(refused.body).toEqual({ ok: false, error: `${tool} is not granted to this agent`, code: 'not_granted' })
    }
    // A session of a run that holds no grant (or another step of a granted run) resolves to none.
    expect((await post('find', 'c:s')).body.code).toBe('no_grant')
    expect((await post('find', 'a:other')).body.code).toBe('no_grant')

    expect(capabilityCalls.map((c) => c.id)).toEqual(['cap.find', 'cap.read', 'cap.list'])
    await closeA()
    await closeB()
  })

  test('a tool the grant does not hold never reaches a capability, and the hook is not told', async () => {
    const records: ToolCallRecord[] = []
    const close = gate.open({
      runId: 'a',
      stepId: 's',
      tools: { find: 'cap.find' },
      onCall: (call) => {
        records.push(call)
      },
    })
    const refused = await post('write', 'a:s', { x: 1 })
    expect(refused.status).toBe(403)
    expect(refused.body.code).toBe('not_granted')
    expect(capabilityCalls).toEqual([])
    expect(records).toEqual([])
    // Names that are properties of every object are not tools.
    expect((await post('constructor', 'a:s')).body.code).toBe('not_granted')
    expect((await post('__proto__', 'a:s')).body.code).toBe('not_granted')
    await close()
  })

  test("a grant's tool map is copied: changing the caller's object afterwards grants nothing", async () => {
    const tools: Record<string, string> = { find: 'cap.find' }
    const close = gate.open({ runId: 'a', stepId: 's', tools })
    tools.write = 'cap.write'
    expect((await post('write', 'a:s')).body.code).toBe('not_granted')
    expect(capabilityCalls).toEqual([])
    await close()
  })

  test('the hook sees the call and how the capability answered, a failure included', async () => {
    const records: ToolCallRecord[] = []
    capability = async (id, input, scope) => {
      if ((input as { fail?: boolean }).fail) throw new Error('capability down')
      return echo(id, input, scope)
    }
    const close = gate.open({
      runId: 'a',
      stepId: 's',
      tools: { find: 'cap.find' },
      onCall: (call) => {
        records.push(call)
      },
    })
    await post('find', 'a:s', { q: 'x' })
    const failed = await post('find', 'a:s', { fail: true })
    expect(failed.body).toEqual({ ok: false, error: 'capability down' })
    expect(records).toEqual([
      {
        runId: 'a',
        stepId: 's',
        tool: 'find',
        args: { q: 'x' },
        outcome: { ok: true, result: { id: 'cap.find', input: { q: 'x' } } },
      },
      { runId: 'a', stepId: 's', tool: 'find', args: { fail: true }, outcome: { ok: false, error: 'capability down' } },
    ])
    await close()
  })

  test('a hook that throws is logged and the call still answers', async () => {
    const close = gate.open({
      runId: 'a',
      stepId: 's',
      tools: { find: 'cap.find' },
      onCall: () => Promise.reject(new Error('ledger down')),
    })
    expect((await post('find', 'a:s')).body.ok).toBe(true)
    expect(errors).toEqual(['tool gate: the call hook failed; the call stands'])
    await close()
  })

  test('a second grant for the same step replaces the first', async () => {
    const first = gate.open({ runId: 'a', stepId: 's', tools: { find: 'cap.find' } })
    const second = gate.open({ runId: 'a', stepId: 's', tools: { read: 'cap.read' } })
    expect((await post('find', 'a:s')).body.code).toBe('not_granted')
    expect((await post('read', 'a:s')).body.ok).toBe(true)
    await first() // the replaced grant's close does not end the new one
    expect((await post('read', 'a:s')).body.ok).toBe(true)
    await second()
  })
})

describe('the door', () => {
  test('the bearer key is required: none, a wrong one and a different scheme are refused before anything runs', async () => {
    const close = gate.open({ runId: 'a', stepId: 's', tools: { find: 'cap.find' } })
    const file = await gateFile()
    expect((await post('find', 'a:s', {}, null)).body).toEqual({
      ok: false,
      error: 'unauthorized',
      code: 'unauthorized',
    })
    expect((await post('find', 'a:s', {}, 'wrong')).status).toBe(401)
    const basic = await fetch(`${file.url}/tool/find`, {
      method: 'POST',
      headers: { authorization: `Basic ${file.key}` },
      body: JSON.stringify({ sessionID: 'a:s' }),
    })
    expect(basic.status).toBe(401)
    expect(capabilityCalls).toEqual([])
    expect((await post('find', 'a:s')).status).toBe(200)
    await close()
  })

  test('gate.json is 0600 and holds the url and the key', async () => {
    gate.ensureServing()
    expect(statSync(join(dir, 'gate.json')).mode & 0o777).toBe(0o600)
    const file = await gateFile()
    expect(file.url).toStartWith('http://127.0.0.1:')
    expect(file.key).toMatch(/^[0-9a-f]{64}$/)
  })

  test('malformed and oversized bodies are refused with a code', async () => {
    const close = gate.open({ runId: 'a', stepId: 's', tools: { find: 'cap.find' } })
    const { url, key } = await gateFile()
    const headers = { authorization: `Bearer ${key}` }
    const bad = await fetch(`${url}/tool/find`, { method: 'POST', headers, body: '{"args":{}}' })
    expect(((await bad.json()) as Answer).code).toBe('bad_request')
    const big = await fetch(`${url}/tool/find`, { method: 'POST', headers, body: 'x'.repeat(MAX_BODY_BYTES + 1) })
    expect(big.status).toBe(413)
    expect(((await big.json()) as Answer).code).toBe('too_large')
    expect((await fetch(`${url}/elsewhere`, { method: 'POST', headers })).status).toBe(404)
    expect(capabilityCalls).toEqual([])
    await close()
  })
})

describe('usage', () => {
  test("each call's usage is booked into the step it ran for, held until that step binds", async () => {
    const closeA = gate.open({ runId: 'a', stepId: 's', tools: { find: 'cap.find' } })
    const closeB = gate.open({ runId: 'b', stepId: 's', tools: { find: 'cap.find' } })
    const a: number[] = []
    const b: number[] = []

    await post('find', 'a:s') // before anything is bound: held
    const unbindA = gate.bindUsage('a', 's', (u) => a.push(u.cost ?? 0))
    expect(a).toEqual([1]) // what was held arrives on bind
    const unbindB = gate.bindUsage('b', 's', (u) => b.push(u.cost ?? 0))
    await post('find', 'a:s')
    await post('find', 'b:s')
    await post('find', 'b:s')
    expect(a).toEqual([1, 1])
    expect(b).toEqual([1, 1])

    unbindA() // an unbound step holds its usage again
    await post('find', 'a:s')
    expect(a).toEqual([1, 1])
    const late: number[] = []
    gate.bindUsage('a', 's', (u) => late.push(u.cost ?? 0))
    expect(late).toEqual([1])
    expect(gate.bindUsage('nobody', 's', () => {})).toBeInstanceOf(Function)
    unbindB()
    await closeA()
    await closeB()
  })
})

describe('settle and close', () => {
  /** A capability that signals it is running and answers only when released: the deterministic in-flight window. */
  function held() {
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const call: CapabilityCall = async (id, input, scope) => {
      entered.resolve()
      await release.promise
      return echo(id, input, scope)
    }
    return { call, entered: entered.promise, release: release.resolve }
  }

  test('settle waits for the calls in flight, hook included, before it returns', async () => {
    const order: string[] = []
    const hold = held()
    gate = makeGate(async (id, input, scope) => {
      const result = await hold.call(id, input, scope)
      order.push('capability')
      return result
    })
    const close = gate.open({
      runId: 'a',
      stepId: 's',
      tools: { find: 'cap.find' },
      onCall: async () => {
        await Promise.resolve()
        order.push('hook')
      },
    })
    const pending = post('find', 'a:s')
    await hold.entered
    const settled = gate.settle('a', 's').then(() => order.push('settled'))
    hold.release()
    await settled
    expect(order).toEqual(['capability', 'hook', 'settled'])
    expect((await pending).body.ok).toBe(true)
    await close()
  })

  test('settle without a call in flight, or for an unknown step, returns at once', async () => {
    const close = gate.open({ runId: 'a', stepId: 's', tools: { find: 'cap.find' } })
    await gate.settle('a', 's')
    await gate.settle('nobody', 's')
    await close()
  })

  test('close revokes: the in-flight call is aborted, a later call is refused, and the grant is gone', async () => {
    const entered = Promise.withResolvers<void>()
    let aborted = false
    gate = makeGate(
      (_id, _input, { signal }) =>
        new Promise<Json>((_resolve, reject) => {
          entered.resolve()
          signal.addEventListener('abort', () => {
            aborted = true
            reject(signal.reason)
          })
        }),
    )
    const close = gate.open({ runId: 'a', stepId: 's', tools: { find: 'cap.find' } })
    const pending = post('find', 'a:s')
    await entered.promise
    await close()
    expect(aborted).toBe(true)
    expect((await pending).body.ok).toBe(false)
    expect((await post('find', 'a:s')).body.code).toBe('no_grant')
    await close() // idempotent
  })

  test('close of one grant leaves the others served', async () => {
    const closeA = gate.open({ runId: 'a', stepId: 's', tools: { find: 'cap.find' } })
    const closeB = gate.open({ runId: 'b', stepId: 's', tools: { find: 'cap.find' } })
    await closeA()
    expect((await post('find', 'a:s')).body.code).toBe('no_grant')
    expect((await post('find', 'b:s')).body.ok).toBe(true)
    await closeB()
  })

  test("the gate's close ends every grant, stops serving and removes gate.json only while it holds this key", async () => {
    gate.open({ runId: 'a', stepId: 's', tools: { find: 'cap.find' } })
    const file = join(dir, 'gate.json')
    expect(await Bun.file(file).exists()).toBe(true)
    const { url } = await gateFile()
    await gate.close()
    expect(await Bun.file(file).exists()).toBe(false)
    expect(fetch(`${url}/tool/find`, { method: 'POST', body: '{}' })).rejects.toBeDefined()

    // Another host's file is never removed, before or after this one.
    const first = makeGate()
    first.ensureServing()
    const bystander = makeGate()
    await bystander.close()
    expect(await Bun.file(file).exists()).toBe(true)
    const later = makeGate()
    later.ensureServing()
    await first.close()
    expect(await Bun.file(file).exists()).toBe(true)
    await later.close()
    expect(await Bun.file(file).exists()).toBe(false)
  })
})
