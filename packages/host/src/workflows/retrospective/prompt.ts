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

/** `tools 12 (search ×5 (2 failed), fetch ×7 (3 repeated))`; just the count for a step that leaves no record of its tools. */
function renderTools(step: SampledRun['steps'][number]): string {
  if (step.tools.length === 0) return `tools ${step.toolCalls}`
  const named = step.tools.map((t) => {
    const trouble = [t.failed > 0 ? `${t.failed} failed` : '', t.repeats > 0 ? `${t.repeats} repeated` : '']
      .filter(Boolean)
      .join(', ')
    return `${t.tool} ×${t.calls}${trouble ? ` (${trouble})` : ''}`
  })
  return `tools ${step.toolCalls} (${named.join(', ')})`
}

function renderRun(run: SampledRun, previewChars: number): string {
  const lines = [
    `### run ${run.runId} — ${run.status}${run.errorKind ? ` (${run.errorKind})` : ''}`,
    `fingerprint ${run.fingerprint?.slice(0, 12) ?? 'unknown'}, wall ${run.wallMs ?? '?'} ms, cost ${run.cost ?? '?'}, tool calls ${run.toolCalls ?? '?'}`,
  ]
  if (run.friction) lines.push(`friction: ${JSON.stringify(run.friction)}`)
  if (run.error) lines.push(`error: ${scrub(run.error, ERROR_CHARS)}`)
  for (const step of run.steps) {
    const head = `- ${step.stepId} [${step.kind}, ${step.status}${step.model ? `, ${step.model}` : ''}] ${renderTools(step)}`
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

export const SUBMIT_RESULT_RETRY =
  '\n\nYour previous answer ended without a valid `submit_result` call. Answer again by calling `submit_result` once with the object described above; text is not read.'

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
    'A step lists its tools by name (and how often one failed or repeated an earlier call with the same arguments) only where the host recorded them; any other step shows just a count.',
    'Cite only run ids that appear below. Do not write absolute paths, URLs, host names or repository names anywhere in your answer.',
    '',
    renderSample(runs),
  ].join('\n')
}
