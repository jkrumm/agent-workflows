import { describe, expect, test } from 'bun:test'
import { createArgoPush, startArgoSchedule } from '../src/fleet/argo.ts'
import { argoTimerEnabled } from '../src/fleet/index.ts'
import type { OverviewPayload } from '../src/fleet/schema.ts'

const payload = {
  generatedAt: 1_800_000_000_000,
  staleAfterHours: 24,
  summary: { needsYou: 0, working: 1, idle: 0, stale: 0, done: 0 },
  projects: [{ name: 'p', cwd: '/x', git: null, agents: [{ id: 'a' }, { id: 'b' }] }],
  humanQueue: [],
  warnings: [],
  overview: null,
  quota: { accounts: {}, picks: {} },
} as unknown as OverviewPayload

function setup(
  over: { url?: string; secret?: string; fetcher?: typeof fetch; build?: () => Promise<OverviewPayload> } = {},
) {
  const sent: { url: string; init: RequestInit }[] = []
  const logs: { level: string; message: string; meta?: Record<string, unknown> }[] = []
  const fetcher =
    over.fetcher ??
    ((async (url: string, init: RequestInit) => {
      sent.push({ url, init })
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch)
  const push = createArgoPush({
    url: 'url' in over ? over.url : 'https://argo.example.com/api/',
    secret: 'secret' in over ? over.secret : 'tok',
    machine: 'host-1',
    build: over.build ?? (async () => payload),
    logger: {
      warn: (message, meta) => logs.push({ level: 'warn', message, meta }),
      info: (message, meta) => logs.push({ level: 'info', message, meta }),
    },
    fetcher,
  })
  return { push, sent, logs }
}

describe('Argo push', () => {
  test('posts the overview payload plus machine to /agents/overview with the bearer', async () => {
    const t = setup()
    expect(await t.push.push('timer')).toBe('ok')
    const [call] = t.sent
    expect(call?.url).toBe('https://argo.example.com/api/agents/overview')
    expect((call?.init.headers as Record<string, string> | undefined)?.authorization).toBe('Bearer tok')
    expect(call?.init.redirect).toBe('error')
    expect(JSON.parse(String(call?.init.body))).toEqual({
      ...payload,
      machine: 'host-1',
      generatedAt: payload.generatedAt,
    })
    expect(t.logs[0]).toMatchObject({ level: 'info', meta: { status: 'ok', trigger: 'timer', agents: 2 } })
  })

  test('the run that just ended stands in for the stored one', async () => {
    const seen: unknown[] = []
    const t = setup({
      build: async () => payload,
    })
    const withOverride = createArgoPush({
      url: 'https://argo.example.com/api',
      secret: 'tok',
      machine: 'm',
      build: async (overview) => {
        seen.push(overview)
        return payload
      },
      logger: { warn: () => {} },
      fetcher: (async () => new Response('{}')) as unknown as typeof fetch,
    })
    const output = { generatedAt: 1, model: 'x', snapshotGeneratedAt: 1, agents: [] }
    await withOverride.push('run', output)
    expect(seen).toEqual([output])
    expect(await t.push.push('run')).toBe('ok')
  })

  test('an Argo error is a warning and a status, never a throw', async () => {
    const t = setup({ fetcher: (async () => new Response('no', { status: 404 })) as unknown as typeof fetch })
    expect(await t.push.push('run')).toBe('http-error')
    expect(t.logs[0]).toMatchObject({ level: 'warn', meta: { status: 'http-error', httpStatus: 404 } })
  })

  test('a network failure is a warning and a status', async () => {
    const t = setup({
      fetcher: (async () => {
        throw new Error('ECONNRESET')
      }) as unknown as typeof fetch,
    })
    expect(await t.push.push('timer')).toBe('network-error')
    expect(t.logs[0]?.meta?.status).toBe('network-error')
  })

  test('a payload that cannot be built is skipped, nothing is sent', async () => {
    const t = setup({
      build: async () => {
        throw new Error('herdr exploded')
      },
    })
    expect(await t.push.push('timer')).toBe('build-error')
    expect(t.sent).toHaveLength(0)
  })

  test('off without a secret, a URL, or an https URL; the reason is logged once', async () => {
    for (const over of [{ secret: undefined }, { url: undefined }, { url: 'http://argo.example.com/api' }]) {
      const t = setup(over)
      expect(await t.push.push('timer')).toBe('disabled')
      expect(await t.push.push('timer')).toBe('disabled')
      expect(t.sent).toHaveLength(0)
      expect(t.logs.filter((l) => l.meta?.status === 'disabled')).toHaveLength(1)
    }
  })

  test('http is allowed on loopback only', async () => {
    const t = setup({ url: 'http://127.0.0.1:3000/api' })
    expect(await t.push.push('timer')).toBe('ok')
    expect(t.sent[0]?.url).toBe('http://127.0.0.1:3000/api/agents/overview')
  })
})

describe('Argo schedule', () => {
  function manual() {
    let tick: () => void = () => {}
    let stopped = false
    return {
      ticker: (fn: () => void) => {
        tick = fn
        return () => {
          stopped = true
        }
      },
      tick: () => tick(),
      stopped: () => stopped,
    }
  }

  test('pushes on a tick, skips a tick while a push is in flight, and stops', async () => {
    const clock = manual()
    const started: string[] = []
    let finishFirst: () => void = () => {}
    const firstDone = new Promise<void>((resolve) => {
      finishFirst = resolve
    })
    let secondStarted: () => void = () => {}
    const second = new Promise<void>((resolve) => {
      secondStarted = resolve
    })
    const push = {
      async push(trigger: 'run' | 'timer') {
        started.push(trigger)
        if (started.length === 1)
          await firstDone // the first push is slow
        else secondStarted()
        return 'ok' as const
      },
    }
    const schedule = startArgoSchedule({ push, ticker: clock.ticker })
    clock.tick()
    clock.tick() // in flight: skipped
    clock.tick()
    expect(started).toEqual(['timer'])
    finishFirst()
    await firstDone
    for (let i = 0; i < 5; i++) await Promise.resolve() // the first push's finally settles before the next tick
    clock.tick()
    await second
    expect(started).toEqual(['timer', 'timer'])
    schedule.stop()
    expect(clock.stopped()).toBe(true)
  })

  test('AGW_ARGO_PUSH turns the timer off; on by default', () => {
    expect(argoTimerEnabled({})).toBe(true)
    for (const off of ['0', 'off', 'false', 'no', 'OFF']) expect(argoTimerEnabled({ AGW_ARGO_PUSH: off })).toBe(false)
    expect(argoTimerEnabled({ AGW_ARGO_PUSH: '1' })).toBe(true)
  })
})
