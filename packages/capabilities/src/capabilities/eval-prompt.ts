import { createHash } from 'node:crypto'
import { resolveRoute, type RouteId } from '@agent-workflows/routes'
import type { z } from 'zod'
import { toJsonSchema } from '../transports/json-schema.ts'
import { dataBlock } from './data-block.ts'

/** What one diff may cost the prompt; the rest is cut and the prompt says how much. */
export const EVAL_DIFF_CHARS = 60_000

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/
const LINE_NO_WIDTH = 5

/**
 * The diff with every hunk line numbered, because models miscount from hunk headers and the ground truth accepts a
 * location only within a few lines of the other labeller's. A `+` or context line carries its new-side (post-image) line
 * number, a `-` line its old-side number: `   42 + code`, `   41   code`, `   37 - code`. File headers, hunk headers and
 * `\ No newline` markers pass through unchanged. Hunk lengths from the headers say where a hunk ends, so a removed line
 * that reads `-- a/x` is a line, not a file header.
 */
export function numberDiff(diff: string): string {
  let oldLeft = 0
  let newLeft = 0
  let oldNo = 0
  let newNo = 0
  const row = (no: number, sign: string, text: string) => `${String(no).padStart(LINE_NO_WIDTH)} ${sign} ${text}`
  return diff
    .split('\n')
    .map((line) => {
      const hunk = HUNK.exec(line)
      if (hunk) {
        oldNo = Number(hunk[1])
        oldLeft = hunk[2] === undefined ? 1 : Number(hunk[2])
        newNo = Number(hunk[3])
        newLeft = hunk[4] === undefined ? 1 : Number(hunk[4])
        return line
      }
      if (oldLeft === 0 && newLeft === 0) return line
      const sign = line[0] ?? ' '
      if (sign === '+' && newLeft > 0) {
        newLeft--
        return row(newNo++, '+', line.slice(1))
      }
      if (sign === '-' && oldLeft > 0) {
        oldLeft--
        return row(oldNo++, '-', line.slice(1))
      }
      if (sign === ' ' && oldLeft > 0 && newLeft > 0) {
        oldLeft--
        oldNo++
        newLeft--
        return row(newNo++, ' ', line.slice(1))
      }
      return line
    })
    .join('\n')
}

/**
 * The diff up to `EVAL_DIFF_CHARS`: whole file sections from the top, in order, stopping at the first that does not fit
 * (a later small file never jumps the queue). A first section that alone exceeds the cap is cut mid-file.
 */
export function cutDiff(diff: string): { text: string; notice: string } {
  if (diff.length <= EVAL_DIFF_CHARS) return { text: diff, notice: '' }
  const sections = diff.split(/(?=^diff --git )/m)
  let text = ''
  let kept = 0
  for (const section of sections) {
    if (text.length + section.length > EVAL_DIFF_CHARS) break
    text += section
    kept++
  }
  if (kept === 0) text = diff.slice(0, EVAL_DIFF_CHARS)
  const where = kept === 0 ? 'the first file is cut mid-way' : `${kept} of ${sections.length} file sections kept whole`
  return { text, notice: `[diff cut: ${diff.length - text.length} of ${diff.length} characters omitted, ${where}]` }
}

/** A diff as the prompt carries it: numbered, then cut (so the numbers survive a cut), fenced as data. */
export const diffBlock = (label: string, diff: string) => {
  const cut = cutDiff(numberDiff(diff))
  return dataBlock(label, cut.text) + (cut.notice ? `${cut.notice}\n` : '')
}

/** A template with its `{{name}}` placeholders replaced; a placeholder without a value is a bug in the prompt, not an empty string. */
export function fill(template: string, values: Record<string, string>): string {
  // A function replacer: `$&` and friends in a diff are literal text.
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    const value = values[key]
    if (value === undefined) throw new Error(`prompt template has no value for {{${key}}}`)
    return value
  })
}

/**
 * A diff made to exercise every rule of `numberDiff` and `cutDiff`: a renamed file with two hunks, a removal and a
 * no-newline marker, then a file of `EVAL_DIFF_CHARS` filler that does not fit, so the cap and the cut notice are part of
 * what a version hashes.
 */
export function fixtureDiff(): string {
  return [
    'diff --git a/src/old.ts b/src/new.ts',
    'similarity index 80%',
    'rename from src/old.ts',
    'rename to src/new.ts',
    '--- a/src/old.ts',
    '+++ b/src/new.ts',
    '@@ -3,4 +3,5 @@ export function f() {',
    ' keep',
    '-gone',
    '+one',
    '+two',
    ' tail',
    '@@ -20,2 +21,2 @@',
    ' ctx',
    '-before',
    '+after',
    '\\ No newline at end of file',
    'diff --git a/src/big.ts b/src/big.ts',
    '--- /dev/null',
    '+++ b/src/big.ts',
    '@@ -0,0 +1 @@',
    `+${'x'.repeat(EVAL_DIFF_CHARS)}`,
    '',
  ].join('\n')
}

/**
 * `<prefix>-<12 hex>`: a sha256 over everything that decides what a capability asks and who answers: the system text,
 * the rendered fixture prompts (so the template, the task strings, the rendering, `numberDiff`, `cutDiff` and
 * `EVAL_DIFF_CHARS` all count), each seat's resolved route (wire, model, effort, output ceiling) and the answer schemas
 * as the wire gets them. A capability records this value as a constant and its test recomputes it, so a change to any of
 * it without a new constant fails.
 */
export function pinnedVersion(
  prefix: string,
  parts: { system: string; prompts: string[]; routes: readonly RouteId[]; schemas: z.ZodType[] },
) {
  const seats = parts.routes.map((id) => {
    const { wire, model, effort, maxOutputTokens } = resolveRoute(id)
    return { id, wire, model, effort, maxOutputTokens }
  })
  const schemas = parts.schemas.map((schema) => toJsonSchema(schema))
  const hash = createHash('sha256')
    .update(JSON.stringify([parts.system, parts.prompts, seats, schemas]))
    .digest('hex')
  return `${prefix}-${hash.slice(0, 12)}`
}
