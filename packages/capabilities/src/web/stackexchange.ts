import { z } from 'zod'
import { describe, isAbort } from '../transports/http.ts'
import { type ResolvedWebDeps, within } from './deps.ts'
import { parseHtml } from './text.ts'

/**
 * The Stack Exchange API leg of `web.fetch`: a question page that sits behind an interactive bot check is read through
 * `api.stackexchange.com/2.3`, which serves the question and its answers as data to anyone, no key. Used only after the
 * plain and browser reads met a wall (`fetch.ts`).
 *
 * Quota (checked 2026-11-16 against the live API, `quota_max` 300): an unauthenticated address gets 300 requests a day,
 * reset at 00:00 UTC. A response carries `quota_remaining`, and `backoff` (seconds) when the API asks callers to wait
 * before the next request; both are honoured by `StackExchangeQuota`.
 */

const API = 'https://api.stackexchange.com/2.3'
const TIMEOUT_MS = 10_000
/** After a throttle violation (`error_id` 502) the leg rests this long, as `backoff` was not given. */
const THROTTLE_HOLD_MS = 10 * 60_000
/** Answers kept in the text: the accepted one, then the best scored. A question rarely needs more than these. */
const MAX_ANSWERS = 10

/**
 * The API filter of this leg, created once with `/filters/create` (a filter is immutable and safe):
 * `base=withbody` (the question's body) plus `include=question.answers;answer.body;answer.is_accepted;answer.score;
 * answer.answer_id;answer.link`, `unsafe=false`. One request returns the question and all its answers.
 */
const FILTER = '!2vHqlW)1idY*y*4O4HFN67xU7kblcTDBiswJllF7ae'

/** Sites whose `site` parameter is the host without `.com`/`.net` (the API's `api_site_parameter`). */
const NETWORK_HOSTS: Record<string, string> = {
  'stackoverflow.com': 'stackoverflow',
  'superuser.com': 'superuser',
  'serverfault.com': 'serverfault',
  'askubuntu.com': 'askubuntu',
  'mathoverflow.net': 'mathoverflow.net',
}

export interface StackExchangeQuestion {
  /** The API's `site` parameter. */
  site: string
  id: number
}

/** The question a Stack Exchange question URL names (`/questions/<id>/<slug>` or `/q/<id>`), or undefined for any other URL. */
export function stackExchangeQuestion(url: string): StackExchangeQuestion | undefined {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return undefined
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return undefined
  const host = parsed.hostname.toLowerCase().replace(/^www\./, '')
  const path = parsed.pathname.match(/^\/(?:questions|q)\/(\d{1,12})(?:\/|$)/)
  if (!path) return undefined
  const known = NETWORK_HOSTS[host]
  // `<site>.stackexchange.com` and `meta.<site>.stackexchange.com`: the API names them `<site>` and `meta.<site>`.
  const site = known ?? host.match(/^([a-z0-9-]+(?:\.[a-z0-9-]+)?)\.stackexchange\.com$/)?.[1]
  return site ? { site, id: Number(path[1]) } : undefined
}

/**
 * What the API has said about the daily quota and the wait it asked for. The leg is skipped (no request) while it holds
 * a `backoff` or after `quota_remaining` reached 0 until the next UTC day.
 */
export class StackExchangeQuota {
  private holdUntil = 0
  private exhaustedOn: string | undefined

  /** Why the leg must not send a request now, or undefined when it may. */
  closed(now: number): string | undefined {
    if (now < this.holdUntil) return `asked to wait ${Math.ceil((this.holdUntil - now) / 1000)} s (backoff)`
    if (this.exhaustedOn === new Date(now).toISOString().slice(0, 10)) return 'the daily quota is used up'
    return undefined
  }

  /** Records `quota_remaining` and `backoff` of a response (a success or an error body). */
  note(wrapper: { quota_remaining?: number | undefined; backoff?: number | undefined }, now: number) {
    if (wrapper.backoff) this.holdUntil = Math.max(this.holdUntil, now + wrapper.backoff * 1000)
    if (wrapper.quota_remaining === 0) this.exhaustedOn = new Date(now).toISOString().slice(0, 10)
  }

  /** A throttle violation without a `backoff`: rest for a while. */
  throttled(now: number) {
    this.holdUntil = Math.max(this.holdUntil, now + THROTTLE_HOLD_MS)
  }
}

