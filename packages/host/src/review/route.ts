// Review v4 router: the change sets the tier, not the author. Rules and rationale: docs/spikes/review-v4/wiring.md §Routing.
import { defaultExec } from '../process.ts'

export const TIERS = ['none', 'light', 'standard', 'deep'] as const
export type Tier = (typeof TIERS)[number]
export interface Seat {
  model: 'sonnet'
  effort: 'low' | 'medium' | 'high'
  vote?: number
}
export const SEATS: Record<Tier, Seat | null> = {
  none: null,
  light: { model: 'sonnet', effort: 'medium' },
  // standard and light share a seat until the tier set is collapsed
  standard: { model: 'sonnet', effort: 'medium' },
  deep: { model: 'sonnet', effort: 'high', vote: 1 },
}

const DEEP_CODE_LINES = 800
const DEEP_PACKAGES = 3
const LIGHT_CODE_LINES = 40
const LIGHT_FILES = 3
const DOC = /\.(md|mdx|txt)$/
const DOCS_DIR = /(^|\/)docs\//
const AGENT_FILE = /(^|\/)(AGENTS|CLAUDE|SKILL|REVIEW)\.md$|(^|\/)(rules|skills|agents|\.claude)\//
/** A doc: a prose file, or anything under a `docs/` directory. */
const isDoc = (path: string): boolean => DOC.test(path) || DOCS_DIR.test(path)
/** Instructions an agent reads: reviewed even when they are docs. */
const isAgentFacing = (path: string): boolean => AGENT_FILE.test(path)
const TEST = /(^|\/)(test|tests|__tests__)\/|\.test\.[a-z]+$|\.spec\.[a-z]+$/

const GIT_TIMEOUT_MS = 30_000

export const maxTier = (a: Tier, b: Tier): Tier => (TIERS.indexOf(a) >= TIERS.indexOf(b) ? a : b)
export const atLeast = (tier: Tier, floor: Tier): boolean => TIERS.indexOf(tier) >= TIERS.indexOf(floor)

export interface ReviewConfig {
  none: string[]
  sensitive: string[]
  nits: number
}
export const DEFAULT_REVIEW_CONFIG: ReviewConfig = { none: [], sensitive: [], nits: 3 }

const isGlobList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((g) => typeof g === 'string')

/** REVIEW.md text → its frontmatter; null/absent/malformed frontmatter → DEFAULT_REVIEW_CONFIG (malformed: also a `warning` string). */
export function parseReviewMd(text: string | null): { config: ReviewConfig; warning?: string } {
  const fallback = { config: DEFAULT_REVIEW_CONFIG }
  const block = text === null ? null : /^---\n(.*?)\n---/s.exec(text)
  if (!block) return fallback
  const malformed = (why: string) => ({ ...fallback, warning: `REVIEW.md frontmatter ignored: ${why}` })
  let parsed: unknown
  try {
    parsed = Bun.YAML.parse(block[1] ?? '')
  } catch (error) {
    return malformed(error instanceof Error ? error.message : String(error))
  }
  if (parsed === null) return fallback
  if (typeof parsed !== 'object' || Array.isArray(parsed)) return malformed('not a mapping')
  const { none = [], sensitive = [], nits = DEFAULT_REVIEW_CONFIG.nits } = parsed as Record<string, unknown>
  if (!isGlobList(none)) return malformed('none must be a list of globs')
  if (!isGlobList(sensitive)) return malformed('sensitive must be a list of globs')
  if (typeof nits !== 'number' || !Number.isInteger(nits) || nits < 0) return malformed('nits must be an integer')
  return { config: { none, sensitive, nits } }
}

function escapeRegex(char: string): string {
  return /[.*+?^${}()|[\]\\/-]/.test(char) ? `\\${char}` : char
}

