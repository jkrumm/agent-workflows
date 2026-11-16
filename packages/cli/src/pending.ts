/**
 * What a pending answer tells the caller to do next: one resume command whose budget is sized from the workflow's own
 * p95 wall time (`typicalWallS`, read by the host from its journal), so a long run is one wait and not a chain.
 *
 * The host tool a caller runs `agw` from ends a foreground call at 600 s (Claude Code's Bash tool), so a printed budget
 * never exceeds {@link FOREGROUND_CAP_S}; a run typically longer than that is waited in the background instead.
 */
export const FOREGROUND_CAP_S = 540
/** A run with no history, or one that is typically quick, still gets a wait that is worth a call. */
const MIN_BUDGET_S = 60
const UNKNOWN_BUDGET_S = 300
/** The p95 is a typical long run: a margin so a slightly slower one still ends inside the wait. */
const MARGIN = 1.25

export interface Advice {
  /** Seconds the printed resume command waits. */
  budgetS: number
  /** The whole wait the run is expected to need, when it is longer than a foreground call can hold. */
  needsS?: number
  /** The sentence a caller reads: what to run once, and not to loop. */
  message: string
}

const minutes = (s: number) => (s >= 120 ? `${Math.round(s / 60)} min` : `${Math.round(s)}s`)

export function adviceFor(options: { typicalWallS?: number; waitedS: number; interrupted?: string }): Advice {
  const { typicalWallS, waitedS, interrupted } = options
  const want =
    typicalWallS !== undefined && typicalWallS > 0
      ? Math.max(MIN_BUDGET_S, Math.ceil(typicalWallS * MARGIN))
      : UNKNOWN_BUDGET_S
  const budgetS = Math.min(want, FOREGROUND_CAP_S)
  const why = interrupted ? `interrupted by ${interrupted}` : `after ${waitedS}s`
  const typical = typicalWallS !== undefined && typicalWallS > 0 ? `; typically ~${minutes(typicalWallS)}` : ''
  const background =
    want > FOREGROUND_CAP_S
      ? ` It needs more than ${FOREGROUND_CAP_S}s: run the command in the background (a foreground call ends at 600s) with --budget ${want}.`
      : ''
  return {
    budgetS,
    ...(want > FOREGROUND_CAP_S ? { needsS: want } : {}),
    message: `still running ${why}${typical}. Do not loop: run the hint once.${background}`,
  }
}
