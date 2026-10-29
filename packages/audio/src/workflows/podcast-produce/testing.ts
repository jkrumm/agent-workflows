import type { ProduceInputValue } from '../podcast/produce-input.ts'

// Test support for production: a tone as s16le PCM, a stateful fake Audiobookshelf (uploads land as episodes once a
// scan ran), and a small episode input. Nothing here touches the network or the vault.

/** A sine tone, s16le mono: real audio that ffmpeg can measure and master. */
export function tonePcm(
  seconds: number,
  opts: { hz?: number; amplitude?: number; sampleRate?: number } = {},
): Uint8Array {
  const { hz = 220, amplitude = 0.3, sampleRate = 24_000 } = opts
  const samples = new Int16Array(Math.round(seconds * sampleRate))
  for (let i = 0; i < samples.length; i++)
    samples[i] = Math.round(Math.sin((2 * Math.PI * hz * i) / sampleRate) * amplitude * 32767)
  return new Uint8Array(samples.buffer)
}

const LIBRARY = { id: 'lib1', name: 'Podcasts', mediaType: 'podcast', folders: [{ id: 'f1', fullPath: '/podcasts' }] }

/**
 * A fake Audiobookshelf as `fetch`: one podcast library, one show; an upload becomes an episode at the next scan. Like
 * ABS, an upload of a file name already in the show folder replaces it (never a second episode). `hold` keeps the
 * first call to one `METHOD path` (prefix) waiting on `until`: a process killed mid-publish.
 */
export function fakeAudiobookshelf(options: { failOn?: string; hold?: { key: string; until: Promise<void> } } = {}) {
  let held = false
  const calls: { method: string; path: string }[] = []
  const pending: string[] = []
  const episodes: string[] = []
  let series = ''
  const json = (body: unknown) => Response.json(body)
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url))
    const method = (init?.method ?? 'GET').toUpperCase()
    const key = `${method} ${u.pathname}`
    calls.push({ method, path: u.pathname })
    if (options.failOn === key) return new Response('boom', { status: 500 })
    if (options.hold && !held && key.startsWith(options.hold.key)) {
      held = true
      await options.hold.until
    }
    if (key === 'GET /api/libraries') return json({ libraries: [LIBRARY] })
    if (key === 'POST /api/upload') {
      const form = init?.body as FormData
      series = String(form.get('title'))
      const name = (form.get('files[]') as File).name
      if (!pending.includes(name) && !episodes.includes(name)) pending.push(name)
      return new Response(null, { status: 200 })
    }
    if (key === `POST /api/libraries/${LIBRARY.id}/scan`) {
      episodes.push(...pending.splice(0))
      return new Response(null, { status: 200 })
    }
    if (key === `GET /api/libraries/${LIBRARY.id}/items`) {
      return json({ results: episodes.length > 0 ? [{ id: 'item1', media: { metadata: { title: series } } }] : [] })
    }
    if (key === 'GET /api/items/item1') {
      return json({
        id: 'item1',
        media: {
          metadata: { title: series, description: '' },
          coverPath: null,
          episodes: episodes.map((filename, i) => ({ id: `ep${i + 1}`, audioFile: { metadata: { filename } } })),
        },
      })
    }
    if (['PATCH /api/items/item1/media', 'POST /api/items/item1/cover'].includes(key)) return json({ ok: true })
    if (u.pathname.startsWith('/api/podcasts/item1/episode/') && method === 'PATCH') return json({ ok: true })
    return new Response(`unexpected ${key}`, { status: 404 })
  }) as unknown as typeof fetch
  return {
    impl,
    calls,
    episodes,
    count: (method: string, path: string) => calls.filter((c) => c.method === method && c.path === path).length,
  }
}

/** Two segments of three turns: with `multiSpeakerMaxChars` 60 every segment packs into two units. */
export function episodeInput(
  overrides: Partial<ProduceInputValue['request']> = {},
  id = crypto.randomUUID(),
): ProduceInputValue {
  return {
    episode: { id, createdAt: '2026-10-29T08:00:00.000Z' },
    script: {
      language: 'de',
      segments: [
        {
          title: 'Auftakt',
          turns: [
            { speaker: 'A', text: 'Heute geht es um die Woche, und wie man sie plant.' },
            { speaker: 'B', text: 'Echt?', delivery: 'curious' },
            { speaker: 'A', text: 'Ja, mit einer Liste, die jeder versteht und nutzt.' },
          ],
        },
        {
          title: 'Die Liste',
          turns: [
            { speaker: 'B', text: 'Was steht auf der Liste, und wer schreibt sie auf?' },
            { speaker: 'A', text: 'Drei Dinge pro Tag, nicht mehr als drei.' },
            { speaker: 'B', text: 'Das klingt machbar, sogar für mich.' },
          ],
        },
      ],
      wordCount: 52,
    },
    hosts: [
      { id: 'A', name: 'Jonas', voice: 'Charon', speed: 0.94 },
      { id: 'B', name: 'Lena', voice: 'Erinome', speed: 1 },
    ],
    metadata: {
      title: 'Die Woche planen',
      description: 'Zwei Hosts über eine Liste.',
      coverPrompt: 'A calendar on a desk',
      genres: ['Productivity'],
      topics: ['planning'],
    },
    request: {
      series: 'Test Show',
      language: 'de',
      minutes: 3,
      publish: true,
      cover: true,
      brainNote: true,
      ...overrides,
    },
    profile: {
      format: 'explainer',
      lead: 'A',
      humor: 'sparse',
      opening: 'question',
      minutes: 3,
      durationSeconds: null,
      topics: ['planning'],
      segmentCount: 2,
      toolCalls: 0,
      researchCalls: 0,
    },
  }
}
