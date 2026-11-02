import type { Attribution } from '@agent-workflows/runtime'

/** A step's attribution as the runtime hands it to `open` and `followUp`. */
export const attributionOf = (runId: string, step: string): Attribution => ({
  runId,
  rootId: `root-of-${runId}`,
  workflow: 'test-workflow',
  step,
  purpose: 'verify',
  project: 'agent-workflows',
  workspace: 'private',
  traceparent: '00-11111111111111111111111111111111-2222222222222222-01',
})
