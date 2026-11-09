// What `web.fetch` knows about pages beyond one request: when a read is an empty shell rather than the page, which other
// spellings of the same URL are worth a second read, and which URL parameters are a site's own plumbing.

/** Query parameters of Reddit's JS challenge redirect: the page is the same without them. */
const CHALLENGE_PARAMS = ['solution', 'js_challenge', 'jsc_token']

/** `raw` without a bot-challenge redirect's parameters (`?solution=...&js_challenge=1&jsc_token=...`): the clean permalink. */
export function cleanUrl(raw: string): string {
  try {
    const url = new URL(raw)
    if (!url.searchParams.has('js_challenge')) return raw
    for (const param of CHALLENGE_PARAMS) url.searchParams.delete(param)
    return url.toString()
  } catch {
    return raw
  }
}

const MAX_ALTERNATES = 4
const isBgg = (host: string) => host === 'boardgamegeek.com' || host.endsWith('.boardgamegeek.com')

/**
 * Other spellings of the same page, in the order worth trying: pagination as a query (`/page/2` → `?page=2`) or as a path
 * (`?page=2` → `/page/2`), and a BoardGameGeek geeklist by its id alone (the slug dropped). A site that builds the page
 * for one spelling and serves an empty shell for another is why: the read of the first may come back without its items
 * while the second returns them. Same host and scheme only, so no alternate leaves what the SSRF guard already vetted.
 */
export function alternateUrls(raw: string): string[] {
  let base: URL
  try {
    base = new URL(raw)
  } catch {
    return []
  }
  base.hash = ''
  const seen = new Set<string>([base.toString()])
  const found: URL[] = []
  const add = (candidate: URL) => {
    const text = candidate.toString()
    if (seen.has(text)) return
    seen.add(text)
    found.push(candidate)
  }
  const pathPage = base.pathname.match(/^(.*?)\/page[/-](\d+)\/?$/i)
  if (pathPage) {
    const next = new URL(base)
    next.pathname = pathPage[1] || '/'
    next.searchParams.set('page', pathPage[2]!)
    add(next)
  }
  const queryPage = base.searchParams.get('page')
  if (queryPage && /^\d+$/.test(queryPage)) {
    const next = new URL(base)
    next.searchParams.delete('page')
    next.pathname = `${base.pathname.replace(/\/+$/, '')}/page/${queryPage}`
    add(next)
  }
  if (isBgg(base.hostname)) {
    for (const from of [base, ...found]) {
      const slug = from.pathname.match(/^\/geeklist\/(\d+)\/(?!page[/-]\d)[^/]+\/?$/i)
      if (!slug) continue
      const next = new URL(from)
      next.pathname = `/geeklist/${slug[1]}`
      add(next)
    }
  }
  return found.map((u) => u.toString()).slice(0, MAX_ALTERNATES)
}

/** A page this short that says one of these is an app asking for a browser, or a list that rendered empty. */
const NOTICE_MAX_CHARS = 1500
const NOTICE =
  /(?:enable|requires?|needs?|without|disabled?)\W+(?:java\s?script|js)\b|java\s?script\W+(?:is\W+|must\W+be\W+)?(?:required|disabled|needed|not enabled|turned off)|no (?:results|items|games|entries|products|listings) (?:were )?(?:found|to show|available)|nothing (?:was )?found|keine (?:ergebnisse|produkte|treffer)/i

/** Lists whose items a read must hold: a page of one of these without a single item marker was read before its list rendered. */
const LISTS: { host: (host: string) => boolean; path: RegExp; marker: RegExp; what: string }[] = [
  // A geeklist prints each item's ordinal on a line of its own (`#26`); the XML API lives under /xmlapi2 and is no page.
  { host: isBgg, path: /^\/geeklist\/\d+/i, marker: /^#\d+\b/m, what: 'geeklist items' },
]

/**
 * Why a read of `url` is the shell of the page rather than the page, or undefined when it is complete as far as can be
 * told: a JS-required or no-results notice in a short text, or a page of a known list kind without its items. A page
 * that is merely short is not incomplete.
 */
export function incompleteReason(url: string, text: string): string | undefined {
  if (text.length < NOTICE_MAX_CHARS && NOTICE.test(text)) {
    return `a ${text.length}-character page that only says JavaScript is required or nothing was found`
  }
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return undefined
  }
  for (const list of LISTS) {
    if (list.host(parsed.hostname) && list.path.test(parsed.pathname) && !list.marker.test(text)) {
      return `no ${list.what} in the text (the list was not rendered)`
    }
  }
  return undefined
}