/** Python `fnmatch.translate`, case-sensitive: `*` crosses `/`, `?`, `[seq]`, `[!seq]`. */
function globToRegex(glob: string): RegExp {
  let out = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!
    if (c === '*') out += '.*'
    else if (c === '?') out += '.'
    else if (c === '[') {
      let j = i + 1
      if (glob[j] === '!') j++
      if (glob[j] === ']') j++
      while (j < glob.length && glob[j] !== ']') j++
      if (j >= glob.length) {
        out += '\\['
        continue
      }
      let stuff = glob
        .slice(i + 1, j)
        .replace(/\\/g, '\\\\')
        .replace(/\]/g, '\\]')
      if (stuff.startsWith('!')) stuff = `^${stuff.slice(1)}`
      else if (stuff.startsWith('^')) stuff = `\\${stuff}`
      out += `[${stuff}]`
      i = j
    } else out += escapeRegex(c)
  }
  return new RegExp(`^${out}$`, 's')
}

const globCache = new Map<string, RegExp>()
const fnmatch = (path: string, glob: string): boolean => {
  let re = globCache.get(glob)
  if (!re) {
    re = globToRegex(glob)
    globCache.set(glob, re)
  }
  return re.test(path)
}

function match(path: string, globs: string[]): string | null {
  for (const g of globs) {
    if (fnmatch(path, g) || (g.startsWith('**/') && fnmatch(path, g.slice(3)))) return g
  }
  return null
}

/** A test is never sensitive; a doc only when the glob names docs itself (`rules/security.md`), not a package dir. */
function sensitive(path: string, globs: string[]): boolean {
  if (TEST.test(path)) return false
  const g = match(path, globs)
  return g !== null && (!DOC.test(path) || DOC.test(g))
}

export interface FileChange {
  path: string
  added: number
  removed: number
}
export interface RouteFacts {
  files: number
  codeFiles: number
  codeLines: number
  prodLines: number
  packages: string[]
}
export interface RouteDecision extends RouteFacts {
  tier: Tier
  seat: Seat | null
  rule: string
  /** 'rule' = a rule decided; 'default' = no rule matched, the fall-through standard (the classifier's only case); 'caller' = --min raised it */
  decidedBy: 'rule' | 'default' | 'caller' | 'classifier'
}

const sum = (changes: FileChange[]) => changes.reduce((n, f) => n + f.added + f.removed, 0)

function factsOf(counted: FileChange[]): RouteFacts & { code: FileChange[] } {
  const code = counted.filter((f) => !isDoc(f.path))
  const packages = new Set(code.filter((f) => f.path.startsWith('packages/')).map((f) => f.path.split('/')[1]!))
  return {
    files: counted.length,
    codeFiles: code.length,
    codeLines: sum(code),
    prodLines: sum(code.filter((f) => !TEST.test(f.path))),
    packages: [...packages].sort(),
    code,
  }
}

function raise(decision: RouteDecision, min: Tier | undefined): RouteDecision {
  if (!min || atLeast(decision.tier, min)) return decision
  return {
    ...decision,
    tier: min,
    seat: SEATS[min],
    rule: `${decision.rule} (raised by caller from ${decision.tier})`,
    decidedBy: 'caller',
  }
}

/** A sensitive path is deep, unless this is a fix round of a deep thread: then only the other rules can keep it deep. */
function decideSensitive(
  input: { changes: FileChange[]; config: ReviewConfig; threadDeep?: boolean },
  hit: string[],
): { tier: Tier; rule: string } {
  const rule = `sensitive path: ${hit[0]}${hit.length > 1 ? ` (+${hit.length - 1})` : ''}`
  if (!input.threadDeep) return { tier: 'deep', rule }
  const rest = decide({
    changes: input.changes,
    contentChanged: true,
    config: { ...input.config, sensitive: [] },
  })
  if (rest.tier === 'deep') return { tier: 'deep', rule: rest.rule }
  return { tier: 'standard', rule: `${rule} (fix round, thread already deep)` }
}

