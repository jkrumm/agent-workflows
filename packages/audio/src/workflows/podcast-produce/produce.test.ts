import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { freshSchema, inspector, testRuntime, until } from '../../../../runtime/test/support/pg.ts'
import { geminiAudio, instantClock, silentLog, startFakeIu, testConfig } from '../../testing/index.ts'
import type { ProduceConfig } from './config.ts'
import { createProduceWorkflow, laneFor, type ProduceDeps, type ProduceResult, planSynthesis } from './index.ts'
import { episodeToken } from './abs.ts'
import { type ProduceJournal, postgresProduceJournal } from './journal.ts'
import { setProduceLogger } from './log.ts'
import { measureLoudnessLufs } from './mux.ts'
import { createPublishWorkflow } from './publish.ts'
import { episodeInput, fakeAudiobookshelf, tonePcm } from './testing.ts'

// Production on a real runtime (Postgres), the TTS lane over the fake IU, real ffmpeg for mastering, a fake
// Audiobookshelf and a temp git vault: the full pass, resume after a kill mid-synth (done units never synthesized
// again), the store-level reuse of audio an interrupted step left behind, publish idempotence on resume, the
// best-effort publish, and the `podcast-publish` follow-up.

setProduceLogger({ warn: () => {}, error: () => {} })

const db = freshSchema('produce')
const sql = inspector(db.schema)
const journal = postgresProduceJournal(sql.pool, db.schema)
const scratch = mkdtempSync(join(tmpdir(), 'agw-produce-'))
const artifactRoot = join(scratch, 'artifacts')
const lockDir = join(scratch, 'brain-sync.lock')
const ABS = { url: 'https://abs.example.com', apiKey: 'test-abs-key', library: 'Podcasts' }
const TIMEOUT = 120_000

/** Released at the end: requests a "killed" process left waiting. */
const parked: (() => void)[] = []
const never = () =>
  new Promise<void>((resolve) => {
    parked.push(resolve)
  })

