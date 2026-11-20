import { defineWorkflowModule } from '../registry.ts'
import { createIrisTriage } from './index.ts'

/**
 * The cases are Iris memos (transcripts and replies), so they are never committed: `agw eval run iris-triage` reads
 * `$AGW_EVAL_DIR/iris-triage/cases.jsonl`, which `make eval-mine-iris` writes from the journal's recorded Iris calls.
 */
export default defineWorkflowModule({
  id: 'iris-triage',
  create: (deps) => [createIrisTriage({ registry: deps.registry })],
  suite: 'plain',
})
