import type { HostWorkflow } from '../operations.ts'
import { createSmokePing, type TitleCaller } from './smoke.ts'

/** Every workflow the host process serves. Heavy pipelines run in their own processes (concept §8). */
export function createWorkflows(registry: TitleCaller): HostWorkflow[] {
  return [createSmokePing(registry)]
}
