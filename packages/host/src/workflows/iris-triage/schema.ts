import { z } from 'zod'

/** The `triage` capability's input as Iris sends it: the route, the dictated transcript and the assistant's reply, if any. */
export const IrisTriageInput = z.object({
  destination: z.string().min(1),
  transcript: z.string(),
  reply: z.string().nullish(),
})
export type IrisTriageInput = z.output<typeof IrisTriageInput>

/** The notification text and what the call cost in time: the answer is the three fields, the rest is for the arms' comparison. */
export const IrisTriageOutput = z.object({
  headline: z.string(),
  detail: z.string(),
  spoken: z.string(),
  model: z.string(),
  attempts: z.int().min(1).max(2),
  latencyMs: z.int().nonnegative(),
})
export type IrisTriageOutput = z.output<typeof IrisTriageOutput>
