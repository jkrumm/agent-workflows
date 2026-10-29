import { CONFIDENCES, RECOMMENDATIONS } from '@agent-workflows/capabilities'
import { z } from 'zod'

// The shapes of the agents overview. They are the payload `agw agents` answers and the Argo push posts, field for field
// what agent-gateway's `GET /api/overview` returned under `data` (minus the retired dispatch fields, `summary.dispatch` included).

export const AGENT_SOURCE = z.enum(['herdr', 'claude'])
export type AgentSource = z.infer<typeof AGENT_SOURCE>

export const AGENT_STATE = z.enum(['needs_you', 'working', 'idle', 'stale', 'done', 'unknown'])
export type AgentState = z.infer<typeof AGENT_STATE>

export const HERDR_STATUS = z.enum(['working', 'idle', 'blocked', 'done', 'unknown'])
export type HerdrAgentStatus = z.infer<typeof HERDR_STATUS>

export const CLAUDE_STATUS = z.enum(['idle', 'busy', 'waiting'])
export type ClaudeAgentStatus = z.infer<typeof CLAUDE_STATUS>

export const RECOMMENDATION = z.enum(RECOMMENDATIONS)
export type Recommendation = z.infer<typeof RECOMMENDATION>

export const CONFIDENCE = z.enum(CONFIDENCES)
export type Confidence = z.infer<typeof CONFIDENCE>

export const RECOMMENDATION_ICON: Record<Recommendation, string> = {
  answer: '?!',
  continue: '→',
  ship: '⇧',
  review: '⚑',
  merge: '⇄',
  close: '✓',
  stale: '·',
  watch: '●',
}

export const AGENT = z.object({
  id: z.string().describe('The Claude session id, or the herdr pane id when the pane has no session'),
  source: AGENT_SOURCE.describe("Which collector produced it: a herdr pane or Claude's own registry"),
  sessionId: z.string().nullable(),
  paneId: z.string().nullable().describe("herdr pane id, e.g. 'wR:p4'"),
  workspaceId: z.string().nullable(),
  title: z.string().nullable().describe("herdr's stripped terminal title, else the transcript's ai-title"),
  state: AGENT_STATE.describe('The one derived urgency state'),
  herdrStatus: HERDR_STATUS.nullable(),
  claudeStatus: CLAUDE_STATUS.nullable(),
  waitingFor: z.string().nullable().describe("Claude's waitingFor reason; set only when claudeStatus is 'waiting'"),
  lastPrompt: z.string().nullable(),
  lastReply: z.string().nullable().describe('The last assistant text of the transcript tail, at most 800 characters'),
  lastActivityAt: z.number().nullable().describe('Epoch ms of the last parsed transcript line (never the file mtime)'),
  account: z.string().nullable().optional().describe('The Claude Max account the agent runs on (`iu`, `me`)'),
  startedAt: z.number().nullable().describe('Epoch ms the process started'),
})
export type Agent = z.infer<typeof AGENT>

export const PROJECT_GIT = z.object({
  branch: z.string(),
  dirty: z.boolean(),
  ahead: z.number(),
  behind: z.number(),
  lastCommit: z.object({ sha: z.string(), subject: z.string(), at: z.string() }).nullable(),
})
export type ProjectGit = z.infer<typeof PROJECT_GIT>

export const PROJECT = z.object({
  name: z.string().describe('The herdr workspace label when a pane resolves it, else the cwd basename'),
  cwd: z.string(),
  git: PROJECT_GIT.nullable(),
  agents: z.array(AGENT),
})
export type Project = z.infer<typeof PROJECT>

export const SUMMARY = z.object({
  needsYou: z.number(),
  working: z.number(),
  idle: z.number(),
  stale: z.number(),
  done: z.number(),
})
export type Summary = z.infer<typeof SUMMARY>

/** One pending request of the human queue (`ask-human.sh`): a `.req` file with no `.res` yet. Never fed to the model. */
export const HUMAN_QUEUE_ENTRY = z.object({
  id: z.string(),
  askedAt: z.string().nullable(),
  question: z.string(),
  cmd: z.string().nullable(),
})
export type HumanQueueEntry = z.infer<typeof HUMAN_QUEUE_ENTRY>

