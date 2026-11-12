import type { LlmDeps } from '../llm/model-call.ts'
import { createClassify } from './classify.ts'
import { createDecide } from './decide.ts'
import { createDigest } from './digest.ts'
import { createFactoryAsk } from './factory-ask.ts'
import { createFactoryClassify } from './factory-classify.ts'
import { createFactoryDigest } from './factory-digest.ts'
import { createFactoryErrand } from './factory-errand.ts'
import { createFactoryFixClasses } from './factory-fix-classes.ts'
import { createFactoryQueue } from './factory-queue.ts'
import { createFactoryScreen } from './factory-screen.ts'
import { createFactorySteward } from './factory-steward.ts'
import { createFactoryTriage } from './factory-triage.ts'
import { createNarrativeCompose } from './narrative-compose.ts'
import { createOverviewClassify } from './overview-classify.ts'
import { createProseReview } from './prose-review.ts'
import { createProseWrite } from './prose-write.ts'
import { createSummarize } from './summarize.ts'
import { createTitle } from './title.ts'
import { createTriage } from './triage.ts'

/** The model-backed capabilities: one single call each on its route. */
export function createLlmCapabilities(deps: LlmDeps) {
  return [
    createSummarize(deps),
    createTitle(deps),
    createClassify(deps),
    createDecide(deps),
    createTriage(deps),
    createProseReview(deps),
    createProseWrite(deps),
    createNarrativeCompose(deps),
    createOverviewClassify(deps),
    createFactoryClassify(deps),
    createFactoryAsk(deps),
    createFactorySteward(deps),
    createFactoryQueue(deps),
    createFactoryTriage(deps),
    createFactoryScreen(deps),
    createFactoryErrand(deps),
    createFactoryFixClasses(deps),
    createFactoryDigest(deps),
    createDigest(deps),
  ] as const
}
