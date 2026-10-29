import { accountColumnWidth, renderQuotaHeader } from './quota.ts'
import {
  type AccountQuota,
  type AgentState,
  type Project,
  RECOMMENDATION_ICON,
  type Recommendation,
  type Snapshot,
} from './schema.ts'
import {
  BOLD,
  BOLD_RED,
  clampLine,
  clampVisible,
  CYAN,
  DIM,
  DIM_GREEN,
  GREEN,
  MAGENTA,
  MIN_TITLE_CHARS,
  RED,
  RESET,
  relativeAge,
  truncate,
  YELLOW,
} from './text.ts'

const STATE_ICON: Record<AgentState, string> = {
  needs_you: '!',
  working: '●',
  idle: '○',
  stale: '·',
  done: '✓',
  unknown: '?',
}

const MAX_LINE_CHARS = 110
const MAX_TITLE_CHARS = 48
// MAX_LINE_CHARS minus the "      — " prefix (8 chars) of a standing line, so `truncate`'s own "…" survives the hard cut.
const MAX_STANDING_CHARS = MAX_LINE_CHARS - 8

// `cols` unset keeps the fixed widths above; set, every visible width is derived from it.
export const MIN_COLS = 40
export const MAX_COLS = 200
export const DEFAULT_COLS = 110
// Below this width "  [N agents]" on the project line is the difference between fitting and wrapping on a phone.
const DROP_AGENT_COUNT_BELOW_COLS = 90
// Below this width the single header line (counts, ISO timestamp, overview age) exceeds `cols` on its own: split it.
const SPLIT_HEADER_BELOW_COLS = 100

/** Clamps and defaults `--cols`. Non-numeric or absent: `DEFAULT_COLS`. */
export function parseCols(raw: string | number | undefined): number {
  const parsed = typeof raw === 'number' ? raw : raw ? Number.parseInt(raw, 10) : Number.NaN
  if (!Number.isFinite(parsed)) return DEFAULT_COLS
  return Math.min(MAX_COLS, Math.max(MIN_COLS, parsed))
}

/** Per-agent verdict by agent id; absent means no recommendation, and the row shows the state icon. */
export interface AgentEnrichment {
  recommendation: Recommendation
  standing: string | null
}

export interface RenderTextOptions {
  /** Per-account quota: a quota header on top and an account column per agent row. */
  quota?: Record<string, AccountQuota>
  enrichment?: Map<string, AgentEnrichment>
  /** The newest overview run's age, or null when none exists. The key being present adds the `· overview <age>` suffix. */
  overview?: { ageMs: number } | null
  /** ANSI colour. Off renders plain text; `stripAnsi` of the coloured output (minus the bar line) is the plain render. */
  color?: boolean
  /** Terminal width, `MIN_COLS`..`MAX_COLS`. */
  cols?: number
}

/**
 * Colour by the verdict when there is one, else by the state; `needs_you` always wins: a blocked or waiting pane never
 * renders as anything but urgent, even if an older verdict called it stale.
 */
function effectiveCategory(state: AgentState, enrichment: AgentEnrichment | undefined): Recommendation | AgentState {
  if (state === 'needs_you') return 'needs_you'
  return enrichment ? enrichment.recommendation : state
}

/** Both enums share the string "stale", so one switch covers both. */
function categoryColor(category: Recommendation | AgentState): string {
  switch (category) {
    case 'answer':
    case 'needs_you':
      return BOLD_RED
    case 'ship':
    case 'merge':
      return YELLOW
    case 'review':
      return MAGENTA
    case 'working':
    case 'watch':
      return GREEN
    case 'continue':
      return CYAN
    case 'idle':
    case 'stale':
      return DIM
    case 'done':
    case 'close':
      return DIM_GREEN
    default:
      return ''
  }
}

// Doubled "!!" for the answer / needs_you bucket in the summary bar only: a single "!" is easy to miss in a pane.
const BAR_ICON: Record<Recommendation | AgentState, string> = {
  answer: '!!',
  needs_you: '!!',
  continue: '→',
  ship: '⇧',
  review: '⚑',
  merge: '⇄',
  close: '✓',
  done: '✓',
  stale: '·',
  watch: '●',
  working: '●',
  idle: '○',
  unknown: '?',
}

// The bar counts by one enum at a time, never both: recommendation and state buckets share glyphs ("●"), and each
// list's own icons are unique.
const RECOMMENDATION_BAR_ORDER: Recommendation[] = [
  'answer',
  'ship',
  'merge',
  'review',
  'continue',
  'watch',
  'close',
  'stale',
]
const STATE_BAR_ORDER: AgentState[] = ['needs_you', 'working', 'idle', 'stale', 'done', 'unknown']

