import { createCapabilityWorkflows } from '../../capability-runs.ts'

/**
 * The workflow versions of `cap.eval.judge` runs made before judge `b` existed. The journal records a hash of the
 * capability's definition per run (schemas, summary, handler source), and adding the `seat` input changed it, yet judge
 * `a` asks exactly what it asked: `JUDGE_VERSION` (prompt, schema, route) is unchanged, pinned by a test. These runs
 * are the stored judge-`a` calls the calibration re-asks judge `b` on.
 */
export const LEGACY_JUDGE_RUN_VERSIONS = ['8e1f56d6a647'] as const

/**
 * The versions a `cap.eval.judge` run may carry to count as judge `a`'s: the one this build would record, and the
 * legacy ones. Any other (a handler edit that is not known to leave judge `a` alone) is skipped by the calibration.
 */
export function judgeRunVersions(registry: Parameters<typeof createCapabilityWorkflows>[0]): readonly string[] {
  const current = createCapabilityWorkflows(registry).get('eval.judge')?.version
  return current ? [current, ...LEGACY_JUDGE_RUN_VERSIONS] : LEGACY_JUDGE_RUN_VERSIONS
}
