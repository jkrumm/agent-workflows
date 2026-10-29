import { describe, expect, test } from 'bun:test'
import { setProduceLogger } from './log.ts'
import { notifyConfigFromEnv, notifyPodcastResult, podcastDoneMessage, resolveNotifyChannel } from './notify.ts'

// Ports the podcastDoneMessage / resolveNotifyChannel cases of audio-gateway/src/podcasts.test.ts; notifyPodcastResult
// and the env derivation are new coverage. The channel-id cache lives per process, so each test uses its own channel name.

setProduceLogger({ warn: () => {}, error: () => {} })

/** The error a promise rejects with; fails the test when it resolves. */
async function rejected(promise: Promise<unknown>): Promise<Error> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  )
  if (!(error instanceof Error)) throw new Error('expected a rejection')
  return error
}

const BASE = 'http://argo.example.com'
const config = (channel: string) => ({ channel, argoBaseUrl: BASE, argoApiSecret: 's' })

/** A fake fetch that records `[url, init]` and answers per URL. */
function fakeFetch(answer: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    return answer(String(url), init)
  }) as unknown as typeof fetch
  return { impl, calls }
}

const channelsAnswer = (url: string) =>
  url.endsWith('/slack/channels')
    ? Response.json([
        { id: 'C1', name: 'hermes' },
        { id: 'C2', name: 'media' },
      ])
    : new Response('{}', { status: 200 })

describe('podcastDoneMessage', () => {
  test('carries title, minutes, chapters, format line and the Audiobookshelf link', () => {
    const msg = podcastDoneMessage({
      title: 'T',
      durationSeconds: 1536,
      chapters: ['A', 'B'],
      absUrl: 'https://abs.example.com/item/1',
      costUsd: 2.257,
      publishRequested: true,
      publishError: null,
      format: 'Erklärstück',
      lead: 'A',
      humor: 'sparse',
      hostNames: ['Jonas', 'Lena'],
    })
    const unpublished = podcastDoneMessage({
      title: 'T',
      durationSeconds: 60,
      chapters: [],
      absUrl: null,
      costUsd: null,
      publishRequested: false,
      publishError: null,
      format: 'Gespräch',
      lead: 'balanced',
      humor: 'none',
      hostNames: ['Jonas', 'Lena'],
    })
    expect(unpublished).toContain('nicht angefordert')
    expect(unpublished).toContain('Format: Gespräch · ausgeglichen · none')
    expect(unpublished).not.toContain('Kosten')
    expect(msg).toContain('*T* (26 min, 2 Kapitel)')
    expect(msg).toContain('Format: Erklärstück · Jonas führt · sparse')
    expect(msg).toContain('• B')
    expect(msg).toContain('https://abs.example.com/item/1')
    expect(msg).toContain('Kosten: 2.26 USD')
    expect(msg).not.toContain('ElevenLabs-Kosten')
  })

  test('lead B names the second host; requested but unconfigured says so', () => {
    const msg = podcastDoneMessage({
      title: 'T',
      durationSeconds: 600,
      chapters: [],
      absUrl: null,
      costUsd: 1,
      publishRequested: true,
      publishError: null,
      format: 'Gespräch',
      lead: 'B',
      humor: 'none',
      hostNames: ['Jonas', 'Lena'],
    })
    expect(msg).toContain('Lena führt')
    expect(msg).toContain('Nicht veröffentlicht: Audiobookshelf ist auf diesem Gateway nicht konfiguriert.')
  })

  test('a failed upload says produced-but-unpublished and points at /publish, never at /retry', () => {
    const msg = podcastDoneMessage({
      title: 'T',
      durationSeconds: 600,
      chapters: [],
      absUrl: null,
      costUsd: 1,
      publishRequested: true,
      publishError: 'ABS scan timed out',
      format: 'Gespräch',
      lead: 'balanced',
      humor: 'none',
      hostNames: ['Jonas', 'Lena'],
    })
    expect(msg).toContain(
      'Produziert, Veröffentlichung fehlgeschlagen (ABS scan timed out) — /publish wiederholt nur den Upload.',
    )
    expect(msg).not.toContain('nicht konfiguriert')
    expect(msg).not.toContain('/retry')
  })
})

