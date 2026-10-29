import { afterAll, beforeAll, expect, test } from 'bun:test'
import { z } from 'zod'
import { defineWorkflow } from '../../../../runtime/src/index.ts'
import { freshSchema, inspector, testRuntime } from '../../../../runtime/test/support/pg.ts'
import { postgresJournal } from '../podcast/history.ts'
import { createPodcastWorkflow } from '../podcast/index.ts'
import { ProduceInput } from '../podcast/produce-input.ts'
import { fakeHistory, fakeRoom } from '../podcast/testing.ts'

// Legacy's Slack line for a failed episode ("Podcast-Job <id8> ist fehlgeschlagen: <message>"), posted once at the
// root when production fails; none without legacy's Slack env.

const db = freshSchema('notice')
const sql = inspector(db.schema)
const journal = postgresJournal(sql.pool, db.schema)
const NOTIFY = { channel: 'C0TESTCHAN1', argoBaseUrl: 'https://argo.example.com', argoApiSecret: 'test-secret' }

beforeAll(async () => {
  const rt = testRuntime({ schema: db.schema, workflows: [] })
  await rt.open()
  await rt.close()
})

afterAll(async () => {
  await sql.close()
  await db.drop()
})

const failingProduce = defineWorkflow({
  id: 'podcast.produce',
  version: 'test',
  input: ProduceInput,
  output: z.looseObject({}),
  async run() {
    throw new Error('synth exploded')
  },
})

const config = {
  hosts: [
    { id: 'A' as const, name: 'Jonas', voice: 'voice-a', speed: 0.94 },
    { id: 'B' as const, name: 'Lena', voice: 'voice-b', speed: 1 },
  ] as [
    { id: 'A'; name: string; voice: string; speed: number },
    { id: 'B'; name: string; voice: string; speed: number },
  ],
  agentic: false,
  voicePath: null,
}

test('a failed episode posts legacy failure line once; without the Slack env nothing is sent', async () => {
  const posts: { url: string; body: { text: string } }[] = []
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    posts.push({ url: String(url), body: JSON.parse(String(init?.body)) as { text: string } })
    return Response.json({ ok: true })
  }) as unknown as typeof fetch
  const notified = createPodcastWorkflow({
    journal,
    history: fakeHistory(),
    models: fakeRoom(),
    produce: failingProduce,
    config,
    notify: { config: NOTIFY, fetch: fetchImpl },
  })
  const rt = testRuntime({ schema: db.schema, workflows: [notified] })
  await rt.open()
  try {
    const { runId } = await rt.start(notified, { source: 'Notizen.', research: false }, { purpose: 'build' })
    expect((await rt.wait(runId)).status).toBe('failed')
    expect(posts).toHaveLength(1)
    expect(posts[0]?.url).toBe('https://argo.example.com/slack/channels/C0TESTCHAN1/messages')
    expect(posts[0]?.body.text).toStartWith(`Podcast-Job ${runId.slice(0, 8)} ist fehlgeschlagen: `)
    expect(posts[0]?.body.text).toContain('podcast.produce failed')
  } finally {
    await rt.close()
  }

  const silent = createPodcastWorkflow({
    journal,
    history: fakeHistory(),
    models: fakeRoom(),
    produce: failingProduce,
    config,
    notify: { config: null, fetch: fetchImpl },
  })
  const quiet = testRuntime({ schema: db.schema, workflows: [silent] })
  await quiet.open()
  try {
    const { runId } = await quiet.start(silent, { source: 'Notizen.', research: false }, { purpose: 'build' })
    expect((await quiet.wait(runId)).status).toBe('failed')
    expect(posts).toHaveLength(1)
  } finally {
    await quiet.close()
  }
}, 60_000)
