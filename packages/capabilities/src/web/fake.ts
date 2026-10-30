import type { Usage } from '../context.ts'
import { defineCapability } from '../procedure.ts'
import { webUsage } from './deps.ts'
import { docsInput, docsOutput } from './docs.ts'
import { fetchInput, fetchOutput } from './fetch.ts'
import { packageInput, packageOutput } from './package.ts'
import { searchInput, searchOutput } from './search.ts'
import { youtubeInput, youtubeOutput } from './youtube.ts'
import type { z } from 'zod'

type Reply<I, O> = O | Error | ((input: I) => O | Error)

const FREE: Usage = webUsage('fake-web', 0)

export interface FakeWeb {
  /** The four capabilities, with the real ids, input and output schemas, and CLI shapes. Register them like any others. */
  capabilities: readonly [
    ReturnType<typeof defineCapability<typeof searchInput, typeof searchOutput, 'web.search'>>,
    ReturnType<typeof defineCapability<typeof fetchInput, typeof fetchOutput, 'web.fetch'>>,
    ReturnType<typeof defineCapability<typeof docsInput, typeof docsOutput, 'web.docs'>>,
    ReturnType<typeof defineCapability<typeof packageInput, typeof packageOutput, 'web.package'>>,
    ReturnType<typeof defineCapability<typeof youtubeInput, typeof youtubeOutput, 'web.youtube'>>,
  ]
  /** Every call, in order, with the input as the handler saw it (defaults applied). */
  calls: { id: 'web.search' | 'web.fetch' | 'web.docs' | 'web.package' | 'web.youtube'; input: unknown }[]
}

type Script = {
  search?: Reply<z.output<typeof searchInput>, z.input<typeof searchOutput>>
  fetch?: Reply<z.output<typeof fetchInput>, z.input<typeof fetchOutput>>
  docs?: Reply<z.output<typeof docsInput>, z.input<typeof docsOutput>>
  package?: Reply<z.output<typeof packageInput>, z.input<typeof packageOutput>>
  youtube?: Reply<z.output<typeof youtubeInput>, z.input<typeof youtubeOutput>>
  /** What each call reports through `addUsage`. Default: a priced, free call. `null` reports nothing. */
  usage?: Usage | null
}

/**
 * The web capabilities without a network, for tests of whatever is built on them. Canned results by default; pass a
 * reply (a value, an `Error` to throw, or a function of the input) per capability to script it. Each call reports
 * `usage` (default a priced zero-cost call) so a test can see the usage path.
 */
export function fakeWeb(script: Script = {}): FakeWeb {
  const calls: FakeWeb['calls'] = []
  const usage = script.usage === undefined ? FREE : script.usage
  const answer =
    <I, O>(id: FakeWeb['calls'][number]['id'], reply: Reply<I, O> | undefined, canned: O) =>
    (input: I, ctx: { addUsage: (u: Usage) => void }): O => {
      calls.push({ id, input })
      if (usage) ctx.addUsage(usage)
      const value =
        reply === undefined ? canned : typeof reply === 'function' ? (reply as (i: I) => O | Error)(input) : reply
      if (value instanceof Error) throw value
      return value
    }
  return {
    capabilities: [
      defineCapability({
        id: 'web.search',
        summary: 'Fake web.search',
        input: searchInput,
        output: searchOutput,
        cli: { positional: ['query'], defaultFormat: 'json' },
        handler: answer('web.search', script.search, {
          provider: 'sonar' as const,
          results: [
            {
              url: 'https://example.com/a',
              title: 'Example A',
              snippet: 'First canned result.',
              publishedAt: '2026-10-01',
            },
            { url: 'https://example.com/b', title: 'Example B', snippet: 'Second canned result.' },
          ],
        }),
      }),
      defineCapability({
        id: 'web.fetch',
        summary: 'Fake web.fetch',
        input: fetchInput,
        output: fetchOutput,
        cli: { positional: ['url'], defaultFormat: 'json' },
        handler: answer('web.fetch', script.fetch, {
          url: 'https://example.com/a',
          finalUrl: 'https://example.com/a',
          title: 'Example A',
          text: 'Canned page text.',
          truncated: false,
          via: 'direct' as const,
          cached: false,
          fetchedAt: '2026-10-30T12:00:00.000Z',
        }),
      }),
      defineCapability({
        id: 'web.docs',
        summary: 'Fake web.docs',
        input: docsInput,
        output: docsOutput,
        cli: { positional: ['library'], defaultFormat: 'json' },
        handler: answer('web.docs', script.docs, {
          text: 'Canned documentation text.',
          source: 'https://context7.com/example/lib',
        }),
      }),
      defineCapability({
        id: 'web.package',
        summary: 'Fake web.package',
        input: packageInput,
        output: packageOutput,
        cli: { positional: ['registry', 'name'], defaultFormat: 'json' },
        handler: answer('web.package', script.package, {
          name: 'example',
          latest: '1.2.3',
          publishedAt: '2026-10-01T00:00:00Z',
          url: 'https://www.npmjs.com/package/example',
        }),
      }),
      defineCapability({
        id: 'web.youtube',
        summary: 'Fake web.youtube',
        input: youtubeInput,
        output: youtubeOutput,
        cli: { positional: ['url'], defaultFormat: 'json' },
        handler: answer('web.youtube', script.youtube, {
          url: 'https://www.youtube.com/watch?v=aaaaaaaaaaa',
          videoId: 'aaaaaaaaaaa',
          title: 'Example video',
          channel: 'Example channel',
          durationSeconds: 600,
          description: 'Canned description.',
          language: 'de',
          captionKind: 'auto' as const,
          tracks: ['de (auto)'],
          transcript: '[0:00] Canned transcript.',
          truncated: false,
        }),
      }),
    ],
    calls,
  }
}
