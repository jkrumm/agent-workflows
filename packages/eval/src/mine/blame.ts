import type { Git } from './git.ts'
import type { RemovedRanges } from './patch.ts'

/** One blamed line: the commit that introduced it and where the line sat in that commit's file. */
export interface BlamedLine {
  sha: string
  /** The path in the introducing commit (`-M -C` follows moves and copies). */
  file: string
  /** The line in the introducing commit's post-image. */
  line: number
}

const HEADER = /^([0-9a-f]{40}) (\d+) \d+(?: \d+)?$/
/** Ranges per `git blame` call: stays far below the argument-length limit. */
const RANGES_PER_CALL = 100

/** The lines of a `git blame --porcelain` output; the extended info appears once per commit. */
export function parseBlame(porcelain: string): BlamedLine[] {
  const files = new Map<string, string>()
  const lines: BlamedLine[] = []
  let current: { sha: string; orig: number } | null = null
  for (const text of porcelain.split('\n')) {
    const header = HEADER.exec(text)
    if (header) {
      current = { sha: header[1] as string, orig: Number(header[2]) }
      continue
    }
    if (text.startsWith('filename ') && current) {
      files.set(current.sha, text.slice('filename '.length))
      continue
    }
    if (text.startsWith('\t') && current) {
      lines.push({ sha: current.sha, file: files.get(current.sha) ?? '', line: current.orig })
      current = null
    }
  }
  return lines
}

/**
 * `git blame -w -M -C` of the removed ranges of one file at the fix's parent, the ignore-revs file looked past. A
 * range batch that cannot be blamed (the file is gone or binary) is counted in `failed` and yields nothing.
 */
export async function blameRanges(
  git: Git,
  options: { parent: string; removed: RemovedRanges; ignoreRevsFile: string | null },
): Promise<{ lines: BlamedLine[]; failed: number }> {
  const { parent, removed, ignoreRevsFile } = options
  const lines: BlamedLine[] = []
  let failed = 0
  for (let i = 0; i < removed.ranges.length; i += RANGES_PER_CALL) {
    const ranges = removed.ranges.slice(i, i + RANGES_PER_CALL)
    try {
      const out = await git([
        'blame',
        '-w',
        '-M',
        '-C',
        '--porcelain',
        ...(ignoreRevsFile ? ['--ignore-revs-file', ignoreRevsFile] : []),
        ...ranges.flatMap((r) => ['-L', `${r.start},${r.end}`]),
        parent,
        '--',
        removed.file,
      ])
      lines.push(...parseBlame(out))
    } catch {
      failed++
    }
  }
  return { lines, failed }
}
