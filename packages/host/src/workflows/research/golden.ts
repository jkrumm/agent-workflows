import { z } from 'zod'

/**
 * The golden set's expectation, ported from research-gateway `evals/lib.ts` with the same semantics: `any` passes when
 * one pattern matches, `all` when every pattern does, `live` when the report contains the value a registry answers at
 * scoring time (a literal, case-insensitive substring, never a regex). Patterns are case-insensitive.
 */
export const GoldenExpect = z.union([
  z.object({ any: z.array(z.string()).min(1) }).strict(),
  z.object({ all: z.array(z.string()).min(1) }).strict(),
  z.object({ live: z.string().min(1) }).strict(),
])
export type GoldenExpect = z.output<typeof GoldenExpect>

export type MatchResult = { pass: boolean; matched: string | null }

export function matchExpect(text: string, expect: GoldenExpect, liveValue: string | null): MatchResult {
  if ('live' in expect) {
    if (liveValue === null) return { pass: false, matched: null }
    const pass = text.toLowerCase().includes(liveValue.toLowerCase())
    return { pass, matched: pass ? liveValue : null }
  }
  if ('all' in expect) {
    const matches: string[] = []
    for (const pattern of expect.all) {
      const match = text.match(new RegExp(pattern, 'i'))
      if (!match) return { pass: false, matched: null }
      matches.push(match[0])
    }
    return { pass: true, matched: matches.join(' + ') }
  }
  for (const pattern of expect.any) {
    const match = text.match(new RegExp(pattern, 'i'))
    if (match) return { pass: true, matched: match[0] }
  }
  return { pass: false, matched: null }
}

/** No cap means the report always fits. */
export const withinMaxChars = (report: string, maxChars: number | undefined) =>
  maxChars === undefined || report.length <= maxChars

export const REGISTRIES = ['npm', 'pypi', 'crates', 'github-release'] as const
export type Registry = (typeof REGISTRIES)[number]

/** `npm:ai` → the `web.package` input; anything else is a broken case, not a miss. */
export function liveTarget(spec: string): { registry: Registry; name: string } {
  const sep = spec.indexOf(':')
  const scheme = spec.slice(0, sep)
  const name = spec.slice(sep + 1)
  if (sep <= 0 || !name || !(REGISTRIES as readonly string[]).includes(scheme)) {
    throw new Error(`invalid live resolver "${spec}": expected <${REGISTRIES.join('|')}>:<target>`)
  }
  return { registry: scheme as Registry, name }
}

/** The bare version a report writes: a GitHub release tag loses its `v` / `bun-v` prefix, as `evals/lib.ts` does. */
export function liveValue(registry: Registry, latest: string): string {
  return registry === 'github-release' ? latest.replace(/^(?:bun-)?v/i, '') : latest
}
