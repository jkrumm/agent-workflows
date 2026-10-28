import { scrubForPrompt } from './scrub.ts'
import type { SampledRun } from './sample.ts'

/** The prompt data stays under this many characters (about 30k tokens): older detail is cut before the sample is. */
const MAX_DATA_CHARS = 120_000
const PREVIEW_STEPS = [600, 300, 120, 0] as const
const ERROR_CHARS = 400

const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text)

/** Absolute paths and credential-shaped tokens out of the data before the agent sees it. */
function scrub(text: string | null, max: number): string | null {
  return text === null ? null : cut(scrubForPrompt(text), max)
}

function renderRun(run: SampledRun, previewChars: number): string {
  const lines = [
    `### run ${run.runId} — ${run.status}${run.errorKind ? ` (${run.errorKind})` : ''}`,
    `fingerprint ${run.fingerprint?.slice(0, 12) ?? 'unknown'}, wall ${run.wallMs ?? '?'} ms, cost ${run.cost ?? '?'}, tool calls ${run.toolCalls ?? '?'}`,
  ]
  if (run.friction) lines.push(`friction: ${JSON.stringify(run.friction)}`)
  if (run.error) lines.push(`error: ${scrub(run.error, ERROR_CHARS)}`)
  for (const step of run.steps) {
    const head = `- ${step.stepId} [${step.kind}, ${step.status}${step.model ? `, ${step.model}` : ''}] tools ${step.toolCalls}`
    const error = step.error ? ` error(${step.errorKind ?? '?'}): ${scrub(step.error, ERROR_CHARS)}` : ''
    const output = previewChars > 0 && step.output ? ` output: ${scrub(step.output, previewChars)}` : ''
    lines.push(`${head}${error}${output}`)
  }
  return lines.join('\n')
}

/** The sampled runs as text, with step outputs shortened step by step until the whole fits. */
export function renderSample(runs: SampledRun[], maxChars = MAX_DATA_CHARS): string {
  let text = ''
  for (const previewChars of PREVIEW_STEPS) {
    text = runs.map((run) => renderRun(run, previewChars)).join('\n\n')
    if (text.length <= maxChars) return text
  }
  return cut(text, maxChars)
}

export const JSON_ONLY_RETRY =
  '\n\nYour previous answer was not the JSON object described above. Answer again with only that object: no prose, no code fence.'

/** The task message. The role, criteria and output contract live in the agent's `AGENTS.md`; this carries the data. */
export function retroPrompt(args: {
  workflow: string
  windowDays: number
  agents: readonly string[]
  runs: SampledRun[]
}): string {
  const { workflow, windowDays, agents, runs } = args
  return [
    `Workflow: ${workflow}. Window: the last ${windowDays} days. ${runs.length} finished runs sampled (failed runs first).`,
    `Agents this workflow runs (the only valid values for a learning's "agent", and valid proposal targets): ${agents.join(', ')}.`,
    'Cite only run ids that appear below. Do not write absolute paths, URLs, host names or repository names anywhere in your answer.',
    '',
    renderSample(runs),
  ].join('\n')
}
