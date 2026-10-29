import { log } from './log.ts'

// Ports audio-gateway/src/audiobookshelf.ts (+ slugifyFilename and episodeFilename from podcasts.ts): the Audiobookshelf
// (ABS) v2.36 publish client, the podcast pipeline's final step. ABS' own openapi.json documents only a subset of its REST
// surface; the upload/scan/items/cover routes used here were verified against the server source (routers/ApiRouter.js,
// controllers/{Library,LibraryItem,Podcast}Controller.js) at tag v2.36.0. Every call goes through `absFetch`, which adds
// auth and a timeout and throws `AbsError` on non-2xx. Everything is injected: no config singleton, no global clock.

const POLL_INTERVAL_MS = 2000
const POLL_DEADLINE_MS = 90_000
const FETCH_TIMEOUT_MS = 30_000

/** Any non-2xx response, timeout, or missing-library/item condition. */
export class AbsError extends Error {}

/** Connection to one ABS server; `url` has no trailing slash, `library` is a library name or id. */
export interface AbsConfig {
  url: string
  apiKey: string
  library: string
}

export interface AbsDeps {
  config: AbsConfig
  fetch?: typeof fetch
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  pollIntervalMs?: number
  pollDeadlineMs?: number
}

export interface AbsEpisode {
  title: string
  description: string
  filename: string
  file: Uint8Array
}

export interface AbsPublishInput {
  series: string
  author: string
  description: string
  language: string
  genres: string[]
  episode: AbsEpisode
  cover?: Uint8Array
}

export interface AbsPublishResult {
  libraryId: string
  libraryItemId: string
  episodeId: string | null
  url: string
}

// ---------------------------------------------------------------------------
// ABS wire shapes (only the fields this client reads/writes)
// ---------------------------------------------------------------------------

interface AbsLibraryFolder {
  id: string
  fullPath: string
}

export interface AbsLibrary {
  id: string
  name: string
  mediaType: string
  folders: AbsLibraryFolder[]
}

interface AbsAudioFile {
  metadata?: { filename?: string }
}

interface AbsEpisodeItem {
  id: string
  title?: string
  audioFile?: AbsAudioFile
}

interface AbsLibraryItemMinified {
  id: string
  media?: {
    metadata?: { title?: string; description?: string }
    coverPath?: string | null
  }
}

interface AbsLibraryItemExpanded extends AbsLibraryItemMinified {
  media?: AbsLibraryItemMinified['media'] & {
    episodes?: AbsEpisodeItem[]
  }
}

interface FoundItem {
  item: AbsLibraryItemExpanded
  episode: AbsEpisodeItem | null
}

// ---------------------------------------------------------------------------
// Filenames
// ---------------------------------------------------------------------------

const SLUG_DISALLOWED = /[^A-Za-z0-9äöüÄÖÜß ._-]/g
const SLUG_MAX_CHARS = 80

/** Sanitize a title into a filesystem/URL-safe slug — `[A-Za-z0-9äöüÄÖÜß ._-]`, capped at 80 chars. */
export function slugifyFilename(title: string): string {
  // Collapse runs of whitespace too: Audiobookshelf's own sanitizer does, and the scan poll matches on the stored name:
  // "Camper  die Zahl" (after an en dash was stripped) never matched "Camper die Zahl" (2026-09-02).
  const cleaned = title.replace(SLUG_DISALLOWED, '').replace(/\s+/g, ' ').trim()
  return cleaned.length > SLUG_MAX_CHARS ? cleaned.slice(0, SLUG_MAX_CHARS).trim() : cleaned
}

/**
 * The file name inside the show folder. ABS's upload MOVES the file onto `<show>/<filename>` without checking for an
 * existing one, so a second episode with the same date and title silently replaced the first (2026-09-02, v1 → v2 of the
 * Spain briefing). The job id makes the name unique per job while a re-publish of the SAME job still overwrites its own file.
 */
export function episodeFilename(date: string, title: string, jobId: string): string {
  return `${date} ${slugifyFilename(title)} [${jobId.slice(0, 8)}].mp3`
}

/**
 * ABS sanitizes the uploaded name on its own terms (whitespace, odd characters), so an exact comparison is brittle. The
 * job-id token that `episodeFilename` embeds (`[c2e279c6]`) survives any sanitizer and is unique per job — match on it
 * when present, exact name otherwise.
 */
