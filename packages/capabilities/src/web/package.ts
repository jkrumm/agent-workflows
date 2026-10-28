import { z } from 'zod'
import { fail } from '../errors.ts'
import { defineCapability } from '../procedure.ts'
import { failedResponse, readJson, withRetries } from '../transports/http.ts'
import { keyOf, type ResolvedWebDeps, webUsage, within } from './deps.ts'

const REGISTRIES = ['npm', 'pypi', 'crates', 'github-release'] as const

// What each registry accepts as a name, so a malformed one is refused (by the input schema, the one place) instead of
// shaping a request URL. GitHub's `.` and `..` match the character class and would climb out of `/repos/` in a request
// that carries GITHUB_TOKEN, so the schema also refuses a dot-only segment.
const NAME_PATTERN: Record<(typeof REGISTRIES)[number], RegExp> = {
  npm: /^(?:@[a-z0-9~][a-z0-9._~-]*\/)?[a-z0-9~][a-z0-9._~-]*$/i,
  pypi: /^[a-z0-9][a-z0-9._-]*$/i,
  crates: /^[a-z0-9][a-z0-9_-]*$/i,
  'github-release': /^[\w.-]+\/[\w.-]+$/,
}

export const packageInput = z
  .object({
    registry: z.enum(REGISTRIES),
    name: z.string().min(1).describe('npm: "hono" or "@scope/pkg"; github-release: "owner/repo"'),
  })
  .refine((i) => NAME_PATTERN[i.registry].test(i.name) && i.name.split('/').every((part) => !/^\.+$/.test(part)), {
    message: 'name is not valid for that registry',
    path: ['name'],
  })

export const packageOutput = z.object({
  name: z.string(),
  latest: z
    .string()
    .describe('The latest stable version; for github-release the tag with a leading "v" or "bun-v" removed'),
  publishedAt: z
    .string()
    .optional()
    .describe('ISO date of that release; not set for npm, whose cheap endpoint carries none'),
  url: z.string().describe('The registry page to cite'),
})

const TIMEOUT_MS = 15_000
// crates.io and GitHub reject a request without a User-Agent.
const USER_AGENT = 'agent-workflows/0.1 (web.package)'

const str = z.string().min(1)
const npmLatest = z.object({ version: str })
const pypiInfo = z.object({
  info: z.object({ version: str }),
  urls: z.array(z.object({ upload_time_iso_8601: z.string().nullish() })).nullish(),
})
const cratesInfo = z.object({
  crate: z.object({ max_stable_version: z.string().nullish(), newest_version: z.string().nullish() }),
  versions: z.array(z.object({ num: z.string(), created_at: z.string().nullish() })).nullish(),
})
const githubRelease = z.object({
  tag_name: str,
  published_at: z.string().nullish(),
  html_url: z.string().nullish(),
})

type Out = z.infer<typeof packageOutput>

export const createPackage = (deps: ResolvedWebDeps) =>
  defineCapability({
    id: 'web.package',
    summary: 'Latest version of a package, read live from its registry (npm, PyPI, crates.io, GitHub releases); no LLM',
    input: packageInput,
    output: packageOutput,
    cli: { positional: ['registry', 'name'], defaultFormat: 'json' },
    async handler({ registry, name }, ctx) {
      const get = async (url: string, headers: Record<string, string> = {}): Promise<unknown> => {
        try {
          return await withRetries(deps.retry, ctx.signal, async () => {
            const res = await deps.fetch(url, {
              headers: { 'user-agent': USER_AGENT, accept: 'application/json', ...headers },
              signal: within(ctx.signal, TIMEOUT_MS),
            })
            if (!res.ok) throw await failedResponse(res, registry)
            return readJson(res, registry)
          })
        } catch (error) {
          if ((error as { data?: { status?: number } }).data?.status === 404) {
            throw fail('UPSTREAM_ERROR', `web.package: ${name} not found on ${registry}`, { status: 404 })
          }
          throw error
        }
      }
      const unreadable = () =>
        fail('UPSTREAM_ERROR', `web.package: ${registry} answered with a body that does not fit`, {})

      const out = await (async (): Promise<Out> => {
        switch (registry) {
          case 'npm': {
            const parsed = npmLatest.safeParse(
              await get(`https://registry.npmjs.org/${name.replace('/', '%2F')}/latest`),
            )
            if (!parsed.success) throw unreadable()
            return { name, latest: parsed.data.version, url: `https://www.npmjs.com/package/${name}` }
          }
          case 'pypi': {
            const parsed = pypiInfo.safeParse(await get(`https://pypi.org/pypi/${encodeURIComponent(name)}/json`))
            if (!parsed.success) throw unreadable()
            const publishedAt = parsed.data.urls?.find((u) => u.upload_time_iso_8601)?.upload_time_iso_8601
            return {
              name,
              latest: parsed.data.info.version,
              ...(publishedAt ? { publishedAt } : {}),
              url: `https://pypi.org/project/${name}/`,
            }
          }
          case 'crates': {
            const parsed = cratesInfo.safeParse(
              await get(`https://crates.io/api/v1/crates/${encodeURIComponent(name)}`),
            )
            if (!parsed.success) throw unreadable()
            // The stable release only: `newest_version` can be a prerelease, and a crate that only has prereleases has
            // no "latest" to report.
            const latest = parsed.data.crate.max_stable_version
            if (!latest) {
              throw fail('UPSTREAM_ERROR', `web.package: ${name} has no stable version on crates.io`, { status: 404 })
            }
            const publishedAt = parsed.data.versions?.find((v) => v.num === latest)?.created_at
            return { name, latest, ...(publishedAt ? { publishedAt } : {}), url: `https://crates.io/crates/${name}` }
          }
          case 'github-release': {
            const token = keyOf(deps.env(), 'GITHUB_TOKEN')
            const parsed = githubRelease.safeParse(
              await get(
                `https://api.github.com/repos/${name}/releases/latest`,
                token ? { authorization: `Bearer ${token}` } : {},
              ),
            )
            if (!parsed.success) throw unreadable()
            const { tag_name, published_at, html_url } = parsed.data
            return {
              name,
              // Bun tags `bun-v1.2.3`, most repos `v1.2.3`; the bare version is what a report writes.
              latest: tag_name.replace(/^(?:bun-)?v/i, ''),
              ...(published_at ? { publishedAt: published_at } : {}),
              url: html_url ?? `https://github.com/${name}/releases/latest`,
            }
          }
        }
      })()
      ctx.addUsage(webUsage(registry, 0))
      return out
    },
  })
