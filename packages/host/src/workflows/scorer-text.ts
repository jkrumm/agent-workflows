// Text helpers the deterministic eval scorers share: a reference names facts as strings, the scorer asks whether the text holds them.

export const lower = (s: string) => s.toLowerCase()

export const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** A term as a whole token: `7` is in "7 waves" and not in "17 waves"; `a|b` accepts either alternative. */
export const mentions = (text: string, term: string) =>
  term
    .split('|')
    .some((alt) =>
      new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(lower(alt))}(?![\\p{L}\\p{N}])`, 'u').test(lower(text)),
    )
