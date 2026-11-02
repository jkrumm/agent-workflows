import { GtCase, gtPath, readCases } from '@agent-workflows/eval'
import { defineWorkflowModule } from '../registry.ts'
import { createImportedReviewWorkflow } from './imported.ts'
import { createReviewWorkflows } from './index.ts'

export default defineWorkflowModule({
  id: 'review',
  create: (deps) => [...createReviewWorkflows(deps), createImportedReviewWorkflow()],
  // The ground truth (`docs/review-v2.md` §Ground truth): each case's commit checked out alone (`isolate`: no later
  // fix is reachable) and reviewed as the last commit, at the review's own depth unless the arm sets one.
  suite: {
    path: (env) => gtPath('cases.jsonl', env),
    read: (path) =>
      readCases(path, GtCase).map((c) => ({
        id: c.id,
        tree: { repo: c.repo, baseSha: c.sha, isolate: true },
        setup: false,
        input: (dir, args) => ({ cwd: dir, scope: 'head', context: c.subject, ...args }),
        reference: c,
      })),
  },
})
