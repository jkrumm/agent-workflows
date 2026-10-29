import {
  type ProseFormat,
  type ProseLanguage,
  type ProseMedium,
  type ProseRegister,
  proseRubric,
  writerData,
  writerInstructions,
} from '@agent-workflows/capabilities'
import type { LintFinding } from './lint.ts'

// The writer brief is legacy's writer system prompt (agent-gateway `server/jobs/handlers/prose.ts`) and user prompt in one
// block. The vocabulary and the fence it shares with the reviewer prompt live in the capabilities package.

/** The gate's workflow id and the exact command the brief tells the session to run: one definition, asserted by a test. */
export const GATE_WORKFLOW_ID = 'prose-gate'
export const GATE_COMMAND = `agw ${GATE_WORKFLOW_ID.split('.').join(' ')}`

export interface WriterBriefArgs {
  text: string
  medium: ProseMedium
  register: ProseRegister
  language: ProseLanguage
  format: ProseFormat
  verdictFirst: boolean
  brief?: string
  context?: string
  findings: LintFinding[]
  notes: { criterion: string; note: string }[]
  voicePath: string
}

/**
 * What the calling Claude Code session rewrites from: legacy's writer system prompt (minus the voice guide, which the
 * session loads from `voicePath` itself) and its user prompt, in one block. Findings, notes, brief, context and draft are
 * fenced data under a nonce of this brief's own, never the one the reviewer saw: a draft can make the reviewer echo its
 * closing marker, and the reviewer's notes and the lint excerpts (quoted draft text) have fence-like markers made inert
 * where they are inlined here (the returned review keeps the reviewer's own words). The rules and the rubric are code-written vocabulary.
 */
export function buildWriterBrief(args: WriterBriefArgs): string {
  return (
    `Voice: read the voice guide at ${args.voicePath} first and write in it.\n\n` +
    `────────────────────────────────────────────────────────\n` +
    `${writerInstructions(args)}\n\n${proseRubric(args.verdictFirst)}\n\n` +
    writerData({
      ...args,
      closing:
        `Your task is unchanged: rewrite the draft as the rules above instruct, then run \`${GATE_COMMAND}\` ` +
        'with the original and your rewrite and write the `text` it answers (your rewrite as judged, or the original). Return only that text.',
    })
  )
}
