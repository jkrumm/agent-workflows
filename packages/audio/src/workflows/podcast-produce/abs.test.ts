import { describe, expect, test } from 'bun:test'
import {
  AbsError,
  type AbsDeps,
  type AbsPublishInput,
  episodeFilename,
  filenameMatches,
  findPublishedEpisode,
  publishToAudiobookshelf,
  slugifyFilename,
} from './abs.ts'
import { setProduceLogger } from './log.ts'

setProduceLogger({ warn: () => {}, error: () => {} })

// Ports audio-gateway/src/audiobookshelf.test.ts (+ the slugifyFilename / episodeFilename cases of podcasts.test.ts) onto
// an injected fake ABS server: it records every call and keeps just enough state (uploaded, scanned) for the polling to work.

/** The error a promise rejects with; fails the test when it resolves. */
async function rejected(promise: Promise<unknown>): Promise<Error> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  )
  if (!(error instanceof Error)) throw new Error('expected a rejection')
  return error
}

const SERIES = 'A Different Show'
const FILENAME = '2026-09-07 Episode One [c2e279c6].mp3'
const LIBRARY = {
  id: 'lib1',
  name: 'Podcasts',
  mediaType: 'podcast',
  folders: [{ id: 'f1', fullPath: '/podcasts' }],
}

interface Call {
  method: string
  path: string
  search: string
  body: unknown
}

interface FakeOptions {
  libraries?: unknown[]
  /** The show exists with this description / cover before any upload. */
  existingShow?: { description: string; coverPath: string | null; episodes: string[] }
  /** Never list the uploaded episode, even after a scan. */
  neverAppears?: boolean
  /** Fail the call with this "METHOD path" with HTTP 500. */
  failOn?: string
  /** The server answers 200 with a body that is not JSON. */
  garbageLibraries?: boolean
}

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function fakeAbs(options: FakeOptions = {}) {
  const calls: Call[] = []
  let scanned = false
  const show = options.existingShow
  const episodeFiles = (): string[] => {
    const files = [...(show?.episodes ?? [])]
    if (scanned && !options.neverAppears) files.push(FILENAME)
    return files
  }
  const showExists = () => show !== undefined || (scanned && !options.neverAppears)

  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url))
    const method = (init?.method ?? 'GET').toUpperCase()
    const body = init?.body instanceof FormData ? init.body : init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ method, path: u.pathname, search: u.search, body })
    const key = `${method} ${u.pathname}`
    if (options.failOn === key) return new Response('boom', { status: 500 })

    if (key === 'GET /api/libraries') {
      if (options.garbageLibraries) return new Response('<html>', { status: 200 })
      return jsonRes({ libraries: options.libraries ?? [LIBRARY] })
    }
    if (key === 'POST /api/upload') return new Response(null, { status: 200 })
    if (key === `POST /api/libraries/${LIBRARY.id}/scan`) {
      scanned = true
      return new Response(null, { status: 200 })
    }
    if (key === `GET /api/libraries/${LIBRARY.id}/items`) {
      return jsonRes({
        results: showExists()
          ? [{ id: 'item1', media: { metadata: { title: SERIES, description: show?.description ?? '' } } }]
          : [],
      })
    }
    if (key === 'GET /api/items/item1') {
      return jsonRes({
        id: 'item1',
        media: {
          metadata: { title: SERIES, description: show?.description ?? '' },
          coverPath: show?.coverPath ?? null,
          episodes: episodeFiles().map((filename, i) => ({
            id: `ep${i + 1}`,
            title: 'placeholder',
            audioFile: { metadata: { filename } },
          })),
        },
      })
    }
    if (['PATCH /api/items/item1/media', 'POST /api/items/item1/cover'].includes(key)) return jsonRes({ ok: true })
    if (u.pathname.startsWith('/api/podcasts/item1/episode/') && method === 'PATCH') return jsonRes({ ok: true })
    throw new Error(`unexpected fetch: ${key}`)
  }) as unknown as typeof fetch

  const count = (method: string, path: string) => calls.filter((c) => c.method === method && c.path === path).length
  return { impl, calls, count }
}

function depsFor(fake: ReturnType<typeof fakeAbs>, extra: Partial<AbsDeps> = {}) {
  const sleeps: number[] = []
  let clock = 1_000
  const deps: AbsDeps = {
    config: { url: 'https://abs.example.com', apiKey: 'test-abs-key', library: 'Podcasts' },
    fetch: fake.impl,
    sleep: async (ms) => {
      sleeps.push(ms)
      clock += ms
    },
    now: () => clock,
    ...extra,
  }
  return { deps, sleeps }
}

