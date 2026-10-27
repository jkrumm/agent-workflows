// Shared by the entrypoints: the (git-ignored) output directory and bounded child shutdown.
import { mkdirSync } from "node:fs";
import { join } from "node:path";

export const OUT = join(import.meta.dir, "..", "out");

/** A fresh clone has no out/: every entrypoint that writes calls this first. */
export function ensureOut(): string {
  mkdirSync(OUT, { recursive: true });
  return OUT;
}

/** SIGTERM, then SIGKILL if the child has not exited within `graceMs`. Returns how it ended. */
export async function stopProc(proc: { kill(sig?: number | NodeJS.Signals): void; exited: Promise<number> }, graceMs = 8000) {
  proc.kill("SIGTERM");
  const r = await Promise.race([proc.exited.then(() => "term" as const), Bun.sleep(graceMs).then(() => "timeout" as const)]);
  if (r === "timeout") {
    proc.kill("SIGKILL");
    await proc.exited;
    return "killed" as const;
  }
  return "term" as const;
}
