import { basename } from 'node:path'
import { NARRATIVE_LIMITS, type NarrativeSections } from '@agent-workflows/capabilities'

const L = NARRATIVE_LIMITS

/** Truncates with an elided "…" when over budget (agent-gateway's `truncate`). */
export function truncate(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text
}

// ── Link and comment stripping ─────────────────────────────────────────────────────────────

const WIKILINK_RE = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g
const HTML_COMMENT_RE = /<!--[\s\S]*?-->/g

/**
 * Strips any `[[wikilink]]` the model invents (a link to a page that does not exist is a vault lint ERROR), unwrapped to
 * its display text (`[[Foo|Bar]]` → `Bar`, `[[Foo]]` → `Foo`), and strips HTML comments. Applied to model-authored
 * section text before it is rendered into a page; never to the untrusted data fed into the prompt.
 */
export function stripInventedLinks(text: string): string {
  return text
    .replace(HTML_COMMENT_RE, '')
    .replace(WIKILINK_RE, (_match, target: string, display?: string) => (display ?? target).trim())
}

/** Strips model-invented wikilinks and HTML comments from every section field. */
export function sanitizeSections(sections: NarrativeSections): NarrativeSections {
  return {
    whatItIs: stripInventedLinks(sections.whatItIs),
    whereItStands: sections.whereItStands.map(stripInventedLinks),
    howItGotHere: sections.howItGotHere.map((e) => ({ date: e.date, text: stripInventedLinks(e.text) })),
    openQuestions: sections.openQuestions.map(stripInventedLinks),
  }
}

// ── Cap enforcement ─────────────────────────────────────────────────────────────────────────

/** Index of the last space at or before `limit`: the fallback word boundary. A hard `limit` cut only when there is none. */
function lastWordBoundaryIndex(text: string, limit: number): number {
  const idx = text.slice(0, limit).lastIndexOf(' ')
  return idx > 0 ? idx : limit
}

/** Index just past the last sentence-ending punctuation (`.`/`!`/`?` followed by whitespace or the end) at or before `limit`, or -1. */
function lastSentenceEndIndex(text: string, limit: number): number {
  const re = /[.!?](?=\s|$)/g
  let end = -1
  let m: RegExpExecArray | null = re.exec(text)
  while (m) {
    const candidate = m.index + 1
    if (candidate > limit) break
    end = candidate
    m = re.exec(text)
  }
  return end
}

/**
 * Clamps `whatItIs` to `maxChars` without cutting mid-word or mid-sentence: prefers the last full-sentence boundary at or
 * before the cap (no ellipsis), as long as that keeps `minSentenceChars`; otherwise the last word boundary with an
 * ellipsis. Text already within the cap is returned untouched.
 */
export function clampWhatItIs(text: string, maxChars: number, minSentenceChars: number): string {
  const trimmed = text.trim()
  if (trimmed.length <= maxChars) return trimmed
  const sentenceEnd = lastSentenceEndIndex(trimmed, maxChars)
  if (sentenceEnd >= minSentenceChars) return trimmed.slice(0, sentenceEnd)
  // One char is reserved for the appended "…" so the final string never exceeds maxChars.
  const wordEnd = lastWordBoundaryIndex(trimmed, maxChars - 1)
  return `${trimmed.slice(0, wordEnd).trimEnd()}…`
}

/** Clamps to `maxChars` at the last word boundary, appending "…". Text within the cap is returned untouched. */
export function clampToWordBoundary(text: string, maxChars: number): string {
  const trimmed = text.trim()
  if (trimmed.length <= maxChars) return trimmed
  const wordEnd = lastWordBoundaryIndex(trimmed, maxChars - 1)
  return `${trimmed.slice(0, wordEnd).trimEnd()}…`
}

/**
 * Enforces every hard cap of the skill prompt in code, after the model answers. `howItGotHere` keeps the most RECENT
 * entries when over the item cap (the list is oldest → newest, so trimming the front preserves the current arc).
 */
export function clampSections(sections: NarrativeSections): NarrativeSections {
  return {
    whatItIs: clampWhatItIs(sections.whatItIs.trim(), L.whatItIsChars, L.whatItIsMinSentenceChars),
    whereItStands: sections.whereItStands
      .slice(0, L.whereItStandsItems)
      .map((s) => truncate(s.trim(), L.whereItStandsChars)),
    howItGotHere: sections.howItGotHere
      .slice(-L.howItGotHereItems)
      .map((e) => ({ date: e.date, text: truncate(e.text.trim(), L.howItGotHereChars) })),
    openQuestions: sections.openQuestions
      .slice(0, L.openQuestionsItems)
      .map((s) => truncate(s.trim(), L.openQuestionsChars)),
  }
}

// ── Page rendering ──────────────────────────────────────────────────────────────────────────

const DESCRIPTION_MAX_CHARS = 160

function firstSentence(text: string): string {
  const match = text.match(/^.*?[.!?](?=\s|$)/)
  return (match ? match[0] : text).trim()
}

/** Double-quoted YAML scalar: the model's prose routinely contains a colon-space, which breaks an unquoted flow value. */
function yamlString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

export interface RenderNarrativePageInput {
  project: string
  cwd: string
  since: string | null
  /** ISO date (YYYY-MM-DD) of this revision. */
  timestamp: string
  sections: NarrativeSections
}

/** Frontmatter + sections → full page markdown. Pure formatting: callers have already clamped and sanitized `sections`. */
export function renderNarrativePage(input: RenderNarrativePageInput): string {
  const { project, cwd, since, timestamp, sections } = input
  const description = clampToWordBoundary(firstSentence(sections.whatItIs), DESCRIPTION_MAX_CHARS)
  const frontmatter = [
    '---',
    `title: ${yamlString(project)}`,
    'type: project-narrative',
    `description: ${yamlString(description)}`,
    'tags: [project, engineering, narrative]',
    `timestamp: ${timestamp}`,
    `repo: ${yamlString(basename(cwd))}`,
    `revised_from: ${yamlString(since ?? 'bootstrap')}`,
    'generated_by: agent-gateway/narrative',
    '---',
  ].join('\n')

  const lines: string[] = [
    frontmatter,
    '',
    `# ${project}`,
    '',
    sections.whatItIs,
    '',
    '## Where it stands',
    ...sections.whereItStands.map((s) => `- ${s}`),
    '',
    '## How it got here',
    ...sections.howItGotHere.map((e) => `- **${e.date}** — ${e.text}`),
  ]
  if (sections.openQuestions.length > 0)
    lines.push('', '## Open questions', ...sections.openQuestions.map((s) => `- ${s}`))
  return `${lines.join('\n')}\n`
}

// ── Frontmatter and headings ────────────────────────────────────────────────────────────────

// A block is `---\n`, optional content lines, `---\n`: an empty block is frontmatter, a leading `---` with no closing
// delimiter line is not.
const FRONTMATTER_RE = /^---\n(?:[\s\S]*?\n)?---\n/
const HEADING_LINE_RE = /^#{1,6} .*$/gm

/** Splits a page into its YAML frontmatter (delimiters and trailing newline included, "" when there is none) and the body after it. */
export function splitFrontmatter(page: string): { frontmatter: string; body: string } {
  const frontmatter = FRONTMATTER_RE.exec(page)?.[0] ?? ''
  return { frontmatter, body: page.slice(frontmatter.length) }
}

export const headingLines = (markdown: string): string[] => markdown.match(HEADING_LINE_RE) ?? []