function input(overrides: Partial<AbsPublishInput> = {}): AbsPublishInput {
  return {
    series: SERIES,
    author: 'Hermes',
    description: 'A daily briefing show.',
    language: 'en',
    genres: ['News'],
    episode: {
      title: 'Episode One',
      description: 'What happened today.',
      filename: FILENAME,
      file: new Uint8Array([1, 2, 3]),
    },
    ...overrides,
  }
}

const bodyOf = (fake: ReturnType<typeof fakeAbs>, method: string, path: string) =>
  fake.calls.find((c) => c.method === method && c.path === path)?.body as Record<string, unknown> | undefined

describe('publishToAudiobookshelf: new podcast', () => {
  test('uploads, scans, finds the item, patches media, cover and episode', async () => {
    const fake = fakeAbs()
    const { deps } = depsFor(fake)

    const result = await publishToAudiobookshelf(deps, input({ cover: new Uint8Array([9, 9, 9]) }))

    expect(result).toEqual({
      libraryId: 'lib1',
      libraryItemId: 'item1',
      episodeId: 'ep1',
      url: 'https://abs.example.com/item/item1',
    })
    expect(fake.count('POST', '/api/upload')).toBe(1)
    expect(fake.count('POST', '/api/libraries/lib1/scan')).toBe(1)
    const upload = bodyOf(fake, 'POST', '/api/upload') as unknown as FormData
    expect(upload.get('title')).toBe(SERIES)
    expect(upload.get('library')).toBe('lib1')
    expect(upload.get('folder')).toBe('f1')
    expect((upload.get('files[]') as File).name).toBe(FILENAME)
    expect(bodyOf(fake, 'PATCH', '/api/items/item1/media')?.metadata).toEqual({
      title: SERIES,
      author: 'Hermes',
      description: 'A daily briefing show.',
      genres: ['News'],
      language: 'en',
    })
    expect(fake.count('POST', '/api/items/item1/cover')).toBe(1)
    const episodePatch = bodyOf(fake, 'PATCH', '/api/podcasts/item1/episode/ep1')
    expect(episodePatch).toEqual({
      title: 'Episode One',
      description: 'What happened today.',
      publishedAt: 1_000,
    })
  })

  test('sends the bearer key and the poll query on every request', async () => {
    const seen: Array<string | null> = []
    const fake = fakeAbs()
    const { deps } = depsFor(fake, {
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        seen.push(new Headers(init?.headers).get('authorization'))
        return fake.impl(url, init)
      }) as unknown as typeof fetch,
    })
    await publishToAudiobookshelf(deps, input())
    expect(seen.every((h) => h === 'Bearer test-abs-key')).toBe(true)
    expect(fake.calls.find((c) => c.path === '/api/libraries/lib1/items')?.search).toBe(
      '?limit=100&sort=addedAt&desc=1',
    )
    expect(fake.calls.find((c) => c.path === '/api/items/item1')?.search).toBe('?expanded=1')
  })

  test('resolves the library by id as well as by name', async () => {
    const fake = fakeAbs()
    const { deps } = depsFor(fake, { config: { url: 'https://abs.example.com', apiKey: 'k', library: 'lib1' } })
    const result = await publishToAudiobookshelf(deps, input())
    expect(result.libraryId).toBe('lib1')
  })

  test('waits through polls where the scan has not surfaced the episode yet', async () => {
    const fake = fakeAbs()
    let itemPolls = 0
    const { deps, sleeps } = depsFor(fake, {
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        if (new URL(String(url)).pathname === '/api/libraries/lib1/items' && fake.count('POST', '/api/upload') > 0) {
          itemPolls++
          if (itemPolls < 3) return jsonRes({ results: [] })
        }
        return fake.impl(url, init)
      }) as unknown as typeof fetch,
    })
    const result = await publishToAudiobookshelf(deps, input())
    expect(result.episodeId).toBe('ep1')
    expect(sleeps).toEqual([2000, 2000])
  })
})

