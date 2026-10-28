const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  copy: '©',
  laquo: '«',
  raquo: '»',
}

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (whole, body: string) => {
    if (body[0] === '#') {
      const code =
        body[1]?.toLowerCase() === 'x' ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10)
      if (!Number.isInteger(code) || code <= 0 || code > 0x10ffff) return whole
      // A lone surrogate is not a character: a browser shows U+FFFD, and the text must stay valid UTF-16 for what reads it.
      return code >= 0xd800 && code <= 0xdfff ? '\ufffd' : String.fromCodePoint(code)
    }
    return ENTITIES[body.toLowerCase()] ?? whole
  })
}

/** Elements whose content is not page text (code, styles, template and fallback markup): dropped with their content. */
const RAW = new Set(['script', 'style', 'noscript', 'svg', 'template', 'iframe'])
/** Elements that break a line. Every other tag is dropped and its content kept. */
const BLOCKS = new Set(
  (
    'p div section article main header footer nav aside li ul ol dl dt dd table thead tbody tfoot tr td th caption ' +
    'br hr h1 h2 h3 h4 h5 h6 pre blockquote figure figcaption form fieldset legend details summary address ' +
    'select optgroup option textarea'
  ).split(' '),
)
/** The `<main>` or `<article>` text stands for the page only when it is at least this share of all the page text. */
const SCOPE_SHARE = 0.5
const TITLE_CHARS = 300

const tidy = (text: string) =>
  decodeEntities(text)
    .split('\n')
    .map((line) => line.replace(/[ \t\u00a0]+/g, ' ').trim())
    .filter((line, n, lines) => line !== '' || (n > 0 && lines[n - 1] !== ''))
    .join('\n')
    .trim()

/**
 * The page's title and readable text. The body is hostile input of up to a couple of megabytes, so it is tokenized by
 * Bun's `HTMLRewriter` (lol-html: streaming, linear, browser-grade tokenizing of quotes, comments, raw-text elements and
 * unclosed markup) instead of anything hand-written; this only collects what the handlers see.
 *
 * `script`, `style`, `noscript`, `template`, `iframe`, `svg` and `title` are skipped with their content (one that never
 * closes swallows the rest, as in a browser). Block tags break a line; every other tag is ignored and its content kept,
 * `form`, `nav` and `button` included (ASP.NET wraps a whole page in one `<form>`). The `<main>` text stands for the
 * page when it is at least half of it, else `<article>`'s, else the whole page: a teaser `<article>` must not hide a
 * page. Text is untrusted page content and stays data. Rejects if the rewriter does; the caller treats that as a page
 * it cannot read.
 */
export async function parseHtml(html: string): Promise<{ title?: string; text: string }> {
  let all = ''
  let main = ''
  let article = ''
  let title = ''
  let titled = false
  let skip = 0 // depth inside a skipped element
  let inMain = 0
  let inArticle = 0
  let inTitle = 0

  const emit = (text: string) => {
    all += text
    if (inMain > 0) main += text
    if (inArticle > 0) article += text
  }

  const rewriter = new HTMLRewriter()
    .on('*', {
      element(el) {
        const name = el.tagName.toLowerCase()
        const raw = RAW.has(name) || name === 'title'
        const isTitle = name === 'title' && !titled && skip === 0 // the page's own, not an `<svg>` caption
        const block = BLOCKS.has(name)
        if (isTitle) {
          titled = true
          inTitle++
        }
        if (raw) skip++
        if (name === 'main') inMain++
        if (name === 'article') inArticle++
        if (block && skip === 0) emit('\n')
        const leave = () => {
          if (isTitle) inTitle--
          if (raw) skip--
          if (name === 'main') inMain--
          if (name === 'article') inArticle--
          if (block && skip === 0) emit('\n')
        }
        // `canHaveContent` is the parse (`<script/>` still opens a script; lol-html's `selfClosing` is only the spelling).
        if (el.canHaveContent) el.onEndTag(leave)
        else leave()
      },
    })
    .onDocument({
      text(chunk) {
        if (inTitle > 0) title += chunk.text
        if (skip === 0) emit(chunk.text)
      },
    })

  await rewriter.transform(new Response(html)).text()

  const whole = tidy(all)
  const scoped = [main, article].map(tidy).find((text) => text !== '' && text.length >= whole.length * SCOPE_SHARE)
  const cleanTitle = decodeEntities(title).replace(/\s+/g, ' ').trim().slice(0, TITLE_CHARS)
  return { ...(cleanTitle ? { title: cleanTitle } : {}), text: scoped ?? whole }
}

/** `text` cut to at most `max` UTF-16 units without splitting a surrogate pair. */
export function cut(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false }
  const high = text.charCodeAt(max - 1)
  return { text: text.slice(0, high >= 0xd800 && high <= 0xdbff ? max - 1 : max), truncated: true }
}