describe('resolveNotifyChannel', () => {
  test('accepts an id as-is without calling Argo', async () => {
    const fake = fakeFetch(() => {
      throw new Error('should not be called')
    })
    expect(await resolveNotifyChannel(config('C0AS5GUH5U4'), fake.impl)).toBe('C0AS5GUH5U4')
    expect(fake.calls).toEqual([])
  })

  test("resolves a channel name through Argo's list, once per process", async () => {
    const fake = fakeFetch(channelsAnswer)
    expect(await resolveNotifyChannel(config('#Media'), fake.impl)).toBe('C2')
    expect(fake.calls[0]?.url).toBe(`${BASE}/slack/channels`)
    expect(new Headers(fake.calls[0]?.init?.headers).get('authorization')).toBe('Bearer s')
    expect(await resolveNotifyChannel(config('#Media'), fake.impl)).toBe('C2')
    expect(fake.calls.length).toBe(1)
  })

  test('an empty channel resolves to null; an unknown name and a non-2xx list throw', async () => {
    const fake = fakeFetch(channelsAnswer)
    expect(await resolveNotifyChannel(config('  '), fake.impl)).toBeNull()
    expect((await rejected(resolveNotifyChannel(config('nonexistent-channel'), fake.impl))).message).toContain(
      'Argo knows no Slack channel named "nonexistent-channel"',
    )
    const failing = fakeFetch(() => new Response('no', { status: 503 }))
    expect((await rejected(resolveNotifyChannel(config('other-unknown-channel'), failing.impl))).message).toContain(
      'HTTP 503',
    )
  })
})

describe('notifyPodcastResult', () => {
  test('posts the text to the resolved channel with the bearer secret', async () => {
    const fake = fakeFetch(channelsAnswer)
    const result = await notifyPodcastResult(config('hermes'), 'Podcast fertig', fake.impl)
    expect(result).toEqual({ sent: true, error: null })
    const post = fake.calls[1]
    expect(post?.url).toBe(`${BASE}/slack/channels/C1/messages`)
    expect(post?.init?.method).toBe('POST')
    expect(JSON.parse(String(post?.init?.body))).toEqual({ text: 'Podcast fertig' })
    expect(new Headers(post?.init?.headers).get('authorization')).toBe('Bearer s')
  })

  test('a non-2xx post is reported, not thrown', async () => {
    const fake = fakeFetch((url) =>
      url.endsWith('/messages') ? new Response('denied', { status: 403 }) : Response.json([]),
    )
    const result = await notifyPodcastResult(config('C0AS5GUH5U4'), 'x', fake.impl)
    expect(result.sent).toBe(false)
    expect(result.error).toBe('HTTP 403 denied')
  })

  test('an unresolvable channel or a network failure is reported, not thrown', async () => {
    const unknown = await notifyPodcastResult(config('missing-channel'), 'x', fakeFetch(channelsAnswer).impl)
    expect(unknown).toEqual({ sent: false, error: 'Argo knows no Slack channel named "missing-channel"' })

    const down = await notifyPodcastResult(config('C0AS5GUH5U4'), 'x', (async () => {
      throw new Error('connection refused')
    }) as unknown as typeof fetch)
    expect(down).toEqual({ sent: false, error: 'connection refused' })
  })

  test('an empty channel sends nothing', async () => {
    const fake = fakeFetch(channelsAnswer)
    expect(await notifyPodcastResult(config(''), 'x', fake.impl)).toEqual({ sent: false, error: null })
    expect(fake.calls).toEqual([])
  })
})

describe('notifyConfigFromEnv', () => {
  test('reads the three variables and strips trailing slashes', () => {
    expect(
      notifyConfigFromEnv({
        PODCAST_NOTIFY_CHANNEL: 'media',
        ARGO_URL: 'http://argo.example.com/',
        ARGO_API_SECRET: 's',
      }),
    ).toEqual({ channel: 'media', argoBaseUrl: 'http://argo.example.com', argoApiSecret: 's' })
  })

  test('the legacy names ARGO_BASE_URL and USAGE_HTTP_URL are not read', () => {
    const env = {
      PODCAST_NOTIFY_CHANNEL: 'media',
      ARGO_API_SECRET: 's',
      ARGO_BASE_URL: 'http://argo.example.com',
      USAGE_HTTP_URL: 'http://argo.example.com/usage/records',
    }
    expect(notifyConfigFromEnv(env)).toBeNull()
  })

  test('null when the channel, the base url or the secret is unset', () => {
    const full = { PODCAST_NOTIFY_CHANNEL: 'media', ARGO_URL: 'http://argo.example.com', ARGO_API_SECRET: 's' }
    expect(notifyConfigFromEnv(full)).not.toBeNull()
    expect(notifyConfigFromEnv({ ...full, PODCAST_NOTIFY_CHANNEL: undefined })).toBeNull()
    expect(notifyConfigFromEnv({ ...full, ARGO_URL: '' })).toBeNull()
    expect(notifyConfigFromEnv({ ...full, ARGO_API_SECRET: undefined })).toBeNull()
    expect(notifyConfigFromEnv({})).toBeNull()
  })
})
