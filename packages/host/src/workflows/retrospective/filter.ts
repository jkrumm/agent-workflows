import type { RetroAnalysis } from './schema.ts'

// The repo is public and runs review private and work repositories. What reaches a GitHub issue is the proposal text,
// its target and run ids; the text is the agent's own words and may quote the sampled data, so it is filtered here,
// deterministically, never by asking the model. Strip what is safe to strip (absolute paths), refuse the rest.

/** Top-level directories of this repo: the only slash-separated references allowed to survive in issue text. */
export const REPO_ROOTS = ['agents', 'packages', 'docs', 'scripts', 'deploy'] as const

/** Prose pairs that look like `owner/repo` and are not. */
const PROSE_PAIRS = new Set([
  'and/or',
  'input/output',
  'true/false',
  'yes/no',
  'read/write',
  'pass/fail',
  'on/off',
  'either/or',
  'request/response',
  'success/failure',
  'start/stop',
  'client/server',
  'tokens/s',
  'a/b',
])

const ABSOLUTE_PATH = [
  /[A-Za-z]:\\[^\s'"`)\]>,;]+/g,
  /~\/[^\s'"`)\]>,;]*/g,
  // `/Users/x/y`, `/etc/hosts`, `/tmp/a`: a leading slash not preceded by a word character, dot or colon (so the
  // slashes inside `agents/x` and `https://` never match here), with at least one more segment or a known root.
  /(?<![\w.:/-])\/(?:[\w.@+-]+\/)+[\w.@+-]*/g,
  /(?<![\w.:/-])\/(?:Users|home|private|var|tmp|opt|etc|mnt|Volumes|root|srv|usr)\b[^\s'"`)\]>,;]*/g,
]

const REFUSED: { reason: string; pattern: RegExp }[] = [
  { reason: 'contains a URL', pattern: /\b(?:https?|ssh|git|file):\/\/\S+/i },
  { reason: 'contains a git remote', pattern: /\bgit@[\w.-]+:/i },
  { reason: 'contains an IP address', pattern: /\b\d{1,3}(?:\.\d{1,3}){3}\b/ },
  { reason: 'contains an email address', pattern: /[\w.+-]+@[\w-]+\.[\w.-]+/ },
  {
    reason: 'contains a hostname',
    pattern: /\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|org|net|io|dev|app|ts\.net|internal|local|lan|home)\b/i,
  },
]

/** `a/b` tokens: a repo-relative path of this repo passes, a prose pair passes, anything else may be an `owner/repo`. */
const SLASH_TOKEN = /(?<![\w./-])[\w.@+-]+(?:\/[\w.@+-]+)+/g

export type Sanitized = { ok: true; text: string } | { ok: false; reason: string }

/** The text with absolute paths replaced by `<path>`, or the reason it cannot be filed. */
export function sanitizeIssueText(input: string): Sanitized {
  let text = input
  for (const pattern of ABSOLUTE_PATH) text = text.replaceAll(pattern, '<path>')
  for (const { reason, pattern } of REFUSED) {
    if (pattern.test(text)) return { ok: false, reason }
  }
  for (const token of text.match(SLASH_TOKEN) ?? []) {
    const lower = token.toLowerCase().replace(/[.,;:]+$/, '')
    if (PROSE_PAIRS.has(lower) || !/[a-z]/i.test(token)) continue
    const [root, ...rest] = token.split('/')
    if ((REPO_ROOTS as readonly string[]).includes(root ?? '') && !rest.includes('..')) continue
    return { ok: false, reason: `contains a path or repo reference outside this repo (${root}/…)` }
  }
  return { ok: true, text }
}

/** A target is an agent name, or a path inside this repo (or an `agw` command, which is public CLI surface). */
export function targetProblem(target: string, agents: readonly string[]): string | null {
  if (agents.includes(target)) return null
  if (/^agw [a-z][a-z0-9-]*(?: [a-z][a-z0-9-]*){0,3}$/.test(target)) return null
  const parts = target.split('/')
  if (target.startsWith('/') || target.includes('\\') || parts.includes('..') || parts.includes('')) {
    return 'target is not a repo-relative path'
  }
  if (!(REPO_ROOTS as readonly string[]).includes(parts[0] ?? '') || !/^[\w./@+-]+$/.test(target)) {
    return 'target is not inside this repo'
  }
  return null
}

export interface IssueDraft {
  title: string
  body: string
}

export type IssueDecision = ({ ok: true } & IssueDraft) | { ok: false; title: string; reason: string }

type Proposal = RetroAnalysis['proposals'][number]

const fenced = (value: string) => `\`${value.replaceAll('`', "'")}\``

/**
 * The issue for one proposal: the filtered proposal text, its kind and target, and run ids. Nothing of the sampled
 * runs (inputs, outputs, cwd, repos, transcripts) is read here: the function only sees the agent's proposal.
 */
export function issueFor(args: {
  workflow: string
  retroRunId: string
  proposal: Proposal
  agents: readonly string[]
}): IssueDecision {
  const { workflow, retroRunId, proposal, agents } = args
  const title = `retro(${workflow}): ${proposal.title.trim()}`
  const targetIssue = targetProblem(proposal.target, agents)
  if (targetIssue) return { ok: false, title, reason: targetIssue }
  const cleanTitle = sanitizeIssueText(title)
  if (!cleanTitle.ok) return { ok: false, title, reason: `title ${cleanTitle.reason}` }
  const change = sanitizeIssueText(proposal.change)
  if (!change.ok) return { ok: false, title: cleanTitle.text, reason: `change ${change.reason}` }
  const body = [
    `Proposed by the weekly retrospective of ${fenced(workflow)} (run ${fenced(retroRunId)}). Proposals are never applied automatically.`,
    '',
    `- **Kind:** ${proposal.kind}`,
    `- **Target:** ${fenced(proposal.target)}`,
    `- **Confidence:** ${proposal.confidence}`,
    '',
    change.text.trim(),
    '',
    `**Evidence (run ids):** ${proposal.evidence.map(fenced).join(', ')}`,
  ].join('\n')
  return { ok: true, title: cleanTitle.text, body }
}
