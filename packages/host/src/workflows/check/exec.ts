import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { commandEnv } from './env.ts'

/** What one command run reports; the output is a bounded tail, never the whole log. */
export interface ExecResult {
  /** `null` when a signal ended the process. 127 when it could not be started. */
  exitCode: number | null
  /** The signal that ended the process, when one did (set for our own kills too: see the flags). */
  signalCode: string | null
  /** The last `tailChars` characters of stdout and stderr, as they arrived. */
  output: string
  /** Characters before the tail were dropped. */
  truncated: boolean
  /** Killed because nothing was written for `idleMs`. */
  idleKilled: boolean
  /** Killed because `wallMs` passed (helper probes only). */
  timedOut: boolean
  /** Killed because `signal` aborted. */
  aborted: boolean
}

export interface ExecRequest {
  argv: string[]
  cwd: string
  /** Idle watchdog: kill after this long without new output. Never a wall-clock cap on a validation step. */
  idleMs?: number
  /** Wall-clock cap, for helper subprocesses (git, `make -p`) only. */
  wallMs?: number
  signal?: AbortSignal
  /** Called on every chunk the command writes; feeds the runtime's step idle timer. */
  onOutput?: () => void
  /** Trailing characters kept in `output`. Default {@link DEFAULT_TAIL_CHARS}; `Infinity` keeps everything. */
  tailChars?: number
  /** `merge` (default) keeps stderr in `output`; `discard` drops it. */
  stderr?: 'merge' | 'discard'
  /**
   * A file that records the spawned process group while it runs. Before spawning, a group still alive from an
   * earlier host process (a crash between spawn and reap) is killed; the file is removed after the run.
   */
  groupFile?: string
}

/** The subprocess port of the check workflows: `Bun.spawn` in production, a script in tests. */
export interface Exec {
  run(request: ExecRequest): Promise<ExecResult>
  /** The path of an installed executable, or null. */
  which(command: string): string | null
}

export const DEFAULT_TAIL_CHARS = 20_000
const KILL_GRACE_MS = 5_000
/** Once the leader is gone the pipes close; a writer that survived the group kill must not wedge the step. */
const DRAIN_GRACE_MS = 5_000

/**
 * Reads `stream` to its end, handing every chunk to `onChunk` and the decoded text (flushed at the end, so a
 * multi-byte character cut by the last chunk is not lost) to `onText`. A read that fails, for instance when a kill
 * tears the pipe down, is the end of the stream: this never rejects.
 */
export async function drainStream(
  stream: ReadableStream<Uint8Array>,
  onChunk: () => void,
  onText?: (text: string) => void,
): Promise<void> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      onChunk()
      if (onText) onText(decoder.decode(value, { stream: true }))
    }
  } catch {
    // the end of the stream
  }
  try {
    if (onText) onText(decoder.decode())
    reader.releaseLock()
  } catch {
    // nothing left to read either way
  }
}

type GroupRecord = { pgid: number; started: string }

/** `pid pgid lstart` of every process: the start time tells a recorded leader from a reused pid. */
function processTable(): { pid: number; pgid: number; started: string }[] {
  const ps = Bun.spawnSync(['ps', '-A', '-o', 'pid=,pgid=,lstart='], { stdout: 'pipe', stderr: 'ignore' })
  if (ps.exitCode !== 0) return []
  const rows: { pid: number; pgid: number; started: string }[] = []
  for (const line of ps.stdout.toString().split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line)
    if (match) rows.push({ pid: Number(match[1]), pgid: Number(match[2]), started: match[3] ?? '' })
  }
  return rows
}

const startOf = (pid: number) => processTable().find((row) => row.pid === pid)?.started ?? null

/** Kills a recorded process group that is still alive, unless its leader's pid was reused since. */
function reapRecordedGroup(file: string): void {
  let record: GroupRecord
  try {
    record = JSON.parse(readFileSync(file, 'utf8')) as GroupRecord
  } catch {
    return // none, or a torn write from a crash before the spawn finished: nothing recorded to kill
  }
  const table = processTable()
  const leader = table.find((row) => row.pid === record.pgid)
  const members = table.some((row) => row.pgid === record.pgid)
  if (members && (leader === undefined || leader.started === record.started)) {
    try {
      process.kill(-record.pgid, 'SIGKILL')
    } catch {
      // gone between the listing and the kill
    }
  }
  rmSync(file, { force: true })
}

