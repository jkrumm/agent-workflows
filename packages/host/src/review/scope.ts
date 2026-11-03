// The `review` scope vocabulary and the ref alphabets a scope or branch must stay inside.

/** A leading `-` would read as a flag once a ref reaches `git`; the rest is git's ref alphabet. */
const SAFE_REF = /^[a-zA-Z0-9._/~^@{}-]+$/
const SAFE_BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/

/** The `review` scope vocabulary: `uncommitted`, `head`, a ref or range, or a file path. Throws a message, never a type. */
export function scopeProblem(scope: string): string | null {
  if (scope === 'uncommitted' || scope === 'head') return null
  const range = splitRange(scope)
  const halves = range ? [range.from, range.to] : [scope]
  if (halves.some((half) => half.startsWith('-'))) return `a ref must not start with '-': ${scope}`
  if (!SAFE_REF.test(scope)) return `scope contains unsafe characters: ${scope}`
  return null
}

export function branchProblem(branch: string): string | null {
  if (!branch) return 'branch must not be empty'
  if (branch.length > 200) return 'branch is longer than 200 characters'
  if (!SAFE_BRANCH.test(branch)) return `branch contains unsafe characters: ${branch}`
  if (branch.includes('..')) return `branch must not contain '..': ${branch}`
  return null
}

/** `a..b` / `a...b` into its halves (either may be empty, as git allows); null for anything that is not a range. */
export function splitRange(scope: string): { from: string; to: string } | null {
  const match = /^(.*?)\.\.\.?(.*)$/.exec(scope)
  if (!match) return null
  return { from: match[1] ?? '', to: match[2] ?? '' }
}