/** Pure: the rules table. contentChanged=false means the diff is empty ignoring whitespace and blank lines. */
export function decide(input: {
  changes: FileChange[]
  contentChanged: boolean
  config: ReviewConfig
  min?: Tier
  /** The thread already holds a submitted deep round: a fix round that is deep only by a sensitive path routes standard. */
  threadDeep?: boolean
}): RouteDecision {
  const { config } = input
  const counted = input.changes.filter((f) => f.added + f.removed > 0)
  const { code, ...facts } = factsOf(counted)
  const by = (tier: Tier, rule: string, decidedBy: 'rule' | 'default' = 'rule'): RouteDecision =>
    raise({ tier, seat: SEATS[tier], rule, decidedBy, ...facts }, input.min)

  if (counted.length === 0 || !input.contentChanged) return by('none', 'no content change (renames or whitespace only)')
  if (counted.every((f) => match(f.path, config.none))) return by('none', 'every file matches REVIEW.md none')
  const hit = counted.filter((f) => sensitive(f.path, config.sensitive)).map((f) => f.path)
  if (hit.length > 0) {
    const sensitiveHit = decideSensitive(input, hit)
    return by(sensitiveHit.tier, sensitiveHit.rule)
  }
  if (code.length === 0) {
    return counted.some((f) => isAgentFacing(f.path)) ? by('light', 'agent instructions') : by('none', 'docs only')
  }
  if (code.every((f) => TEST.test(f.path))) return by('light', 'tests only')
  if (facts.prodLines > DEEP_CODE_LINES) {
    return by('deep', `${facts.prodLines} changed non-test code lines > ${DEEP_CODE_LINES}`)
  }
  if (facts.packages.length > DEEP_PACKAGES) {
    return by('deep', `${facts.packages.length} packages > ${DEEP_PACKAGES}: a cross-package change`)
  }
  if (code.some((f) => f.path.endsWith('package.json'))) return by('standard', 'a manifest changed (dependencies)')
  if (facts.codeLines <= LIGHT_CODE_LINES && code.length <= LIGHT_FILES) {
    return by('light', `small: ${facts.codeLines} code lines in ${code.length} files`)
  }
  return by('standard', 'default', 'default')
}

export type Classifier = (input: { changes: FileChange[]; facts: RouteFacts }) => Promise<Tier | null>
export type GitRunner = (cwd: string, args: string[]) => Promise<string>

export const gitRunner: GitRunner = async (cwd, args) => {
  const result = await defaultExec(['git', ...args], { cwd, timeoutMs: GIT_TIMEOUT_MS })
  if (result.code === 0) return result.stdout
  const why = result.timedOut ? 'timed out' : result.stderr.trim() || `exit ${result.code}`
  throw new Error(`git ${args.join(' ')}: ${why}`)
}

function parseNumstat(out: string): FileChange[] {
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [added = '-', removed = '-', ...rest] = line.split('\t')
      return {
        path: rest.join('\t'),
        added: added === '-' ? 0 : Number(added),
        removed: removed === '-' ? 0 : Number(removed),
      }
    })
}

/** Reads `git diff --numstat --no-renames base..head`, the whitespace check, and REVIEW.md at `configAt` (default `base`; `git show <rev>:REVIEW.md`, missing → defaults) */
export async function routeRange(input: {
  git: GitRunner
  repo: string
  base: string
  head: string
  min?: Tier
  classify?: Classifier
  configAt?: string
  threadDeep?: boolean
}): Promise<RouteDecision & { config: ReviewConfig; changes: FileChange[]; warning?: string }> {
  const { git, repo, base, head } = input
  const range = `${base}..${head}`
  const [numstat, ignoringWhitespace, reviewMd] = await Promise.all([
    git(repo, ['diff', '--numstat', '--no-renames', range]),
    git(repo, ['diff', '--numstat', '-M', '-w', '--ignore-blank-lines', range]),
    git(repo, ['show', `${input.configAt ?? base}:REVIEW.md`]).catch(() => null),
  ])
  const changes = parseNumstat(numstat)
  const { config, warning } = parseReviewMd(reviewMd)
  const decided = decide({
    changes,
    contentChanged: parseNumstat(ignoringWhitespace).some((f) => f.added + f.removed > 0),
    config,
    threadDeep: input.threadDeep,
  })
  const result = (decision: RouteDecision) => ({ ...raise(decision, input.min), config, changes, warning })

  if (decided.decidedBy !== 'default' || !input.classify) return result(decided)
  const { tier: _tier, seat: _seat, rule: _rule, decidedBy: _by, ...facts } = decided
  const answer = await input.classify({ changes, facts })
  if (!answer) return result(decided)
  return result({
    ...decided,
    tier: answer,
    seat: SEATS[answer],
    rule: `classifier: ${answer} (rules left it open)`,
    decidedBy: 'classifier',
  })
}