/**
 * The default port. Runs `argv` in `cwd` in its own process group with the host's environment minus credentials
 * (`commandEnv`). The group is killed on idle, wall time or abort, so a recipe's backgrounded child cannot outlive
 * the step; a clean exit is not followed by a kill. A group a crashed host left behind is killed at the next start.
 */
export function createBunExec(options: { env?: Record<string, string | undefined> } = {}): Exec {
  return {
    which: (command) => Bun.which(command),
    run: (request) => runCommand(request, options.env ?? process.env),
  }
}

export const bunExec: Exec = createBunExec()

async function runCommand(request: ExecRequest, env: Record<string, string | undefined>): Promise<ExecResult> {
  const { argv, cwd, idleMs, wallMs, signal, onOutput, groupFile } = request
  const tailChars = request.tailChars ?? DEFAULT_TAIL_CHARS
  if (groupFile) reapRecordedGroup(groupFile)
  let proc: Bun.Subprocess<'ignore', 'pipe', 'pipe'>
  try {
    proc = Bun.spawn(argv, {
      cwd,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      env: commandEnv(env, cwd),
      detached: true,
    })
  } catch (error) {
    const output = error instanceof Error ? error.message : String(error)
    const failed = { idleKilled: false, timedOut: false, aborted: false }
    return { exitCode: 127, signalCode: null, output, truncated: false, ...failed }
  }
  if (groupFile) {
    const started = startOf(proc.pid)
    if (started !== null) {
      mkdirSync(dirname(groupFile), { recursive: true })
      writeFileSync(groupFile, JSON.stringify({ pgid: proc.pid, started } satisfies GroupRecord))
    }
  }

  const killGroup = (code: 'SIGTERM' | 'SIGKILL') => {
    try {
      process.kill(-proc.pid, code)
    } catch {
      // the group is already gone
    }
  }
  const state = { idleKilled: false, timedOut: false, aborted: false }
  const stopped = () => state.idleKilled || state.timedOut || state.aborted
  let escalation: ReturnType<typeof setTimeout> | undefined
  const terminate = () => {
    killGroup('SIGTERM')
    escalation ??= setTimeout(() => killGroup('SIGKILL'), KILL_GRACE_MS)
  }

  let idleTimer: ReturnType<typeof setTimeout> | undefined
  const arm = () => {
    if (idleMs === undefined || stopped()) return
    clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      state.idleKilled = true
      terminate()
    }, idleMs)
  }
  arm()
  const wallTimer =
    wallMs === undefined
      ? undefined
      : setTimeout(() => {
          state.timedOut = true
          terminate()
        }, wallMs)
  const onAbort = () => {
    state.aborted = true
    terminate()
  }
  signal?.addEventListener('abort', onAbort, { once: true })
  if (signal?.aborted) onAbort()

  let tail = ''
  let truncated = false
  const onText = (text: string) => {
    tail += text
    if (tail.length > tailChars) {
      tail = tail.slice(-tailChars)
      truncated = true
    }
  }
  const onChunk = () => {
    arm()
    onOutput?.()
  }
  // `drainStream` never rejects, so neither does `drains`: the race below can only end on the pipes or the grace.
  let drained = false
  const markDrained = () => {
    drained = true
  }
  const drains = Promise.all([
    drainStream(proc.stdout, onChunk, onText),
    drainStream(proc.stderr, onChunk, request.stderr === 'discard' ? undefined : onText),
  ]).then(markDrained, markDrained)
  let graceTimer: ReturnType<typeof setTimeout> | undefined
  try {
    await proc.exited
    // The leader is gone but a recipe can leave an orphan holding the pipes: kill the group, then bound the wait.
    if (!drained) killGroup('SIGKILL')
    await Promise.race([
      drains,
      new Promise<void>((resolve) => {
        graceTimer = setTimeout(resolve, DRAIN_GRACE_MS)
      }),
    ])
  } finally {
    clearTimeout(idleTimer)
    clearTimeout(wallTimer)
    clearTimeout(graceTimer)
    clearTimeout(escalation)
    signal?.removeEventListener('abort', onAbort)
    // Only when something cut the run short or the pipes never closed: after a clean reap the pgid may be reused.
    if (stopped() || !drained) killGroup('SIGKILL')
    if (groupFile) rmSync(groupFile, { force: true })
  }
  return {
    exitCode: proc.exitCode,
    signalCode: proc.signalCode === null ? null : String(proc.signalCode),
    output: tail,
    truncated,
    ...state,
  }
}