export function filenameMatches(stored: string | undefined, wanted: string): boolean {
  if (!stored) return false
  const token = /\[[0-9a-f]{8}\]/.exec(wanted)?.[0]
  if (token) return stored.includes(token)
  return stored === wanted
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

async function absFetch(deps: AbsDeps, path: string, init: RequestInit = {}): Promise<string> {
  const { config } = deps
  const doFetch = deps.fetch ?? fetch
  const method = init.method ?? 'GET'
  let res: Response
  let body: string
  try {
    res = await doFetch(`${config.url}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${config.apiKey}`, ...(init.headers as Record<string, string> | undefined) },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    body = await res.text()
  } catch (error) {
    throw new AbsError(`ABS ${method} ${path} failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (res.status < 200 || res.status >= 300) {
    throw new AbsError(`ABS ${method} ${path} failed: HTTP ${res.status} ${body.slice(0, 300)}`)
  }
  return body
}

async function absJson<T>(deps: AbsDeps, path: string, init?: RequestInit): Promise<T> {
  const body = await absFetch(deps, path, init)
  try {
    return JSON.parse(body) as T
  } catch {
    throw new AbsError(`ABS ${init?.method ?? 'GET'} ${path} returned invalid JSON: ${body.slice(0, 300)}`)
  }
}

/** Resolve `config.library` (name or id) to a podcast-typed ABS library. */
async function resolveLibrary(deps: AbsDeps): Promise<AbsLibrary> {
  const wanted = deps.config.library
  const { libraries } = await absJson<{ libraries: AbsLibrary[] }>(deps, '/api/libraries')
  const target = wanted.trim().toLowerCase()
  const match = libraries.find(
    (lib) => (lib.id === wanted || lib.name.trim().toLowerCase() === target) && lib.mediaType === 'podcast',
  )
  if (match) return match

  const podcastLibraries = libraries.filter((lib) => lib.mediaType === 'podcast').map((lib) => lib.name)
  throw new AbsError(
    `No podcast library named "${wanted}" found. Podcast libraries present: ${
      podcastLibraries.length ? podcastLibraries.join(', ') : '(none)'
    }`,
  )
}

async function uploadEpisodeFile(deps: AbsDeps, library: AbsLibrary, episode: AbsEpisode, series: string) {
  const folder = library.folders[0]
  if (!folder) throw new AbsError(`Library "${library.name}" has no folders configured`)

  const form = new FormData()
  form.set('title', series)
  form.set('library', library.id)
  form.set('folder', folder.id)
  form.set('files[]', new Blob([new Uint8Array(episode.file)], { type: 'audio/mpeg' }), episode.filename)

  await absFetch(deps, '/api/upload', { method: 'POST', body: form })
}

async function triggerScan(deps: AbsDeps, libraryId: string) {
  await absFetch(deps, `/api/libraries/${libraryId}/scan`, { method: 'POST' })
}

/** One poll attempt: list the library, find the show by title, expand it, and look for the uploaded filename. */
async function pollOnce(deps: AbsDeps, libraryId: string, filename: string, series: string): Promise<FoundItem | null> {
  const target = series.trim().toLowerCase()
  const { results } = await absJson<{ results: AbsLibraryItemMinified[] }>(
    deps,
    `/api/libraries/${libraryId}/items?limit=100&sort=addedAt&desc=1`,
  )
  const minified = results.find((r) => (r.media?.metadata?.title ?? '').trim().toLowerCase() === target)
  if (!minified) return null

  const expanded = await absJson<AbsLibraryItemExpanded>(deps, `/api/items/${minified.id}?expanded=1`)
  const episode =
    expanded.media?.episodes?.find((ep) => filenameMatches(ep.audioFile?.metadata?.filename, filename)) ?? null
  if (!episode) return null

  return { item: expanded, episode }
}

/** Poll until the scan has picked up the uploaded file as an episode, or time out. */
async function waitForEpisode(deps: AbsDeps, libraryId: string, filename: string, series: string): Promise<FoundItem> {
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? Bun.sleep
  const deadline = now() + (deps.pollDeadlineMs ?? POLL_DEADLINE_MS)
  while (now() < deadline) {
    const found = await pollOnce(deps, libraryId, filename, series)
    if (found) return found
    await sleep(deps.pollIntervalMs ?? POLL_INTERVAL_MS)
  }
  throw new AbsError(`Timed out waiting for ABS to scan episode file "${filename}" into library "${series}"`)
}

async function patchMedia(deps: AbsDeps, itemId: string, input: AbsPublishInput) {
  await absFetch(deps, `/api/items/${itemId}/media`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      metadata: {
        title: input.series,
        author: input.author,
        description: input.description,
        genres: input.genres,
        language: input.language,
      },
    }),
  })
}

async function uploadCover(deps: AbsDeps, itemId: string, cover: Uint8Array) {
  const form = new FormData()
  form.set('cover', new Blob([new Uint8Array(cover)], { type: 'image/png' }), 'cover.png')
  await absFetch(deps, `/api/items/${itemId}/cover`, { method: 'POST', body: form })
}

async function patchEpisode(
  deps: AbsDeps,
  itemId: string,
  episodeId: string,
  episode: AbsEpisode,
  publishedAt: number,
) {
  await absFetch(deps, `/api/podcasts/${itemId}/episode/${episodeId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: episode.title, description: episode.description, publishedAt }),
  })
}