/**
 * The coloured mode's summary bar: by recommendation when an overview run exists (an agent without one folds into a
 * trailing plain `? n`), by state otherwise. Non-zero buckets only, most urgent first; null when there is nothing.
 */
function buildRecommendationBar(
  projects: Project[],
  enrichment: Map<string, AgentEnrichment> | undefined,
  overviewExists: boolean,
): string | null {
  const parts: string[] = []
  const segment = (category: Recommendation | AgentState, n: number) => {
    const color = categoryColor(category)
    const text = `${BAR_ICON[category]} ${n}`
    return color ? `${color}${text}${RESET}` : text
  }

  if (overviewExists) {
    const counts = new Map<Recommendation, number>()
    let unrecommended = 0
    for (const project of projects) {
      for (const agent of project.agents) {
        const rec = enrichment?.get(agent.id)?.recommendation
        if (rec) counts.set(rec, (counts.get(rec) ?? 0) + 1)
        else unrecommended += 1
      }
    }
    for (const rec of RECOMMENDATION_BAR_ORDER) {
      const n = counts.get(rec)
      if (n) parts.push(segment(rec, n))
    }
    if (unrecommended > 0) parts.push(`? ${unrecommended}`)
  } else {
    const counts = new Map<AgentState, number>()
    for (const project of projects) {
      for (const agent of project.agents) counts.set(agent.state, (counts.get(agent.state) ?? 0) + 1)
    }
    for (const state of STATE_BAR_ORDER) {
      const n = counts.get(state)
      if (n) parts.push(segment(state, n))
    }
  }
  return parts.length > 0 ? parts.join('   ') : null
}

/**
 * Fits the single-line header into `max` columns without ever cutting the meta suffix (`· overview <age>` / `· overview
 * none`), the one thing a `watch` pane exists to show. The ISO date becomes time of day first, then the counts shorten.
 */
export function fitHeader(counts: string, iso: string, suffix: string, max: number): string {
  const full = `${counts}  (${iso})${suffix}`
  if (full.length <= max) return full
  const timeOnly = iso.length > 11 ? iso.slice(11) : iso
  const tail = `  (${timeOnly})${suffix}`
  const compact = `${counts}${tail}`
  if (compact.length <= max) return compact
  return `${truncate(counts, Math.max(MIN_TITLE_CHARS, max - tail.length))}${tail}`
}

/**
 * The snapshot as compact text for `watch`. With `enrichment` a recommendation icon replaces the state icon and a
 * standing line follows the row; with `quota` the account header and column appear; `color` adds SGR codes and the
 * summary bar; `cols` re-derives every width from a narrower terminal.
 */