describe('publishToAudiobookshelf: existing podcast', () => {
  test('a second episode does not clobber an existing description or cover', async () => {
    const fake = fakeAbs({
      existingShow: {
        description: 'A hand-edited show description.',
        coverPath: '/covers/item1.png',
        episodes: ['episode-old.mp3'],
      },
    })
    const { deps } = depsFor(fake)

    const result = await publishToAudiobookshelf(deps, input({ cover: new Uint8Array([9]) }))

    expect(result.episodeId).toBe('ep2')
    expect(fake.count('PATCH', '/api/items/item1/media')).toBe(0)
    expect(fake.count('POST', '/api/items/item1/cover')).toBe(0)
    expect(fake.count('PATCH', '/api/podcasts/item1/episode/ep2')).toBe(1)
  })

  test('uploads a cover for an existing show that has none, without touching its description', async () => {
    const fake = fakeAbs({ existingShow: { description: 'Edited.', coverPath: null, episodes: [] } })
    const { deps } = depsFor(fake)
    await publishToAudiobookshelf(deps, input({ cover: new Uint8Array([9]) }))
    expect(fake.count('PATCH', '/api/items/item1/media')).toBe(0)
    expect(fake.count('POST', '/api/items/item1/cover')).toBe(1)
  })
})

describe('publishToAudiobookshelf: already published (resume)', () => {
  test('skips upload and scan, still patches the found item', async () => {
    const fake = fakeAbs({
      existingShow: { description: '', coverPath: null, episodes: [FILENAME.replace('Episode One', 'Episode  One')] },
    })
    const { deps, sleeps } = depsFor(fake)

    const result = await publishToAudiobookshelf(deps, input({ cover: new Uint8Array([9]) }))

    expect(result).toEqual({
      libraryId: 'lib1',
      libraryItemId: 'item1',
      episodeId: 'ep1',
      url: 'https://abs.example.com/item/item1',
    })
    expect(fake.count('POST', '/api/upload')).toBe(0)
    expect(fake.count('POST', '/api/libraries/lib1/scan')).toBe(0)
    expect(sleeps).toEqual([])
    expect(fake.count('PATCH', '/api/items/item1/media')).toBe(1)
    expect(fake.count('POST', '/api/items/item1/cover')).toBe(1)
    expect(fake.count('PATCH', '/api/podcasts/item1/episode/ep1')).toBe(1)
  })

  test('running the publish twice uploads exactly once', async () => {
    const fake = fakeAbs()
    const { deps } = depsFor(fake)
    const first = await publishToAudiobookshelf(deps, input())
    const second = await publishToAudiobookshelf(deps, input())
    expect(second).toEqual(first)
    expect(fake.count('POST', '/api/upload')).toBe(1)
    expect(fake.count('POST', '/api/libraries/lib1/scan')).toBe(1)
  })
})

describe('findPublishedEpisode', () => {
  test('returns null when the show is not in the library', async () => {
    const fake = fakeAbs()
    const { deps } = depsFor(fake)
    expect(await findPublishedEpisode(deps, { series: SERIES, filename: FILENAME })).toBeNull()
    expect(fake.count('POST', '/api/upload')).toBe(0)
  })

  test('returns null when the show exists but the episode does not', async () => {
    const fake = fakeAbs({ existingShow: { description: 'd', coverPath: null, episodes: ['other [11111111].mp3'] } })
    const { deps } = depsFor(fake)
    expect(await findPublishedEpisode(deps, { series: SERIES, filename: FILENAME })).toBeNull()
  })

  test('returns the published episode by its job token, with one poll and no writes', async () => {
    const fake = fakeAbs({ existingShow: { description: 'd', coverPath: null, episodes: ['x', FILENAME] } })
    const { deps } = depsFor(fake)
    expect(await findPublishedEpisode(deps, { series: SERIES, filename: FILENAME })).toEqual({
      libraryId: 'lib1',
      libraryItemId: 'item1',
      episodeId: 'ep2',
      url: 'https://abs.example.com/item/item1',
    })
    expect(fake.calls.every((c) => c.method === 'GET')).toBe(true)
  })
})

