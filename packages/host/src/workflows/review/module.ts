import { ReviewCase, readCases } from '@agent-workflows/eval'
import { defined } from '../eval/suites.ts'
import { defineWorkflowModule } from '../registry.ts'
import { createReviewWorkflows } from './index.ts'
import { reviewReference } from './scorer.ts'

export default defineWorkflowModule({
  id: 'review',
  create: (deps) => createReviewWorkflows(deps),
  // The recorded diff as uncommitted changes on `baseSha`, reviewed at the recorded depth.
  suite: {
    read: (path) =>
      readCases(path, ReviewCase).map((c) => ({
        id: c.id,
        tree: { repo: c.repo, baseSha: c.baseSha, patch: c.diff },
        setup: false,
        input: (dir, args) => ({
          ...defined({
            cwd: dir,
            scope: 'uncommitted',
            depth: c.legacy.depth ?? c.input.depth,
            context: c.input.context,
          }),
          ...args,
        }),
        reference: reviewReference(c.legacy),
      })),
  },
})
