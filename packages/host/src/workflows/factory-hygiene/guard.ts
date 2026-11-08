import { realpathSync, statSync } from 'node:fs'
import { isAbsolute, join, relative } from 'node:path'
import type { FactoryHygieneOutputValue, HygieneInput } from './schema.ts'

/** True when `path` (relative to `root`) is an existing regular file whose real path stays below the real `root`. */
export function isFileUnder(root: string, path: string): boolean {
  if (isAbsolute(path)) return false
  try {
    const base = realpathSync(root)
    const real = realpathSync(join(base, path))
    const inside = relative(base, real)
    if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) return false
    return statSync(real).isFile()
  } catch {
    return false
  }
}

/**
 * The code-side guard, applied by the workflow after the step so a replayed result is held to it too. A finding is dropped
 * when its path is not a candidate of its own kind, when the file does not exist below `cwd` (a `../` path, an absolute path
 * and a link out of the checkout included), or when it repeats a kind and path (the first stays). The rest is cut to `max`.
 * It drops and never rewrites: what stays is the agent's finding as it was.
 */
export function guardHygiene(answer: FactoryHygieneOutputValue, input: HygieneInput): FactoryHygieneOutputValue {
  const candidates = {
    stale: new Set(input.stale.map((c) => c.path)),
    slop: new Set(input.slop.map((c) => c.path)),
  }
  const seen = new Set<string>()
  const findings: FactoryHygieneOutputValue['findings'] = []
  for (const finding of answer.findings) {
    const key = `${finding.kind}\u0000${finding.path}`
    if (!candidates[finding.kind].has(finding.path)) continue
    if (seen.has(key)) continue
    if (!isFileUnder(input.cwd, finding.path)) continue
    seen.add(key)
    findings.push(finding)
  }
  return { ...answer, findings: findings.slice(0, input.max) }
}
