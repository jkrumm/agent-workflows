const FIX_SUBJECT = /^(?:(?:fix|revert)(?:\([^)]+\))?!?:|revert )/i
/** Dependency bumps, CI, docs, releases and formatting churn name themselves in the scope or the subject. */
const NOT_A_BUG_FIX = /\b(?:deps|ci|docs?|release|style|lint(?:ing|er)?|typos?|format(?:ting)?|fmt)\b/i
const CONVENTIONAL = /^(\w+)(?:\([^)]*\))?!?:/
const MASS_REFORMAT_SUBJECT = /^(?:style|chore)(?:\([^)]*\))?: .*(?:format|fmt|prettier|oxfmt|biome|lint)/i

/** A `fix`, `revert` or `Revert ` subject, before the exclusions. */
export const isFixSubject = (subject: string) => FIX_SUBJECT.test(subject)

/** A fix subject that is a bug fix candidate: `fix(deps):`, `fix: typo …` and `fix(lint):` are not. */
export const isBugFixSubject = (subject: string) => isFixSubject(subject) && !NOT_A_BUG_FIX.test(subject)

export const isReformatSubject = (subject: string) => MASS_REFORMAT_SUBJECT.test(subject)

/** The conventional-commit type of a subject, lower-case, or null. */
export const subjectType = (subject: string) => CONVENTIONAL.exec(subject)?.[1]?.toLowerCase() ?? null

const WEAK_TYPES = new Set(['docs', 'test', 'tests', 'refactor', 'chore'])
export const isWeakSubject = (subject: string) => WEAK_TYPES.has(subjectType(subject) ?? '')

const NON_CODE_EXT = /\.(?:md|mdx|txt|snap|svg|lock|lockb|tsbuildinfo)$/i
const LOCKISH_NAMES = new Set([
  'package-lock.json',
  'npm-shrinkwrap.json',
  'bun.lock',
  'bun.lockb',
  'yarn.lock',
  'pnpm-lock.yaml',
  'cargo.lock',
  'uv.lock',
  'poetry.lock',
  'go.sum',
  'gemfile.lock',
  'composer.lock',
  'flake.lock',
])
const GENERATED_JSON = /(?:-lock|\.lock|\.generated|\.gen|\.min)\.json$/i

/** Code worth blaming: not prose, lockfiles, snapshots, generated JSON, images or anything under `docs/`. */
export function isCodeFile(path: string): boolean {
  const parts = path.split('/')
  const name = (parts.at(-1) ?? '').toLowerCase()
  if (parts.slice(0, -1).includes('docs')) return false
  if (LOCKISH_NAMES.has(name) || NON_CODE_EXT.test(name) || GENERATED_JSON.test(name)) return false
  return true
}
