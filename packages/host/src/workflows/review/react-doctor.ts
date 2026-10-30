import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { tail } from './exec.ts'
import type { Base, ReviewPorts } from './git.ts'
import { escapeName } from './util.ts'

// react-doctor: a pinned install run by absolute path, advisory, diff-scoped, fed to the synthesis only. Everything
// below is what agent-gateway measured on 0.9.18 (2026-10-16, server/lib/react-doctor.ts):
// - `--no-telemetry` and `--no-supply-chain` are mandatory: they keep repo data off the vendor's score API and Socket.
// - `--base` takes only `[A-Za-z0-9_./-]`, so the base is resolved to a commit id first.
// - Without `--json-out` stdout is a human block, not JSON; the report goes to a temp file. `--blocking none` keeps exit 0.
// - `--no-cache`: a stale scan cache on a dirty tree is a correctness risk for a reviewer.
// - A working-tree scope (`--base HEAD`) needs `--include-untracked` to see new files.
// - A diagnostic's `filePath` is relative to the scanned project; the repo-relative path is the prefix of its `id`.

/** Pinned in one place: an upgrade is a deliberate act (report shape, rule names, flags). `scripts/install-react-doctor.sh` reads this line. */
export const REACT_DOCTOR_VERSION = '0.9.18'
/** A helper timeout, not an agent run. */
export const REACT_DOCTOR_TIMEOUT_MS = 120_000
export const REACT_DOCTOR_FAILED_PREFIX = 'react-doctor failed'
const STDERR_LINES = 15
const REASON_MAX_CHARS = 600
const MAX_LINES = 40

/** Dropped from the block: style noise, and complexity rules that duplicate fallow's health analysis. */
const DROPPED_RULES = ['only-export-components', 'no-giant-component', 'no-high-complexity-react-function']
/** `repository-secret-file` false-positives on `.env.*.tpl` files that hold only `op://` refs. */
const TEMPLATE_SECRET_RULE = 'repository-secret-file'
const ENV_TEMPLATE_PATH = /\.env.*\.tpl$/

export type ReactDoctorRaw = { stdout: string; ok: boolean }

/** The pinned binary: `AGW_REACT_DOCTOR_BIN`, else `make install-opencode`'s install of the pinned version. */
export function reactDoctorBin(env: ReviewPorts['env']): string {
  return (
    env.AGW_REACT_DOCTOR_BIN?.trim() ||
    join(homedir(), '.local/share/agent-workflows/react-doctor', REACT_DOCTOR_VERSION, 'node_modules/.bin/react-doctor')
  )
}

const isExecutable = (path: string) => {
  try {
    return (statSync(path).mode & 0o111) !== 0
  } catch {
    return false
  }
}

