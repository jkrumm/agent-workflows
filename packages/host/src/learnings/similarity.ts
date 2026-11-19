// Two phrasings of one observation are one learned fact. The retrospective is a model: it rewords what it saw last week,
// so an exact-text key never matches twice. The comparison is on content words only (lower case, no stop words, a crude
// plural/tense stem), and counts two facts as the same when they share enough of them: measured on the first 37 proposed
// facts, these thresholds join the restatements and keep unrelated facts of one agent apart.

const STOP_WORDS = new Set(
  `a an and are as at be been by for from has have in is it its of on or that the then there these this those to was were
  when which with without while than so not no but also can may only more most some such into over under per each other
  both same after before about between does did do any all one two`.split(/\s+/),
)

/** The comparable words of a fact: lower case, letters and digits, at least three characters, stop words out, stemmed. */
function contentWords(fact: string): Set<string> {
  const words = fact
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 2 && !STOP_WORDS.has(word))
    .map((word) => word.replace(/(ing|ed|es|s)$/, ''))
  return new Set(words)
}

const MIN_SHARED_WORDS = 3
/** Shared words over all words of both facts. */
const MIN_JACCARD = 0.22
/** Shared words over the shorter fact: a short restatement of a long fact still matches. */
const MIN_OVERLAP = 0.4

/** Whether two facts say the same thing. Symmetric; a fact is similar to itself. */
export function similarFacts(a: string, b: string): boolean {
  if (a === b) return true
  const left = contentWords(a)
  const right = contentWords(b)
  let shared = 0
  for (const word of left) if (right.has(word)) shared++
  if (shared < MIN_SHARED_WORDS) return false
  const union = left.size + right.size - shared
  return shared / union >= MIN_JACCARD && shared / Math.min(left.size, right.size) >= MIN_OVERLAP
}