export function renderText(snapshot: Snapshot, opts?: RenderTextOptions): string {
  const { summary, generatedAt, projects } = snapshot
  const color = opts?.color === true
  const cols = opts?.cols
  const lineMax = cols ?? MAX_LINE_CHARS
  const rowAccounts = projects.flatMap((p) => p.agents.map((a) => a.account))
  const idWidth = opts?.quota ? accountColumnWidth(opts.quota, rowAccounts) : 0
  const accountColWidth = opts?.quota ? idWidth + 1 : 0
  const titleMax = (cols != null ? Math.max(MIN_TITLE_CHARS, cols - 40) : MAX_TITLE_CHARS) - accountColWidth
  const standingMax = cols != null ? cols - 8 : MAX_STANDING_CHARS
  const dropAgentCount = cols != null && cols < DROP_AGENT_COUNT_BELOW_COLS
  const splitHeader = cols != null && cols < SPLIT_HEADER_BELOW_COLS
  const lines: string[] = []

  if (opts?.quota) {
    for (const quotaLine of renderQuotaHeader(opts.quota, generatedAt, idWidth)) {
      lines.push(color ? clampVisible(`${DIM}${quotaLine}${RESET}`, lineMax) : clampLine(quotaLine, lineMax))
    }
  }

  const generatedAtIso = new Date(generatedAt).toISOString()
  const countsText =
    `agents: ${summary.needsYou} needs_you · ${summary.working} working · ${summary.idle} idle · ` +
    `${summary.stale} stale · ${summary.done} done · ${summary.dispatch} dispatch`
  let metaText = `(${generatedAtIso})`
  if (opts && 'overview' in opts) {
    metaText +=
      opts.overview != null
        ? `  · overview ${relativeAge(generatedAt - opts.overview.ageMs, generatedAt)}`
        : '  · overview none'
  }
  // Without `cols` the header is never clamped: it is first-party, bounded text, and its clamp would drop the
  // `overview <age>` suffix the caller asked for. With `cols` the cut lands on the counts, never on the suffix.
  if (splitHeader) {
    const line1 = color ? `${DIM}${countsText}${RESET}` : countsText
    const line2 = color ? `${DIM}${metaText}${RESET}` : metaText
    if (color) lines.push(clampVisible(line1, lineMax), clampVisible(line2, lineMax))
    else lines.push(clampLine(line1, lineMax), clampLine(line2, lineMax))
  } else {
    const header =
      cols != null
        ? fitHeader(countsText, generatedAtIso, metaText.slice(generatedAtIso.length + 2), lineMax)
        : `${countsText}  ${metaText}`
    lines.push(color ? `${DIM}${header}${RESET}` : header)
  }

  if (color) {
    const bar = buildRecommendationBar(projects, opts?.enrichment, opts?.overview != null)
    if (bar) lines.push(bar)
  }

  // Present-human work comes before any project: an agent blocked on a fingerprint is the most actionable line on the
  // screen, and no overview run is needed for it to be right.
  if (snapshot.humanQueue.length > 0) {
    const heading = `needs you (human queue: ${snapshot.humanQueue.length})`
    lines.push(color ? `${BOLD_RED}${heading}${RESET}` : heading)
    for (const req of snapshot.humanQueue) {
      const askedMs = req.askedAt ? Date.parse(req.askedAt) : Number.NaN
      const age = relativeAge(Number.isNaN(askedMs) ? null : askedMs, generatedAt)
      const marker = req.cmd ? '  [cmd]' : ''
      const question = req.question.replace(/\s+/g, ' ').trim()
      // "  ! " + question + "  · " + age + marker: the two fixed pieces are 8 chars together.
      const budget = Math.max(MIN_TITLE_CHARS, lineMax - 8 - age.length - marker.length)
      const line = `  ! ${truncate(question, budget)}  · ${age}${marker}`
      lines.push(color ? clampVisible(`${RED}${line}${RESET}`, lineMax) : clampLine(line, lineMax))
    }
  }

  for (const project of projects) {
    const branch = project.git ? project.git.branch + (project.git.dirty ? '*' : '') : '?'
    const agentCountSuffix = dropAgentCount ? '' : `  [${project.agents.length} agents]`
    if (color) {
      const branchName = project.git ? project.git.branch : '?'
      const dirty = project.git?.dirty ?? false
      const coloredBranch = `${CYAN}${branchName}${RESET}${dirty ? `${RED}*${RESET}` : ''}`
      const projectLine =
        `${BOLD}▸ ${project.name}  ${RESET}${coloredBranch}` +
        (agentCountSuffix ? `${BOLD}${agentCountSuffix}${RESET}` : '')
      lines.push(clampVisible(projectLine, lineMax))
    } else {
      lines.push(clampLine(`▸ ${project.name}  ${branch}${agentCountSuffix}`, lineMax))
    }

    for (const agent of project.agents) {
      const enrichment = opts?.enrichment?.get(agent.id)
      const icon = enrichment ? RECOMMENDATION_ICON[enrichment.recommendation] : STATE_ICON[agent.state]
      const statePadded = agent.state.padEnd(9)
      const title = truncate(agent.title ?? '(untitled)', titleMax)
      const age = relativeAge(agent.lastActivityAt, generatedAt)
      const accountCol = opts?.quota ? `${(agent.account ?? '?').padEnd(idWidth)} ` : ''
      const base = `  ${icon} ${statePadded} ${accountCol}${title}  · ${age}`

      if (color) {
        const spanColor = categoryColor(effectiveCategory(agent.state, enrichment))
        let line = spanColor ? `${spanColor}${base}${RESET}` : base
        if (agent.waitingFor) line += `${RED}  · ${agent.waitingFor}${RESET}`
        lines.push(clampVisible(line, lineMax))
        if (enrichment?.standing) {
          const standingText = `      — ${truncate(enrichment.standing, standingMax)}`
          lines.push(clampVisible(`${DIM}${standingText}${RESET}`, lineMax))
        }
      } else {
        let line = base
        if (agent.waitingFor) line += `  · ${agent.waitingFor}`
        lines.push(clampLine(line, lineMax))
        if (enrichment?.standing)
          lines.push(clampLine(`      — ${truncate(enrichment.standing, standingMax)}`, lineMax))
      }
    }
  }

  return `${lines.join('\n')}\n`
}
