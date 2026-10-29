/**
 * What keeps a hydration child from outliving its host. Started first thing in the child (`hydrate-child.ts`):
 * - a deadline of its own, the host's timeout plus a margin: the host kills a child that is too slow, and this is for the
 *   child the host can no longer reach;
 * - the parent: the host that spawned it is gone (a crash, a deploy that bootstrapped out the LaunchAgent) when the
 *   child's parent pid changes, and a child with nobody to answer exits instead of idling as an orphan.
 * Both timers are unref'd: they never keep a finished child alive.
 */
export type WatchdogOptions = {
  deadlineMs: number
  pollMs?: number
  parentPid: () => number
  exit: (code: number) => void
}

/** Exit codes the host reads in its error message. */
export const EXIT_DEADLINE = 124
export const EXIT_ORPHANED = 125

export function startWatchdog(options: WatchdogOptions): () => void {
  const { deadlineMs, pollMs = 1_000, parentPid, exit } = options
  const parent = parentPid()
  const deadline = setTimeout(() => exit(EXIT_DEADLINE), deadlineMs)
  const poll = setInterval(() => {
    if (parentPid() !== parent) exit(EXIT_ORPHANED)
  }, pollMs)
  deadline.unref()
  poll.unref()
  return () => {
    clearTimeout(deadline)
    clearInterval(poll)
  }
}