describe('publishToAudiobookshelf: failures', () => {
  test('a missing podcast library throws AbsError naming the configured library and the podcast ones', async () => {
    const fake = fakeAbs({
      libraries: [
        { id: 'lib2', name: 'Audiobooks', mediaType: 'book', folders: [] },
        { id: 'lib3', name: 'Other Show', mediaType: 'podcast', folders: [] },
      ],
    })
    const { deps } = depsFor(fake)
    const error = await rejected(publishToAudiobookshelf(deps, input()))
    expect(error).toBeInstanceOf(AbsError)
    expect(error.message).toContain('"Podcasts"')
    expect(error.message).toContain('Other Show')
    expect(fake.count('POST', '/api/upload')).toBe(0)
  })

  test('a library without folders throws AbsError before uploading', async () => {
    const fake = fakeAbs({ libraries: [{ ...LIBRARY, folders: [] }] })
    const { deps } = depsFor(fake)
    expect(await rejected(publishToAudiobookshelf(deps, input()))).toBeInstanceOf(AbsError)
    expect(fake.count('POST', '/api/upload')).toBe(0)
  })

  test('a non-2xx response throws AbsError carrying status and body', async () => {
    const fake = fakeAbs({ failOn: 'POST /api/upload' })
    const { deps } = depsFor(fake)
    const error = await rejected(publishToAudiobookshelf(deps, input()))
    expect(error).toBeInstanceOf(AbsError)
    expect(error.message).toContain('HTTP 500 boom')
    expect(fake.count('POST', '/api/libraries/lib1/scan')).toBe(0)
  })

  test('a network failure is wrapped in AbsError', async () => {
    const { deps } = depsFor(fakeAbs(), {
      fetch: (async () => {
        throw new Error('connection refused')
      }) as unknown as typeof fetch,
    })
    const error = await rejected(publishToAudiobookshelf(deps, input()))
    expect(error).toBeInstanceOf(AbsError)
    expect(error.message).toContain('connection refused')
  })

  test('a 200 with a non-JSON body throws AbsError', async () => {
    const fake = fakeAbs({ garbageLibraries: true })
    const { deps } = depsFor(fake)
    expect(await rejected(publishToAudiobookshelf(deps, input()))).toBeInstanceOf(AbsError)
  })

  test('an episode that never shows up times out with AbsError, polling on the injected clock', async () => {
    const fake = fakeAbs({ neverAppears: true })
    const { deps, sleeps } = depsFor(fake, { pollIntervalMs: 1000, pollDeadlineMs: 5000 })
    const error = await rejected(publishToAudiobookshelf(deps, input()))
    expect(error).toBeInstanceOf(AbsError)
    expect(error.message).toContain('Timed out')
    expect(sleeps).toEqual([1000, 1000, 1000, 1000, 1000])
    expect(fake.count('PATCH', '/api/items/item1/media')).toBe(0)
  })

  test('unconfigured url or key throws AbsError without calling fetch', async () => {
    const fake = fakeAbs()
    for (const config of [
      { url: '', apiKey: 'k', library: 'Podcasts' },
      { url: 'https://abs.example.com', apiKey: '', library: 'Podcasts' },
    ]) {
      const { deps } = depsFor(fake, { config })
      expect(await rejected(publishToAudiobookshelf(deps, input()))).toBeInstanceOf(AbsError)
      expect(await rejected(findPublishedEpisode(deps, { series: SERIES, filename: FILENAME }))).toBeInstanceOf(
        AbsError,
      )
    }
    expect(fake.calls).toEqual([])
  })
})

describe('filenameMatches', () => {
  test('matches on the job-id token regardless of how ABS sanitized the rest', () => {
    expect(
      filenameMatches('2026-09-02 Camper die Zahl [3965afde].mp3', '2026-09-02 Camper  die Zahl [3965afde].mp3'),
    ).toBe(true)
    expect(filenameMatches('2026-09-02 Camper [c2e279c6].mp3', '2026-09-02 Camper [3965afde].mp3')).toBe(false)
    expect(filenameMatches('plain.mp3', 'plain.mp3')).toBe(true)
    expect(filenameMatches(undefined, 'plain.mp3')).toBe(false)
  })
})

describe('slugifyFilename', () => {
  test('strips characters outside the allowed set', () => {
    expect(slugifyFilename('Spain/Portugal Trip!!')).toBe('SpainPortugal Trip')
  })

  test('keeps letters, digits, umlauts, space, period, underscore, hyphen', () => {
    expect(slugifyFilename('Über_den-Wolken v2.mp3')).toBe('Über_den-Wolken v2.mp3')
  })

  test('caps at 80 characters', () => {
    expect(slugifyFilename('a'.repeat(200))).toHaveLength(80)
  })
})

describe('episodeFilename', () => {
  test('embeds the first 8 chars of the job id so two jobs with the same title never collide', () => {
    const a = episodeFilename('2026-09-02', 'Nordspanien 2026', 'c2e279c6-b004-49cd-91b7-89d969856bf8')
    const b = episodeFilename('2026-09-02', 'Nordspanien 2026', '13f825b0-034e-4856-8bbb-64e6f4f01c3c')
    expect(a).toBe('2026-09-02 Nordspanien 2026 [c2e279c6].mp3')
    expect(a).not.toBe(b)
    expect(episodeFilename('2026-09-02', 'Camper – die Zahl, die zählt', '3965afde-0000')).toBe(
      '2026-09-02 Camper die Zahl die zählt [3965afde].mp3',
    )
  })
})