/** Empty output means not applicable; otherwise the JSON report or a `react-doctor failed …` line. */
export async function runReactDoctor(ports: ReviewPorts, repo: string, base: Base): Promise<ReactDoctorRaw> {
  const none = { stdout: '', ok: true }
  if (base.kind === 'skip') return none
  const bin = reactDoctorBin(ports.env)
  if (!isExecutable(bin)) return none
  const tracked = await ports.exec(['git', 'ls-files', '-z', '--', '*package.json'], { cwd: repo, timeoutMs: 30_000 })
  const usesReact = tracked.stdout
    .split('\0')
    .filter(Boolean)
    .some((file) => {
      try {
        return /"react"\s*:/.test(readFileSync(join(repo, file), 'utf8'))
      } catch {
        return false
      }
    })
  if (!usesReact) return none
  let oid: string | null = null
  if (base.kind === 'base') {
    const resolved = await ports.exec(['git', 'rev-parse', '--verify', '--quiet', `${base.ref}^{commit}`], {
      cwd: repo,
      timeoutMs: 30_000,
    })
    oid = resolved.code === 0 ? resolved.stdout.trim() : null
    if (!oid) return { stdout: `${REACT_DOCTOR_FAILED_PREFIX}: cannot resolve base ${base.ref}`, ok: true }
  }
  const dir = mkdtempSync(join(tmpdir(), 'agw-react-doctor-'))
  const out = join(dir, 'report.json')
  try {
    const argv = [
      bin,
      '--no-telemetry',
      '--no-supply-chain',
      '--no-cache',
      '--json',
      '--json-compact',
      '--json-out',
      out,
      '-y',
      '--blocking',
      'none',
      '--scope',
      'changed',
      ...(oid ? ['--base', oid] : []),
      ...(base.kind === 'base' && base.ref === 'HEAD' ? ['--include-untracked'] : []),
    ]
    const r = await ports.exec(argv, { cwd: repo, timeoutMs: REACT_DOCTOR_TIMEOUT_MS })
    let report = ''
    try {
      report = readFileSync(out, 'utf8')
    } catch {
      // no report written
    }
    if (report.trim()) return { stdout: report, ok: r.code === 0 }
    if (r.timedOut) return { stdout: '', ok: false }
    if (r.code !== 0) {
      return {
        stdout: `${REACT_DOCTOR_FAILED_PREFIX} (exit ${r.code ?? 'killed'}): ${tail(r.stderr, STDERR_LINES)}`,
        ok: true,
      }
    }
    return none
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

type Diagnostic = {
  filePath: string
  rule: string
  severity: string
  title: string
  line?: number
  category?: string
  id?: string
}
type Finding = {
  severity: 'error' | 'warning'
  rule: string
  file: string
  line?: number
  title: string
  category: string
}

type Outcome =
  | { kind: 'report'; findings: Finding[]; errorCount: number; unscoped: boolean }
  | { kind: 'failed'; reason: string }
  | { kind: 'not-applicable' }

const CATEGORY_RANK: Record<string, number> = { Bugs: 0, Security: 1, Performance: 2, Maintainability: 4 }

/** Turns the failure text (`(exit N): <stderr tail>`) into one reason: the exit header, the error-looking line first, capped. */
function failureReason(raw: string): string {
  const [, header = '', body = ''] = /^\s*(\(exit \d+\):)?\s*([\s\S]*)$/.exec(raw) ?? []
  const lines = body
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  const errorLine = lines.find((l) => /error|Error|EEXIST|ENOENT|throw/.test(l))
  const ordered = errorLine ? [errorLine, ...lines.filter((l) => l !== errorLine)] : lines
  const reason = [header, ordered.join(' | ')].filter(Boolean).join(' ')
  return reason.length > REASON_MAX_CHARS ? `${reason.slice(0, REASON_MAX_CHARS)}…` : reason
}

const repoRelative = (d: Diagnostic) => {
  const head = d.id?.split('::')[0]
  return head?.endsWith(d.filePath) ? head : d.filePath
}

function parse(result: ReactDoctorRaw): Outcome {
  const stdout = result.stdout.trim()
  if (!stdout) {
    return result.ok
      ? { kind: 'not-applicable' }
      : { kind: 'failed', reason: `timed out after ${REACT_DOCTOR_TIMEOUT_MS / 1000}s or could not start` }
  }
  if (stdout.startsWith(REACT_DOCTOR_FAILED_PREFIX)) {
    return { kind: 'failed', reason: failureReason(stdout.slice(REACT_DOCTOR_FAILED_PREFIX.length).replace(/^:/, '')) }
  }
  let report: { diagnostics?: Diagnostic[]; error?: { message?: string } | null; mode?: string }
  try {
    report = JSON.parse(stdout)
  } catch {
    return { kind: 'failed', reason: 'unparseable report output' }
  }
  if (report.error) return { kind: 'failed', reason: report.error.message ?? 'react-doctor reported an error' }
  const kept = (report.diagnostics ?? []).filter(
    (d) => !DROPPED_RULES.includes(d.rule) && !(d.rule === TEMPLATE_SECRET_RULE && ENV_TEMPLATE_PATH.test(d.filePath)),
  )
  const findings = kept
    .map((d): Finding => ({
      severity: d.severity === 'error' ? 'error' : 'warning',
      rule: d.rule,
      file: repoRelative(d),
      ...(d.line === undefined ? {} : { line: d.line }),
      title: d.title,
      category: d.category ?? '',
    }))
    .toSorted(
      (a, b) =>
        Number(a.severity === 'warning') - Number(b.severity === 'warning') ||
        (CATEGORY_RANK[a.category] ?? 3) - (CATEGORY_RANK[b.category] ?? 3) ||
        a.file.localeCompare(b.file) ||
        (a.line ?? 0) - (b.line ?? 0),
    )
  return {
    kind: 'report',
    findings,
    errorCount: findings.filter((f) => f.severity === 'error').length,
    unscoped: report.mode !== 'baseline',
  }
}

/** The synthesis block: a crash is named as one, never rendered as a clean brief or as "not applicable". */
export function renderReactDoctorBlock(result: ReactDoctorRaw): string {
  const outcome = parse(result)
  if (outcome.kind === 'not-applicable') {
    return 'react-doctor: not run (no React in the repo, no pinned install, or no diff-shaped base for this scope).'
  }
  if (outcome.kind === 'failed') {
    return `${REACT_DOCTOR_FAILED_PREFIX}: ${outcome.reason} — no React-specific static-analysis input for this review.`
  }
  const note = outcome.unscoped
    ? '\nNote: react-doctor ignored the diff scope and scanned everything — findings may predate this change; check them against the diff before using any.'
    : ''
  if (outcome.findings.length === 0) return `react-doctor: no findings in the changed code.${note}`
  const shown = outcome.findings.slice(0, MAX_LINES)
  const lines = shown.map(
    (f) =>
      `${f.severity} ${escapeName(f.rule)} ${escapeName(f.file)}${f.line ? `:${f.line}` : ''} — ${escapeName(f.title)}`,
  )
  const more = outcome.findings.length - shown.length
  if (more > 0) lines.push(`+${more} more`)
  return `react-doctor: ${outcome.findings.length} finding(s), ${outcome.errorCount} error(s)${note}\n\`\`\`\n${lines.join('\n')}\n\`\`\``
}
