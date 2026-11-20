import { defineWorkflowModule } from '../registry.ts'
import { createIrisGist } from './index.ts'

/**
 * The cases are Iris transcripts, so they are never committed: `agw eval run iris-gist` reads
 * `$AGW_EVAL_DIR/iris-gist/cases.jsonl`, which `make eval-mine-iris` writes from the journal's recorded Iris calls.
 */
export default defineWorkflowModule({
  id: 'iris-gist',
  create: (deps) => [createIrisGist({ registry: deps.registry })],
  suite: 'plain',
})
