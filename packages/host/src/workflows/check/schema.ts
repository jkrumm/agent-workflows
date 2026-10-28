import { isAbsolute } from 'node:path'
import { z } from 'zod'

export const CHECK_INPUT = z
  .object({
    cwd: z
      .string()
      .refine(isAbsolute, 'cwd must be an absolute path')
      .describe('Absolute path to a git work tree to validate (a worktree is fine)'),
    commands: z
      .array(z.string().min(1))
      .optional()
      .describe(
        'Explicit validation commands, run verbatim in order by an agent that skips ecosystem discovery. ' +
          'Omit to use `make check` when the Makefile has one, else discovery',
      ),
    stepTimeoutSeconds: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        'Idle window per step: seconds without new output before a step is killed. Not a wall clock. ' +
          'Default 180, 600 for the test step and for `make check`',
      ),
  })
  .strict()

/** The output of the legacy `check` tool, unchanged. */
export const CHECK_OUTPUT = z.object({
  passed: z.boolean().describe('True only if every step passed'),
  steps: z
    .array(
      z.object({
        name: z
          .string()
          .min(1)
          .describe(
            'Step name: format | lint | typecheck | test | fallow, or check for the `make check` contract path',
          ),
        passed: z.boolean(),
        errors: z.array(z.string()).optional().describe('Error lines; only when the step failed'),
      }),
    )
    .describe('Only the steps that ran'),
  summary: z.string().describe("One line, e.g. 'All 3 steps passed' or '1/3 failed: lint (5 errors)'"),
})

export type CheckInput = z.output<typeof CHECK_INPUT>
export type CheckOutput = z.output<typeof CHECK_OUTPUT>