const answerSchema = z.object({
  answer_id: z.number(),
  body: z.string().optional(),
  score: z.number().optional(),
  is_accepted: z.boolean().optional(),
  link: z.string().optional(),
})
const questionResponse = z.object({
  items: z
    .array(
      z.object({
        question_id: z.number(),
        title: z.string(),
        link: z.string(),
        body: z.string().optional(),
        score: z.number().optional(),
        tags: z.array(z.string()).optional(),
        accepted_answer_id: z.number().optional(),
        answers: z.array(answerSchema).optional(),
      }),
    )
    .default([]),
  quota_remaining: z.number().optional(),
  backoff: z.number().optional(),
})
const apiError = z.object({
  error_id: z.number().optional(),
  error_name: z.string().optional(),
  error_message: z.string().optional(),
  quota_remaining: z.number().optional(),
  backoff: z.number().optional(),
})

export type StackExchangeResult =
  | { ok: true; finalUrl: string; title: string; text: string; answers: number }
  | { ok: false; outcome: 'missing' | 'failed' | 'timeout'; message: string }

const miss = (outcome: 'missing' | 'failed' | 'timeout', message: string): StackExchangeResult => ({
  ok: false,
  outcome,
  message: `stackexchange-api: ${message}`,
})

/** Text of an HTML fragment of the API (a body, a title): block tags become lines, entities are decoded. */
async function plain(fragment: string): Promise<string> {
  return (await parseHtml(`<html><body>${fragment}</body></html>`)).text
}

async function titleOf(raw: string): Promise<string> {
  // The API entity-encodes titles and never sends markup in them.
  return (await parseHtml(`<html><head><title>${raw}</title></head></html>`)).title ?? raw
}

/**
 * Reads the question and its answers. The text names the canonical URL, then the question with its score, then the
 * accepted answer first and the others by score. An unreadable answer or a question that is not on the site is a miss
 * the chain moves past. `signal` aborting throws.
 */
export async function readStackExchange(
  deps: ResolvedWebDeps,
  question: StackExchangeQuestion,
  signal: AbortSignal,
  quota: StackExchangeQuota,
): Promise<StackExchangeResult> {
  const query = new URLSearchParams({ site: question.site, filter: FILTER })
  let res: Response
  try {
    res = await deps.fetch(`${API}/questions/${question.id}?${query}`, {
      headers: { accept: 'application/json', 'user-agent': 'agent-workflows/0.1 (web.fetch)' },
      signal: within(signal, TIMEOUT_MS),
    })
  } catch (error) {
    if (signal.aborted) throw error
    return miss(isAbort(error) ? 'timeout' : 'failed', isAbort(error) ? 'timed out' : describe(error))
  }
  let body: unknown
  try {
    body = await res.json()
  } catch {
    return miss('failed', `HTTP ${res.status}, unreadable answer`)
  }
  const now = Date.now()
  if (!res.ok) {
    const error = apiError.safeParse(body)
    if (error.success) {
      quota.note(error.data, now)
      if (error.data.error_id === 502 && !error.data.backoff) quota.throttled(now)
    }
    const why = error.success ? (error.data.error_name ?? error.data.error_message) : undefined
    return miss('failed', `HTTP ${res.status}${why ? ` (${why})` : ''}`)
  }
  const parsed = questionResponse.safeParse(body)
  if (!parsed.success) return miss('failed', 'unreadable answer')
  quota.note(parsed.data, now)
  const found = parsed.data.items[0]
  if (!found) return miss('missing', 'no such question on the site')
  try {
    const title = await titleOf(found.title)
    const ranked = [...(found.answers ?? [])]
      .sort(
        (a, b) =>
          Number(b.is_accepted ?? b.answer_id === found.accepted_answer_id) -
            Number(a.is_accepted ?? a.answer_id === found.accepted_answer_id) || (b.score ?? 0) - (a.score ?? 0),
      )
      .slice(0, MAX_ANSWERS)
    const parts = [
      `${title}`,
      `Source: Stack Exchange API, ${found.link}`,
      `Question (score ${found.score ?? 0}${found.tags?.length ? `, tags: ${found.tags.join(', ')}` : ''})`,
      await plain(found.body ?? ''),
    ]
    for (const answer of ranked) {
      const accepted = answer.is_accepted ?? answer.answer_id === found.accepted_answer_id
      parts.push(
        `${accepted ? 'Accepted answer' : 'Answer'} (score ${answer.score ?? 0})`,
        await plain(answer.body ?? ''),
      )
    }
    if ((found.answers?.length ?? 0) === 0) parts.push('No answers yet.')
    const text = parts.join('\n\n')
    return { ok: true, finalUrl: found.link, title, text, answers: found.answers?.length ?? 0 }
  } catch (error) {
    return miss('failed', `the question could not be parsed: ${describe(error)}`)
  }
}