export const SNAPSHOT = z.object({
  generatedAt: z.number().describe('Epoch ms this snapshot was produced'),
  staleAfterHours: z.number(),
  summary: SUMMARY,
  projects: z.array(PROJECT).describe('Most urgent first: needs_you, working, idle, stale, done, then by name'),
  humanQueue: z.array(HUMAN_QUEUE_ENTRY).describe('Pending ask-human requests, newest first'),
  warnings: z.array(z.string()).describe('Non-fatal collector failures'),
})
export type Snapshot = z.infer<typeof SNAPSHOT>

/** The classify seat's verdict for one agent, with the project and session the host adds. */
export const OVERVIEW_AGENT = z.object({
  id: z.string(),
  sessionId: z.string().nullable(),
  project: z.string(),
  recommendation: RECOMMENDATION,
  standing: z.string().max(120).nullable(),
  blocker: z.string().max(80).nullable(),
  confidence: CONFIDENCE,
  synthesized: z.boolean().optional().describe('No verdict came back for this agent: watch/null/low placeholders'),
})
export type OverviewAgent = z.infer<typeof OVERVIEW_AGENT>

/** The `overview` workflow's output. */
export const OVERVIEW_OUTPUT = z.object({
  generatedAt: z.number().describe('Epoch ms the run finished classifying'),
  model: z.string(),
  snapshotGeneratedAt: z.number().describe('Epoch ms of the snapshot the run classified'),
  agents: z.array(OVERVIEW_AGENT),
})
export type OverviewOutput = z.infer<typeof OVERVIEW_OUTPUT>

const NULLABLE_NUM = z.number().nullable()

export const ACCOUNT_QUOTA = z.object({
  five_hour_pct: NULLABLE_NUM,
  seven_day_pct: NULLABLE_NUM,
  five_hour_resets_at: NULLABLE_NUM.describe('Epoch seconds'),
  seven_day_resets_at: NULLABLE_NUM.describe('Epoch seconds'),
  five_hour_mins_left: NULLABLE_NUM,
  auth_ok: z.boolean().nullable(),
  exhausted_until: NULLABLE_NUM.describe('Epoch seconds; null when the account is not marked exhausted'),
  enabled: z.boolean(),
  plan: z.string().nullable(),
  updated_at: NULLABLE_NUM.describe('Epoch ms of the freshest window value'),
  source: z.string().nullable(),
})
export type AccountQuota = z.infer<typeof ACCOUNT_QUOTA>

export const LANE_PICK = z.object({ picked: z.string(), reason: z.string(), stale: z.boolean() })
export type LanePick = z.infer<typeof LANE_PICK>

export const LANE_PICKS = ['interactive', 'wave', 'fan', 'headless'] as const
export type LanePicks = Partial<Record<(typeof LANE_PICKS)[number], LanePick>>

/** The merged agent: the snapshot's fields plus the newest verdict, nulled when the agent moved after it. */
export const ENRICHED_AGENT = AGENT.extend({
  recommendation: RECOMMENDATION.nullable(),
  standing: z.string().nullable(),
  blocker: z.string().nullable(),
  confidence: CONFIDENCE.nullable(),
  recommendationStale: z.boolean().optional(),
})
export type EnrichedAgent = z.infer<typeof ENRICHED_AGENT>

/** `GET /api/overview`'s `data` in agent-gateway, which Argo's `/agents/overview` ingest takes as it is. */
export const OVERVIEW_PAYLOAD = SNAPSHOT.omit({ projects: true }).extend({
  projects: z.array(PROJECT.extend({ agents: z.array(ENRICHED_AGENT) })),
  overview: z
    .object({ generatedAt: z.number(), model: z.string(), ageMs: z.number() })
    .nullable()
    .describe('The newest completed overview run; null when none exists'),
  quota: z.object({
    accounts: z.record(z.string(), ACCOUNT_QUOTA),
    picks: z.record(z.string(), LANE_PICK),
  }),
})
export type OverviewPayload = z.infer<typeof OVERVIEW_PAYLOAD>
