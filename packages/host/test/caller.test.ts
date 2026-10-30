import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { startTestHost, type TestHost, until } from './support.ts'

// A door-tokens-file token: valid at the audio door, unknown to the host API.
const DOOR_TOKEN = 'iris-token-0123456789abcdef-0123456789ab'

let t: TestHost
beforeAll(async () => {
  t = await startTestHost({ prefix: 'caller', platform: true })
})
afterAll(async () => {
  await t.close()
})

const start = (headers: Record<string, string>) =>
  t.call('/workflows/echo/say', { body: { text: 'x' }, headers: { prefer: 'wait=20', ...headers } })

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

  test('a door token is not an API credential: 401 on every API path', async () => {
    const { runId } = await runRow(await start({}))
    const before = (await t.pool.query(`select count(*)::int as n from "${t.schema}".runs`)).rows[0].n
    for (const [path, init] of [
      ['/workflows/echo/say', { body: { text: 'x' } }],
      [`/runs/${runId}`, {}],
      ['/openapi.json', {}],
    ] as const) {
      const response = await t.call(path, { ...init, auth: DOOR_TOKEN, headers: { 'x-agw-caller': 'iris' } })
      expect(response.status).toBe(401)
      expect(response.headers.get('www-authenticate')).toBe('Bearer')
    }
    expect((await t.pool.query(`select count(*)::int as n from "${t.schema}".runs`)).rows[0].n).toBe(before)
  })

  test('the usage row gets project and caller: the declared repo, and the caller in lane_detail', async () => {
    const ping = async (headers: Record<string, string>) => {
      const response = await t.call('/workflows/smoke/ping', {
        method: 'POST',
        headers: { prefer: 'wait=20', ...headers },
      })
      const { runId } = (await runRow(response)) as { runId: string }
      await until(
        async () =>
          (await t.pool.query(`select post_hooks_at from "${t.schema}".runs where id = $1`, [runId])).rows[0]
            .post_hooks_at,
        'run record',
      )
      await t.platform?.outbox?.flush()
      return [...t.usage.stored.values()].find((r) => r.source_id.startsWith(`${runId}:title`))
    }
    expect(await ping({ 'x-agw-caller': 'claude-code', 'x-agw-project': 'agent-workflows' })).toMatchObject({
      project_raw: 'agent-workflows',
      repo: 'agent-workflows',
      lane_detail: { caller: 'claude-code' },
      raw: { caller: 'claude-code' },
    })
    expect(await ping({})).toMatchObject({
      project_raw: null,
      repo: null,
      lane_detail: { caller: 'agw' },
      raw: { caller: 'agw' },
    })
  })
})
