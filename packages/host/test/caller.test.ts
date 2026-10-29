import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { parseApiCallers } from '../src/auth.ts'
import { SECRET, startTestHost, type TestHost, until } from './support.ts'

const IRIS = 'iris-token-0123456789abcdef-0123456789ab'
const HERMES = 'hermes-token-0123456789abcdef-0123456789'
const DOOR_TOKENS = new Map([
  ['iris', IRIS],
  ['hermes', HERMES],
])

let t: TestHost
beforeAll(async () => {
  // The deploy lists `iris` for the API; `hermes` stays a door token only.
  t = await startTestHost({ prefix: 'caller', platform: true, callers: parseApiCallers('iris', DOOR_TOKENS) })
})
afterAll(async () => {
  await t.close()
})

const start = (headers: Record<string, string>, auth?: string | null) =>
  t.call('/workflows/echo/say', { body: { text: 'x' }, headers: { prefer: 'wait=20', ...headers }, auth })

async function runRow(response: Response) {
  expect(response.status).toBe(200)
  const { runId } = (await response.json()) as { runId: string }
  const { rows } = await t.pool.query(`select caller, project, workspace from "${t.schema}".runs where id = $1`, [
    runId,
  ])
  return { runId, row: rows[0] }
}

describe('caller attribution at the host door', () => {
  test('the API secret with no header is caller agw, no project', async () => {
    expect((await runRow(await start({}))).row).toEqual({ caller: 'agw', project: null, workspace: null })
  })

  test('the API secret may declare a sub-caller, a project and a workspace', async () => {
    const { row } = await runRow(
      await start({ 'x-agw-caller': 'claude-code', 'x-agw-project': 'agent-workflows', 'x-agw-workspace': 'private' }),
    )
    expect(row).toEqual({ caller: 'claude-code', project: 'agent-workflows', workspace: 'private' })
  })

  test('a project alone keeps the caller agw', async () => {
    expect((await runRow(await start({ 'x-agw-project': 'a-repo' }))).row).toEqual({
      caller: 'agw',
      project: 'a-repo',
      workspace: null,
    })
  })

  test('a malformed declaration is a 400 that starts nothing', async () => {
    const count = async () => (await t.pool.query(`select count(*)::int as n from "${t.schema}".runs`)).rows[0].n
    const before = await count()
    const bad: Record<string, string>[] = [
      { 'x-agw-caller': 'Bad Caller' },
      { 'x-agw-caller': '1abc' },
      { 'x-agw-caller': 'a'.repeat(33) },
      { 'x-agw-project': '../etc' },
      { 'x-agw-project': '/Users/someone/repo' },
      { 'x-agw-project': '.hidden' },
      { 'x-agw-workspace': 'elsewhere' },
    ]
    for (const headers of bad) {
      const response = await start(headers)
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({ code: 'BAD_REQUEST' })
    }
    expect(await count()).toBe(before)
  })

  test('a listed door token fixes the caller to its name; no header overrides it', async () => {
    const { row } = await runRow(
      await start({ 'x-agw-caller': 'agw', 'x-agw-project': 'forged', 'x-agw-workspace': 'work' }, IRIS),
    )
    expect(row).toEqual({ caller: 'iris', project: null, workspace: null })
  })

  test('a door token the deploy did not list is refused on every API path', async () => {
    const { runId } = await runRow(await start({}))
    for (const [path, init] of [
      ['/workflows/echo/say', { body: { text: 'x' } }],
      [`/runs/${runId}`, {}],
      ['/openapi.json', {}],
    ] as const) {
      const response = await t.call(path, { ...init, auth: HERMES })
      expect(response.status).toBe(401)
      expect(response.headers.get('www-authenticate')).toBe('Bearer')
    }
    // Listed, the same token passes.
    expect((await t.call('/openapi.json', { auth: IRIS })).status).toBe(200)
  })

  test('with no allowlist no door token opens the API, only the secret does', async () => {
    const none = await startTestHost({ prefix: 'callernone', callers: parseApiCallers(undefined, DOOR_TOKENS) })
    try {
      expect((await none.call('/openapi.json', { auth: IRIS })).status).toBe(401)
      expect((await none.call('/openapi.json', { auth: SECRET })).status).toBe(200)
    } finally {
      await none.close()
    }
  })

  test('Argo gets project and caller: the declared repo, else the caller', async () => {
    const ping = async (headers: Record<string, string>, auth?: string) => {
      const response = await t.call('/workflows/smoke/ping', {
        method: 'POST',
        headers: { prefer: 'wait=20', ...headers },
        auth,
      })
      const { runId } = (await runRow(response)) as { runId: string }
      await until(
        async () =>
          (await t.pool.query(`select post_hooks_at from "${t.schema}".runs where id = $1`, [runId])).rows[0]
            .post_hooks_at,
        'run record',
      )
      await t.platform?.outbox?.flush()
      return [...t.argo.stored.values()].find((r) => r.source_id.startsWith(`${runId}:title`))
    }
    expect(await ping({ 'x-agw-caller': 'claude-code', 'x-agw-project': 'agent-workflows' })).toMatchObject({
      project: 'agent-workflows',
      raw: { caller: 'claude-code' },
    })
    expect(await ping({}, IRIS)).toMatchObject({ project: 'iris', raw: { caller: 'iris' } })
    expect(await ping({})).toMatchObject({ project: 'agw', raw: { caller: 'agw' } })
  })
})

describe('parseApiCallers', () => {
  test('unset, empty and blank lists allow none', () => {
    for (const raw of [undefined, '', ' , ']) expect(parseApiCallers(raw, DOOR_TOKENS).size).toBe(0)
  })

  test('picks the listed names from the door tokens', () => {
    expect([...parseApiCallers(' iris , hermes ', DOOR_TOKENS).keys()]).toEqual(['iris', 'hermes'])
  })

  test('refuses every bad name at once, never echoing a token', () => {
    let message = ''
    try {
      parseApiCallers('agw,Nope,absent', DOOR_TOKENS)
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toContain('"agw"')
    expect(message).toContain('"Nope"')
    expect(message).toContain('"absent" has no token')
    expect(message).not.toContain(IRIS)
  })
})
