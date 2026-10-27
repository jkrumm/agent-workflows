import { AdmissionRefused, type Middleware } from '@agent-workflows/runtime'

/** Every run says why it exists (`build`, `prod`, `eval`, …). The runtime persists it; a blank one is a bug. */
export function hasPurpose(purpose: unknown): purpose is string {
  return typeof purpose === 'string' && purpose.trim() !== ''
}

export function purposeMiddleware(): Middleware {
  return {
    name: 'purpose',
    runPre: ({ purpose, runId }) => {
      if (!hasPurpose(purpose)) throw new AdmissionRefused(`run ${runId}: a run without a purpose cannot exist`)
    },
  }
}
