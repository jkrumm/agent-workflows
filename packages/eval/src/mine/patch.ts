import { isCodeFile } from './subjects.ts'

/** The pre-image lines (1-based, inclusive runs) of one file that a fix removed or changed. */
export interface RemovedRanges {
  /** The path at the fix's parent (the name to blame under). */
  file: string
  ranges: { start: number; end: number }[]
}

export interface PatchLines {
  files: RemovedRanges[]
  /** Removed or changed lines before any filter. */
  removed: number
  /** Dropped as cosmetic (blank, whitespace-only change, comment-only) or because the file is not code. */
  cosmetic: number
}

const COMMENT_ONLY = /^(?:\/\/|#|\/\*|\*(?:\s|\/|$)|<!--)/
const HUNK = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/

const squash = (text: string) => text.replace(/\s+/g, '')

/** Blank lines and lines that are only a comment (`//`, `#`, block-comment lines, `<!-- -->`). */
export function isCosmeticLine(line: string): boolean {
  const text = line.trim()
  return text === '' || COMMENT_ONLY.test(text)
}

/**
 * The removed and changed lines of a `git show -U0` patch. An additions-only hunk yields nothing (a stated recall
 * bias). A line is cosmetic when it is blank, comment-only, or its hunk only re-spaces the code (the removed and
 * added text are equal once whitespace is gone).
 */
export function removedLines(patch: string): PatchLines {
  const files: RemovedRanges[] = []
  let removed = 0
  let cosmetic = 0
  let oldPath: string | null = null
  let codeFile = false
  let kept: number[] = []

  const closeFile = () => {
    if (oldPath && kept.length) files.push({ file: oldPath, ranges: toRanges(kept) })
    kept = []
  }
  const lines = patch.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string
    if (line.startsWith('diff --git ')) {
      closeFile()
      oldPath = null
      continue
    }
    if (line.startsWith('--- ')) {
      const path = line.slice(4).replace(/\t.*$/, '')
      oldPath = path === '/dev/null' ? null : path.replace(/^a\//, '')
      codeFile = oldPath !== null && isCodeFile(oldPath)
      continue
    }
    const hunk = HUNK.exec(line)
    if (!hunk) continue
    const start = Number(hunk[1])
    const count = hunk[2] === undefined ? 1 : Number(hunk[2])
    const old: string[] = []
    const added: string[] = []
    for (i++; i < lines.length; i++) {
      const body = lines[i] as string
      if (body.startsWith('-')) old.push(body.slice(1))
      else if (body.startsWith('+')) added.push(body.slice(1))
      else if (!body.startsWith('\\')) break
    }
    i--
    if (count === 0 || oldPath === null) continue
    removed += old.length
    if (!codeFile) {
      cosmetic += old.length
      continue
    }
    const respaced = squash(old.join('\n')) === squash(added.join('\n'))
    old.forEach((text, offset) => {
      if (respaced || isCosmeticLine(text)) cosmetic++
      else kept.push(start + offset)
    })
  }
  closeFile()
  return { files, removed, cosmetic }
}

function toRanges(sorted: number[]): { start: number; end: number }[] {
  const ranges: { start: number; end: number }[] = []
  for (const line of sorted) {
    const last = ranges.at(-1)
    if (last && line === last.end + 1) last.end = line
    else ranges.push({ start: line, end: line })
  }
  return ranges
}
