import { CheckCase, readCases } from '@agent-workflows/eval'
import { defined } from '../eval/suites.ts'
import { defineWorkflowModule } from '../registry.ts'
import { createCheckWorkflows } from './index.ts'
import { checkReference } from './scorer.ts'

export default defineWorkflowModule({
  id: 'check',
  create: (deps) => createCheckWorkflows(deps),
  // The recorded tree (and patch) with the repo's own setup, run with the recorded commands.
  suite: {
    read: (path) =>
      readCases(path, CheckCase).map((c) => ({
        id: c.id,
        tree: { repo: c.repo, baseSha: c.baseSha, ...(c.patch ? { patch: c.patch } : {}) },
        setup: true,
        input: (dir, args) => ({
          ...defined({ cwd: dir, commands: c.input.commands, stepTimeoutSeconds: c.input.stepTimeoutSeconds }),
          ...args,
        }),
        reference: checkReference(c.legacy),
      })),
  },
})