function assertConfigured(config: AbsConfig) {
  if (config.url === '' || config.apiKey === '') {
    throw new AbsError('Audiobookshelf publishing not configured (url/apiKey unset)')
  }
}

/**
 * One poll attempt for an already-published episode: resolves the library, then looks the show up by `series` and the
 * episode by `filename` (job-id token). Null when the show or the episode is not there (yet).
 */
export async function findPublishedEpisode(
  deps: AbsDeps,
  params: { series: string; filename: string },
): Promise<AbsPublishResult | null> {
  assertConfigured(deps.config)
  const library = await resolveLibrary(deps)
  const found = await pollOnce(deps, library.id, params.filename, params.series)
  if (!found) return null
  return {
    libraryId: library.id,
    libraryItemId: found.item.id,
    episodeId: found.episode?.id ?? null,
    url: `${deps.config.url}/item/${found.item.id}`,
  }
}

/**
 * Upload one episode into the configured Audiobookshelf podcast library, trigger a scan, then patch
 * metadata/cover/episode fields once the scan has picked the file up. Show-level description/cover are only written when
 * the podcast item is newly created OR (description) currently empty — never clobbering a hand-edited show description;
 * genres/language are always merged in since they carry no editorial intent.
 *
 * Resumable: when the episode (by its job-id token) is already in the library, upload, scan and wait are skipped and the
 * (idempotent) patch steps run on the found item.
 */
export async function publishToAudiobookshelf(deps: AbsDeps, input: AbsPublishInput): Promise<AbsPublishResult> {
  assertConfigured(deps.config)
  const library = await resolveLibrary(deps)
  const filename = input.episode.filename

  let found = await pollOnce(deps, library.id, filename, input.series)
  if (found) {
    log.info('abs episode already present, skipping upload', { library: library.name, filename })
  } else {
    await uploadEpisodeFile(deps, library, input.episode, input.series)
    log.info('abs upload done', { library: library.name, filename })

    await triggerScan(deps, library.id)
    log.info('abs scan triggered', { libraryId: library.id })

    found = await waitForEpisode(deps, library.id, filename, input.series)
  }

  const itemId = found.item.id
  const episodeId = found.episode?.id ?? null
  log.info('abs item found', { itemId, episodeId })

  // A freshly scanned item's title equals the series name and its description is unset — that's the only reliable
  // "just created" signal this endpoint surface gives us (ABS assigns createdAt server-side and the minified list
  // response doesn't expose it here).
  const created = (found.item.media?.metadata?.description ?? '') === ''
  if (created) await patchMedia(deps, itemId, input)

  const hasCover = Boolean(found.item.media?.coverPath)
  if (input.cover && (created || !hasCover)) await uploadCover(deps, itemId, input.cover)

  if (episodeId) await patchEpisode(deps, itemId, episodeId, input.episode, (deps.now ?? Date.now)())

  return { libraryId: library.id, libraryItemId: itemId, episodeId, url: `${deps.config.url}/item/${itemId}` }
}
