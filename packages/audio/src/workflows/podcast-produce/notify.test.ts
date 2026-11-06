import { describe, expect, test } from 'bun:test'
import { setProduceLogger } from './log.ts'
import { notifyConfigFromEnv, notifyPodcastResult, podcastDoneNotice, podcastFailureNotice } from './notify.ts'

setProduceLogger({ warn: () => {}, error: () => {} })

const config = { url: 'http://ntfy.example.com', token: 't' }

/** A fake fetch that records `[url, init]` and answers per URL. */
function fakeFetch(answer: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    return answer(String(url), init)
  }) as unknown as typeof fetch
  return { impl, calls }
}

const base = {
  title: 'T',
  durationSeconds: 1536,
  chapterCount: 2,
  absUrl: null,
  costUsd: null,
  publishRequested: false,
  publishError: null,
}

describe('podcastDoneNotice', () => {
  test('published: one line with minutes, chapters and cost; the link is the click target', () => {
    const notice = podcastDoneNotice({
      ...base,
      absUrl: 'https://abs.example.com/item/1',
      costUsd: 2.257,
      publishRequested: true,
    })
    expect(notice).toEqual({
      title: 'Podcast fertig',
      body: 'T: 26 min, 2 Kapitel. Anhören in Audiobookshelf. Kosten: 2.26 USD',
      tags: 'headphones',
      click: 'https://abs.example.com/item/1',
    })
    expect(notice.body).not.toContain('\n')
  })

  test('not requested: says so, no click, no cost', () => {
    const notice = podcastDoneNotice({ ...base, durationSeconds: 60, chapterCount: 0 })
    expect(notice.body).toContain('T: 1 min, 0 Kapitel.')
    expect(notice.body).toContain('nicht angefordert')
    expect(notice.body).not.toContain('Kosten')
    expect(notice.click).toBeUndefined()
  })

  test('requested but unconfigured says so', () => {
    const notice = podcastDoneNotice({ ...base, publishRequested: true })
    expect(notice.body).toContain('Nicht veröffentlicht: Audiobookshelf ist auf diesem Gateway nicht konfiguriert.')
  })

  test('a failed upload says produced-but-unpublished and points at /publish, never at /retry', () => {
    const notice = podcastDoneNotice({ ...base, publishRequested: true, publishError: 'ABS scan timed out' })
    expect(notice.body).toContain(
      'Produziert, Veröffentlichung fehlgeschlagen (ABS scan timed out) — /publish wiederholt nur den Upload.',
    )
    expect(notice.body).not.toContain('nicht konfiguriert')
    expect(notice.body).not.toContain('/retry')
    expect(notice.click).toBeUndefined()
  })
})

describe('podcastFailureNotice', () => {
  test('carries the message cut to 500 characters, no id', () => {
    const notice = podcastFailureNotice(new Error('x'.repeat(600)))
    expect(notice).toEqual({ title: 'Podcast fehlgeschlagen', body: 'x'.repeat(500), tags: 'warning' })
    expect(podcastFailureNotice('boom').body).toBe('boom')
  })
})

describe('notifyPodcastResult', () => {
  test('posts the body to <url>/updates with bearer, title, tags and click', async () => {
    const fake = fakeFetch(() => new Response('{}', { status: 200 }))
    const notice = podcastDoneNotice({ ...base, absUrl: 'https://abs.example.com/item/1', publishRequested: true })
    const result = await notifyPodcastResult(config, notice, fake.impl)
    expect(result).toEqual({ sent: true, error: null })
    const post = fake.calls[0]
    expect(post?.url).toBe('http://ntfy.example.com/updates')
    expect(post?.init?.method).toBe('POST')
    expect(post?.init?.body).toBe(notice.body)
    const headers = new Headers(post?.init?.headers)
    expect(headers.get('authorization')).toBe('Bearer t')
    expect(headers.get('title')).toBe('Podcast fertig')
    expect(headers.get('tags')).toBe('headphones')
    expect(headers.get('click')).toBe('https://abs.example.com/item/1')
  })

  test('no click header without a link', async () => {
    const fake = fakeFetch(() => new Response('{}', { status: 200 }))
    await notifyPodcastResult(config, podcastFailureNotice(new Error('bad')), fake.impl)
    const headers = new Headers(fake.calls[0]?.init?.headers)
    expect(headers.get('click')).toBeNull()
    expect(headers.get('title')).toBe('Podcast fehlgeschlagen')
    expect(headers.get('tags')).toBe('warning')
  })

  test('a non-2xx post is reported, not thrown', async () => {
    const fake = fakeFetch(() => new Response('denied', { status: 403 }))
    const result = await notifyPodcastResult(config, podcastFailureNotice('x'), fake.impl)
    expect(result).toEqual({ sent: false, error: 'HTTP 403 denied' })
  })

  test('a network failure is reported, not thrown', async () => {
    const down = await notifyPodcastResult(config, podcastFailureNotice('x'), (async () => {
      throw new Error('connection refused')
    }) as unknown as typeof fetch)
    expect(down).toEqual({ sent: false, error: 'connection refused' })
  })
})

describe('notifyConfigFromEnv', () => {
  test('reads NTFY_URL and NTFY_TOKEN and strips trailing slashes', () => {
    expect(notifyConfigFromEnv({ NTFY_URL: ' http://ntfy.example.com// ', NTFY_TOKEN: 't' })).toEqual({
      url: 'http://ntfy.example.com',
      token: 't',
    })
  })

  test('null when either is unset', () => {
    const full = { NTFY_URL: 'http://ntfy.example.com', NTFY_TOKEN: 't' }
    expect(notifyConfigFromEnv(full)).not.toBeNull()
    expect(notifyConfigFromEnv({ ...full, NTFY_URL: '' })).toBeNull()
    expect(notifyConfigFromEnv({ ...full, NTFY_TOKEN: undefined })).toBeNull()
    expect(notifyConfigFromEnv({})).toBeNull()
  })
})
