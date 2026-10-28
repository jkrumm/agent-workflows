import type { Depth, Design } from './schema.ts'

/** How much work a depth asks for: research-gateway's depth profiles (`src/agent/depth.ts`), as one directive each. */
const EFFORT: Record<Depth, string> = {
  quick:
    'QUICK: answer directly and precisely. One focused search, read the most relevant page if the snippets are not enough, then answer.',
  standard:
    'STANDARD: search, then read the 2-3 most relevant pages. Cross-verify the answer across at least 2 independent sources.',
  deep: 'DEEP: survey the question. Search from several angles, read the primary sources, cross-verify every key claim across independent sources, and name what stays uncertain.',
}

/** research-gateway's synthesis length targets (`src/agent/prompt.ts`). */
const LENGTH: Record<Depth, string> = {
  quick: 'Length target: under about 3,000 characters.',
  standard: 'Length target: about 10,000 characters; do not exceed 14,000.',
  deep: 'Length target: about 20,000 characters; do not exceed 30,000.',
}

/** Sub-questions the pilot hands to the engine: the engine's own worker counts per depth (1, 4, 8), as a range. */
const SUB_QUESTIONS: Record<Depth, string> = {
  quick: 'one sub-question (the question itself, sharpened)',
  standard: '2 to 4 sub-questions',
  deep: '4 to 8 sub-questions',
}

export function researchTask(input: {
  query: string
  depth: Depth
  context?: string
  design: Exclude<Design, 'engine'>
}) {
  const lines = [`## Question\n\n${input.query.trim()}`, `## Depth\n\n${EFFORT[input.depth]} ${LENGTH[input.depth]}`]
  if (input.design === 'pilot')
    lines.push(`## Plan\n\nResearch it as ${SUB_QUESTIONS[input.depth]} through \`engine_research\`.`)
  if (input.context) lines.push(`## Given background\n\n${input.context.trim()}`)
  lines.push('Answer with the JSON object only.')
  return lines.join('\n\n')
}

export const JSON_ONLY_REASK =
  'Your last answer was not the JSON object the instructions ask for. Answer again with ONLY that JSON object ' +
  '({"report", "citations", "sources", "unverified"}), no prose and no code fence around it.'
