import { JUDGE_VERSION } from '@agent-workflows/capabilities'
import { createCapabilityWorkflows } from '../../capability-runs.ts'

/**
 * The workflow versions of `cap.eval.judge` runs made before judge `b` existed, by the `JUDGE_VERSION` they are known to
 * ask under. The journal records a hash of the capability's definition per run (schemas, summary, handler source), and
 * adding the `seat` input changed it, yet judge `a` asks exactly what it asked: its prompt, schema and route are
 * `JUDGE_VERSION`, pinned by a test. A hash counts only while the current `JUDGE_VERSION` is the one it was made under,
 * so a judge change cuts these runs off.
 */
export const LEGACY_JUDGE_RUN_VERSIONS: Readonly<Record<string, readonly string[]>> = {
  'eval-judge-ced286944fd4': ['8e1f56d6a647'],
}

/**
 * The versions a `cap.eval.judge` run may carry to count as judge `a`'s: the one this build would record, and the legacy
 * ones of the current judge version. Any other (a handler edit that is not known to leave judge `a` alone) is skipped
 * by the calibration.
 */
export function judgeRunVersions(
  registry: Parameters<typeof createCapabilityWorkflows>[0],
  judgeVersion: string = JUDGE_VERSION,
): readonly string[] {
  const legacy = LEGACY_JUDGE_RUN_VERSIONS[judgeVersion] ?? []
  const current = createCapabilityWorkflows(registry).get('eval.judge')?.version
  return current ? [current, ...legacy] : legacy
}
