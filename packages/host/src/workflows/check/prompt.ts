import { DEFAULT_AGENT_IDLE_MS } from '@agent-workflows/runtime'

/** The margin above the largest step window: the tool-use turn that launches a step and the one that reports it. */
const SESSION_MARGIN_S = 120

/**
 * The agent step's idle window. A shell call writes nothing to the session while it runs, so the host's idle timer
 * must outlast the largest step window the agent was told about, or it kills the session first. Never below the
 * runtime's default. `slotWaitMs` is the longest wait for a factory test slot (`slot.ts`), which writes nothing either.
 */
export function agentIdleMs(stepSeconds: number, testSeconds: number, slotWaitMs = 0): number {
  return Math.max(DEFAULT_AGENT_IDLE_MS, (Math.max(stepSeconds, testSeconds) + SESSION_MARGIN_S) * 1000 + slotWaitMs)
}

/** Appended to the prompt of the one retry after a turn that ended without a valid `submit_result` call. */
export const SUBMIT_RESULT_RETRY = `

────────────────────────────────────────────────────────
RETRY: your previous attempt was REJECTED because it ended without a valid \`submit_result\` call.
Run the steps, then call \`submit_result\` once with the report in the Output section's shape. A report written as
text is not read. Then stop.`

/**
 * The per-run request. The stable rules are the agent's `AGENTS.md` (the cacheable prefix); this carries only what
 * differs per run, so the session's first tokens are the same for every run of the agent.
 */
export function agentPrompt(options: {
  cwd: string
  commands?: string[]
  stepSeconds: number
  testSeconds: number
  idleMs: number
}): string {
  const { cwd, commands, stepSeconds, testSeconds, idleMs } = options
  const mode =
    commands && commands.length > 0
      ? `Mode: COMMANDS. Run exactly these, in order:\n${commands.map((command, i) => `${i + 1}. \`${command}\``).join('\n')}`
      : 'Mode: DISCOVER.'
  return [
    `Working directory: ${cwd}`,
    `Step idle windows (run-step's second argument): ${stepSeconds}s for ordinary steps, ${testSeconds}s for the test step.`,
    `Session idle window: the host kills the session after ${Math.round(idleMs / 1000)}s without any output.`,
    mode,
  ].join('\n')
}