const git = (cwd: string, ...args: string[]) => {
  const out = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' })
  if (out.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${out.stderr.toString()}`)
  return out.stdout.toString().trim()
}

/** A vault checkout with one commit and no push remote. */
function vault(): string {
  const dir = mkdtempSync(join(scratch, 'vault-'))
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'config', 'user.email', 'test@example.com')
  git(dir, 'config', 'user.name', 'Test')
  git(dir, 'config', 'commit.gpgsign', 'false')
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'init')
  return dir
}

const png = Bun.spawnSync(
  [
    'ffmpeg',
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'color=c=blue:s=16x16',
    '-frames:v',
    '1',
    '-f',
    'image2',
    '-c:v',
    'png',
    'pipe:1',
  ],
  { stdout: 'pipe' },
)
if (png.exitCode !== 0) throw new Error('ffmpeg could not render the test cover')
const COVER_B64 = Buffer.from(png.stdout).toString('base64')

const coverCalls: string[] = []
const cover: NonNullable<ProduceDeps['cover']> = {
  async call(input, { addUsage }) {
    coverCalls.push(input.prompt)
    addUsage({ model: 'image-test', tokens: { input: 10, output: 100, cacheRead: 0, reasoning: 0 }, cost: 0.04 })
    return { images: [{ b64: COVER_B64 }] }
  },
}

/** The fake IU's Gemini route: a tone per request; `hold` may park a request (a process killed mid-request). */
function fakeTts(hold?: (text: string, attempt: number) => Promise<void> | undefined) {
  const texts: string[] = []
  const iu = startFakeIu({
    async gemini(request) {
      const parts = (request.json?.contents as { parts: { text: string }[] }[] | undefined)?.[0]?.parts ?? []
      const text = parts.map((p) => p.text).join(' | ')
      texts.push(text)
      const wait = hold?.(text, texts.filter((t) => t === text).length)
      if (wait) await wait
      return geminiAudio(tonePcm(0.4 + parts.length * 0.2, { amplitude: 0.1 + texts.length * 0.02 }))
    },
  })
  return { iu, calls: (text: string) => texts.filter((t) => t === text).length, total: () => texts.length }
}

function produceWith(
  tts: ReturnType<typeof fakeTts>,
  opts: {
    abs?: ReturnType<typeof fakeAudiobookshelf>
    config?: Partial<ProduceConfig>
    concurrency?: number
    journal?: ProduceJournal
    notifyFetch?: typeof fetch
  } = {},
) {
  const deps: ProduceDeps = {
    journal: opts.journal ?? journal,
    ...(opts.notifyFetch ? { notifyFetch: opts.notifyFetch } : {}),
    audio: {
      config: testConfig(tts.iu.baseUrl, { ttsConcurrency: opts.concurrency ?? 2 }),
      fetch: tts.iu.fetch,
      clock: instantClock,
      log: silentLog,
      env: {},
    },
    cover,
    artifactRoot,
    config: { multiSpeakerMaxChars: 60, abs: ABS, brainDir: vault(), notify: null, ...opts.config },
    abs: { fetch: (opts.abs ?? fakeAudiobookshelf()).impl, sleep: async () => {}, pollIntervalMs: 1 },
    brainLock: { lockDir, lockRetryAttempts: 0 },
    now: () => new Date('2026-10-29T09:00:00.000Z'),
  }
  return createProduceWorkflow(deps)
}

/** The units the plan packs `input` into, with each unit's request text as the fake TTS sees it. */
function unitTexts(input = episodeInput()): string[] {
  const lane = laneFor({ ttsRouteId: 'audio.tts.gemini-flash', hostStyles: ['a', 'b'] } as ProduceConfig, {
    config: testConfig('https://iu.example.com/anthropic'),
    env: {},
  })
  const plan = planSynthesis(input, lane, {
    denseTurnThreshold: 0.12,
    denseTurnSlowdown: 0.06,
    multiSpeakerMaxChars: 60,
  })
  return plan.units.map((u) => u.turnIndexes.map((t) => plan.turns[t]?.text).join(' | '))
}

/** The per-unit child runs' `synth` steps, in unit order. */
async function unitSteps(runId: string) {
  const { rows } = await sql.pool.query(
    `select st.status, st.attempts, st.output, st.cost from "${db.schema}".runs r
       join "${db.schema}".steps st on st.run_id = r.id and st.step_id = 'synth'
      where r.parent_id = $1 and r.workflow = 'podcast.produce.unit' order by (r.input->>'index')::int`,
    [runId],
  )
  return rows as { status: string; attempts: number; output: Record<string, unknown>; cost: string | null }[]
}

function probe(path: string) {
  const out = Bun.spawnSync(
    ['ffprobe', '-v', 'error', '-show_chapters', '-show_format', '-show_streams', '-of', 'json', path],
    {
      stdout: 'pipe',
    },
  )
  return JSON.parse(out.stdout.toString()) as {
    chapters: { start_time: string; tags: { title: string } }[]
    format: { tags: Record<string, string> }
    streams: { codec_type: string; disposition?: { attached_pic: number } }[]
  }
}

/** One run on its own runtime: two variants of `podcast.produce` never share one. */
async function runOnce(workflow: ReturnType<typeof produceWith>, input: ReturnType<typeof episodeInput>) {
  const rt = testRuntime({ schema: db.schema, workflows: [workflow] })
  await rt.open()
  try {
    const { runId } = await rt.start(workflow, input, { purpose: 'build' })
    return { ...(await rt.wait(runId)), id: runId }
  } finally {
    await rt.close()
  }
}

beforeAll(async () => {
  const rt = testRuntime({ schema: db.schema, workflows: [] })
  await rt.open()
  await rt.close()
})

afterAll(async () => {
  for (const release of parked) release()
  await sql.close()
  await db.drop()
  rmSync(scratch, { recursive: true, force: true })
})

describe('podcast.produce', () => {
  test(
    'the full pass: synth per unit, cover, master (chapters, ID3, cover, loudness), publish, brain note, journaled cost',
    async () => {
      const tts = fakeTts()
      const abs = fakeAudiobookshelf()
      const produce = produceWith(tts, { abs })
      const rt = testRuntime({ schema: db.schema, workflows: [produce] })
      await rt.open()
      try {
        const input = episodeInput()
        const { runId } = await rt.start(produce, input, { purpose: 'build' })
        const result = await rt.wait(runId)
        expect(result.status).toBe('done')
        const out = result.output as ProduceResult
        const units = unitTexts(input)

        // One TTS request per unit; the segmentation lint over the same units.
        expect(tts.total()).toBe(units.length)
        expect(out.segmentation?.units).toBe(units.length)
        expect(out.turns).toBe(6)

        // Chapters per segment, the first at 0, the second where its first unit starts.
        expect(out.chapters.map((c) => c.title)).toEqual(['Auftakt', 'Die Liste'])
        expect(out.chapters[0]?.startMs).toBe(0)
        expect(out.chapters[1]?.startMs).toBeGreaterThan(0)
        expect(out.durationSeconds).toBeGreaterThan(1)

        // The MP3 in the artifact store: chapters, ID3 tags, the cover as attached picture, loudnorm'd to about -16.
        expect(out.mp3Path.startsWith(join(artifactRoot, 'podcast', input.episode.id))).toBe(true)
        const probed = probe(out.mp3Path)
        expect(probed.chapters.map((c) => c.tags.title)).toEqual(['Auftakt', 'Die Liste'])
        expect(probed.format.tags.title).toBe('Die Woche planen')
        expect(probed.format.tags.album).toBe('Test Show')
        expect(probed.format.tags.track).toBe('1')
        expect(probed.streams.some((s) => s.codec_type === 'video' && s.disposition?.attached_pic === 1)).toBe(true)
        expect(out.coverPath).toBe(join(artifactRoot, 'podcast', input.episode.id, 'cover.png'))
        const decoded = Bun.spawnSync(
          ['ffmpeg', '-v', 'error', '-i', out.mp3Path, '-f', 's16le', '-ac', '1', '-ar', '24000', 'pipe:1'],
          {
            stdout: 'pipe',
          },
        )
        const lufs = await measureLoudnessLufs(new Uint8Array(decoded.stdout), 24_000)
        expect(lufs).not.toBeNull()
        expect(Math.abs((lufs as number) + 16)).toBeLessThan(3)

        // Published once; the brain note committed (no push remote: logged, not fatal).
        expect(out.publish).toEqual({ requested: true, ok: true, error: null })
        expect(out.abs).toEqual({ url: 'https://abs.example.com/item/item1', libraryItemId: 'item1', episodeId: 'ep1' })
        expect(abs.count('POST', '/api/upload')).toBe(1)
        expect(abs.episodes).toEqual([`2026-10-29 Die Woche planen [${episodeToken(input.episode.id)}].mp3`])
        expect(out.brainNote).toMatchObject({ committed: true, pushed: false })
        const note = readFileSync(out.brainNote?.path as string, 'utf8')
        expect(note).toContain('abs: item1')
        expect(note).toMatch(/^date: 2026-10-29$/m)

        // The journal holds paths and hashes, never audio; the output's cost is the steps' recorded cost.
        const steps = await sql.steps(runId)
        const synth = await unitSteps(runId)
        expect(synth).toHaveLength(units.length)
        for (const s of synth) {
          expect(s).toMatchObject({ status: 'done', attempts: 1 })
          expect(Object.keys(s.output as object).sort()).toEqual(
            ['audioSeconds', 'bytes', 'inputChars', 'path', 'reused', 'sampleRate', 'sha256'].sort(),
          )
        }
        const recorded = [...steps, ...synth].reduce((n, s) => n + Number(s.cost ?? 0), 0)
        expect(recorded).toBeGreaterThan(0.04)
        expect(out.cost.usd).toBeCloseTo(recorded, 6)
        expect(out.cost.complete).toBe(true)
        for (const id of ['publish', 'brain-note', 'notify']) expect((await sql.step(runId, id))?.kind).toBe('effect')
      } finally {
        await rt.close()
        tts.iu.stop()
      }
    },
    TIMEOUT,
  )

  test(
    'resume after a kill mid-synth: finished units are not synthesized (or billed) again',
    async () => {
      const units = unitTexts()
      const heldText = units[2] as string
      // Unit 2's first request never answers: the process dies with it in flight.
      const tts = fakeTts((text, attempt) => (text === heldText && attempt === 1 ? never() : undefined))
      const produce = produceWith(tts, { concurrency: 8 })
      const first = testRuntime({ schema: db.schema, workflows: [produce] })
      await first.open()
      let runId = ''
      try {
        runId = (await first.start(produce, episodeInput(), { purpose: 'build' })).runId
        await until(
          async () => {
            const done = (await unitSteps(runId)).filter((s) => s.status === 'done').length
            return done === units.length - 1 && tts.calls(heldText) === 1
          },
          'every unit done but unit 2, which is in flight',
          60_000,
        )
      } finally {
        await first.close() // a deploy mid-synth: the run stays running
      }
      expect((await sql.run(runId))?.status).toBe('running')

      const second = testRuntime({ schema: db.schema, workflows: [produceWith(tts, { concurrency: 8 })] })
      await second.open()
      try {
        expect((await second.wait(runId)).status).toBe('done')
        // Done units replayed from the journal; the interrupted one ran again; the rest once.
        const synth = await unitSteps(runId)
        units.forEach((text, i) => {
          expect(tts.calls(text)).toBe(i === 2 ? 2 : 1)
          expect(synth[i]).toMatchObject({ status: 'done', attempts: i === 2 ? 2 : 1 })
        })
      } finally {
        await second.close()
        tts.iu.stop()
      }
    },
    TIMEOUT,
  )

  test(
    'audio an interrupted attempt already stored is reused from the artifact store, not synthesized again',
    async () => {
      const tts = fakeTts()
      const produce = produceWith(tts, { config: { abs: null } })
      const rt = testRuntime({ schema: db.schema, workflows: [produce] })
      await rt.open()
      try {
        const input = episodeInput({ publish: false, brainNote: false, cover: false })
        const first = await rt.wait((await rt.start(produce, input, { purpose: 'build' })).runId)
        expect(first.status).toBe('done')
        const synthesized = tts.total()
        // A second run of the same episode: every unit's audio is on disk for the same request, so no TTS call.
        const { runId } = await rt.start(produce, input, { purpose: 'build', idempotencyKey: 'second' })
        expect((await rt.wait(runId)).status).toBe('done')
        expect(tts.total()).toBe(synthesized)
        const reused = await unitSteps(runId)
        expect(reused).toHaveLength(unitTexts(input).length)
        expect(reused.every((s) => (s.output as { reused: boolean }).reused)).toBe(true)
        // The journal's hashes are what is on disk: pcm and sidecar per unit, nothing else in `units/`.
        const dir = join(artifactRoot, 'podcast', input.episode.id, 'units')
        expect(readdirSync(dir).filter((f) => f.endsWith('.pcm'))).toHaveLength(reused.length)
      } finally {
        await rt.close()
        tts.iu.stop()
      }
    },
    TIMEOUT,
  )

  test(
    'publish is idempotent on resume: a kill after the upload never uploads a second episode',
    async () => {
      const tts = fakeTts()
      // The first episode patch never answers: the process dies after upload and scan.
      const abs = fakeAudiobookshelf({ hold: { key: 'PATCH /api/podcasts/item1/episode/', until: never() } })
      const produce = produceWith(tts, { abs })
      const first = testRuntime({ schema: db.schema, workflows: [produce] })
      await first.open()
      let runId = ''
      try {
        runId = (await first.start(produce, episodeInput({ brainNote: false }), { purpose: 'build' })).runId
        await until(
          () => abs.count('PATCH', '/api/podcasts/item1/episode/ep1') === 1,
          'publish held at the episode patch',
          60_000,
        )
      } finally {
        await first.close()
      }

      const second = testRuntime({ schema: db.schema, workflows: [produce] })
      await second.open()
      try {
        const result = await second.wait(runId)
        expect(result.status).toBe('done')
        expect((result.output as ProduceResult).publish.ok).toBe(true)
        expect(abs.count('POST', '/api/upload')).toBe(1)
        expect(abs.count('POST', '/api/libraries/lib1/scan')).toBe(1)
        expect(abs.episodes).toHaveLength(1)
        expect(abs.count('PATCH', '/api/podcasts/item1/episode/ep1')).toBe(2)
        expect(await sql.step(runId, 'publish')).toMatchObject({ status: 'done', attempts: 2 })
      } finally {
        await second.close()
        tts.iu.stop()
      }
    },
    TIMEOUT,
  )

  test(
    'a failing Audiobookshelf, or none configured, ends the run done with publish.ok false',
    async () => {
      const tts = fakeTts()
      const failing = fakeAudiobookshelf({ failOn: 'POST /api/upload' })
      const broken = produceWith(tts, { abs: failing })
      const unconfigured = produceWith(tts, { config: { abs: null } })
      try {
        const failed = await runOnce(broken, episodeInput({ cover: false }))
        expect(failed.status).toBe('done')
        const out = failed.output as ProduceResult
        expect(out.publish.ok).toBe(false)
        expect(out.publish.error).toContain('HTTP 500')
        expect(out.abs).toBeNull()
        expect(out.coverPath).toBeNull()
        // The brain note is still filed, without an Audiobookshelf link.
        expect(out.brainNote?.committed).toBe(true)
        expect(readFileSync(out.brainNote?.path as string, 'utf8')).not.toContain('abs:')

        const skipped = await runOnce(unconfigured, episodeInput({ brainNote: false }))
        expect(skipped.status).toBe('done')
        expect((skipped.output as ProduceResult).publish).toEqual({
          requested: true,
          ok: false,
          error: 'not configured',
        })
        expect((skipped.output as ProduceResult).brainNote).toBeNull()
      } finally {
        tts.iu.stop()
      }
    },
    TIMEOUT,
  )

  test(
    "the Slack notice carries the whole episode's cost; a journal error there never fails the run",
    async () => {
      const NOTIFY = { channel: 'C0TESTCHAN1', argoBaseUrl: 'https://argo.example.com', argoApiSecret: 'test-secret' }
      const texts: string[] = []
      const notifyFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
        texts.push((JSON.parse(String(init?.body)) as { text: string }).text)
        return Response.json({ ok: true })
      }) as unknown as typeof fetch
      const tts = fakeTts()
      try {
        const sent = await runOnce(
          produceWith(tts, { config: { notify: NOTIFY }, notifyFetch }),
          episodeInput({ publish: false, brainNote: false }),
        )
        expect(sent.status).toBe('done')
        const whole = await journal.episodeCost(sent.id)
        expect(whole.usd).toBeGreaterThan(0.04)
        expect(texts).toHaveLength(1)
        expect(texts[0]).toContain(`Kosten: ${whole.usd.toFixed(2)} USD`)

        // Postgres fails while the notice is built: the run still files its brain note and ends done.
        const flaky: ProduceJournal = {
          ...journal,
          episodeCost: async () => {
            throw new Error('connection terminated')
          },
        }
        const failed = await runOnce(
          produceWith(tts, { config: { notify: NOTIFY }, notifyFetch, journal: flaky }),
          episodeInput({ publish: false }),
        )
        expect(failed.status).toBe('done')
        expect((failed.output as ProduceResult).brainNote?.committed).toBe(true)
        expect((await sql.step(failed.id, 'notify'))?.output).toEqual({ sent: false, error: 'connection terminated' })
        expect(texts).toHaveLength(1)
      } finally {
        tts.iu.stop()
      }
    },
    TIMEOUT,
  )

  test(
    'podcast-publish repeats only the upload of a produced episode, then files the note with its link',
    async () => {
      const tts = fakeTts()
      const abs = fakeAudiobookshelf()
      const brainDir = vault()
      const produce = produceWith(tts, { abs, config: { brainDir } })
      const publish = createPublishWorkflow({
        journal,
        config: { abs: ABS, brainDir, notify: null },
        abs: { fetch: abs.impl, sleep: async () => {}, pollIntervalMs: 1 },
        brainLock: { lockDir, lockRetryAttempts: 0 },
      })
      const rt = testRuntime({ schema: db.schema, workflows: [produce, publish] })
      await rt.open()
      try {
        const input = episodeInput({ publish: false })
        const producedId = (await rt.start(produce, input, { purpose: 'build' })).runId
        const produced = await rt.wait(producedId)
        expect(produced.status).toBe('done')
        const out = produced.output as ProduceResult
        expect(out.publish).toEqual({ requested: false, ok: null, error: null })
        expect(abs.calls).toHaveLength(0)
        const synthesized = tts.total()

        const { runId } = await rt.start(publish, { runId: producedId }, { purpose: 'build' })
        const result = await rt.wait(runId)
        expect(result.status).toBe('done')
        expect(result.output).toMatchObject({
          produceRunId: producedId,
          publish: { requested: true, ok: true, error: null },
          abs: { libraryItemId: 'item1' },
          brainNote: { committed: true },
        })
        expect(abs.count('POST', '/api/upload')).toBe(1)
        expect(tts.total()).toBe(synthesized)
        expect(readFileSync(out.brainNote?.path as string, 'utf8')).toContain('abs: item1')
        expect(Number(git(brainDir, 'rev-list', '--count', 'HEAD'))).toBe(3)
        expect(git(brainDir, 'log', '-1', '--format=%B')).toContain(`Effect-Key: ${runId}:brain-note`)

        const missing = await rt.wait((await rt.start(publish, { runId: 'no-such-run' }, { purpose: 'build' })).runId)
        expect(missing.status).toBe('failed')
        expect(existsSync(out.mp3Path)).toBe(true)
      } finally {
        await rt.close()
        tts.iu.stop()
      }
    },
    TIMEOUT,
  )
})
