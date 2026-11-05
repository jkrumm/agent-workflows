// What code can say about a finding's line without a model: does the line exist, and is it near the change?
// Data only: submit never drops or refuses a finding for it.
import { readFile, realpath, stat } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'

/** A finding is anchored when its line is at most this many lines from a changed line (new side). */
const ANCHOR_DISTANCE = 3

export interface Anchoring {
  /** The file exists in the worktree and has the line; null: unknown (the worktree was unreadable). */
  lineValid: boolean | null
  /** The line is within ANCHOR_DISTANCE of a changed line of the diff; null: unknown (the diff was unreadable). */
  anchored: boolean | null
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

interface HunkState {
  files: Map<string, number[]>
  /** The changed lines of the file being read; null for a deleted file or none yet. */
  current: number[] | null
  oldLeft: number
  newLeft: number
  newLine: number
}

/** One line of a hunk body: added lines count at their number, a deletion at the new-side line that follows it. */
function readBodyLine(state: HunkState, line: string): void {
  if (line.startsWith('\\')) return
  if (line.startsWith('+')) {
    state.newLeft--
    state.current?.push(state.newLine++)
    return
  }
  if (line.startsWith('-')) {
    state.oldLeft--
    state.current?.push(state.newLine)
    return
  }
  state.oldLeft--
  state.newLeft--
  state.newLine++
}

/** A `+++ ` header opens a file; `/dev/null` (a deleted file) has no new side. A `@@` header opens a hunk. */
function readHeaderLine(state: HunkState, line: string): void {
  if (line.startsWith('+++ ')) {
    const target = line.slice(4).split('\t')[0]!
    state.current = null
    if (!target.startsWith('b/')) return
    state.current = state.files.get(target.slice(2)) ?? []
    state.files.set(target.slice(2), state.current)
    return
  }
  const hunk = HUNK.exec(line)
  if (!hunk) return
  state.oldLeft = Number(hunk[2] ?? 1)
  state.newLeft = Number(hunk[4] ?? 1)
  const start = Number(hunk[3])
  state.newLine = state.newLeft === 0 ? start + 1 : start
}

/**
 * `git diff -M` → the changed lines of each file on the new side. An added line counts at its own number; a deletion
 * counts at the new-side line that follows it. Deleted files (`+++ /dev/null`) have no new side and are left out.
 */
export function changedLines(diff: string): Map<string, number[]> {
  const state: HunkState = { files: new Map(), current: null, oldLeft: 0, newLeft: 0, newLine: 0 }
  for (const line of diff.split('\n')) {
    if (state.oldLeft > 0 || state.newLeft > 0) readBodyLine(state, line)
    else readHeaderLine(state, line)
  }
  return state.files
}

export const nearChange = (changed: number[], line: number): boolean =>
  changed.some((c) => Math.abs(c - line) <= ANCHOR_DISTANCE)

/** Number of lines of a text (a last line without a newline counts; an empty file has none). */
export const countLines = (text: string): number => {
  if (text === '') return 0
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0)
}

type Lines = { count: number } | 'missing' | 'unknown'

/** The line count of `file` inside `worktree`; a path that leaves the worktree is `missing`. */
async function linesOf(worktree: string, file: string): Promise<Lines> {
  const full = resolve(worktree, file)
  if (!full.startsWith(`${resolve(worktree)}${sep}`)) return 'missing'
  try {
    if (!(await stat(worktree)).isDirectory()) return 'unknown'
  } catch {
    return 'unknown'
  }
  try {
    const real = await realpath(full)
    if (!real.startsWith(`${await realpath(worktree)}${sep}`)) return 'missing'
    return { count: countLines(await readFile(real, 'utf8')) }
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unknown'
  }
}

export const anchorKey = (finding: { file: string; line: number | null }): string =>
  `${finding.file}\0${finding.line ?? ''}`

/** Anchoring of each (file, line) of `findings`, keyed by `anchorKey`. A finding without a line is null on both. */
export async function anchorFindings(input: {
  worktree: string
  jobDir: string
  findings: { file: string; line: number | null }[]
}): Promise<Map<string, Anchoring>> {
  const diff = await readFile(join(input.jobDir, 'diff.patch'), 'utf8').then(
    (text) => changedLines(text),
    () => null,
  )
  const out = new Map<string, Anchoring>()
  for (const finding of input.findings) {
    const key = anchorKey(finding)
    if (out.has(key)) continue
    const { line } = finding
    if (line === null) {
      out.set(key, { lineValid: null, anchored: null })
      continue
    }
    const lines = await linesOf(input.worktree, finding.file)
    const changed = diff?.get(finding.file)
    out.set(key, {
      lineValid: lines === 'unknown' ? null : lines !== 'missing' && line <= lines.count,
      anchored: diff === null ? null : changed !== undefined && nearChange(changed, line),
    })
  }
  return out
}
