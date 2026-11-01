// Shared helpers for the passthrough spike. No dependencies: Bun only.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

export const HERE = import.meta.dir;
export const RAW = `${HERE}/results/raw`;
export const CAP = 40; // hard cap on real upstream /v1/messages calls, counted across reruns
const COUNTER = `${RAW}/.calls`;

export function sha256(buf: ArrayBuffer | Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(buf).digest("hex");
}

// The IU credit-org key, through the offline secrets cache. Never printed, never written.
// claude-platform/API_KEY_IU lives in the mini vault since the 2026-11-01 reseed; the common/ ref no longer resolves.
export function resolveKey(): string {
  const p = Bun.spawnSync(["secrets-run", "read", "op://mini/claude-platform/API_KEY_IU"], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const key = p.stdout.toString().trim();
  if (p.exitCode !== 0 || !key) throw new Error(`secrets-run read failed (exit ${p.exitCode})`);
  return key;
}

export function spent(): number {
  return existsSync(COUNTER) ? Number.parseInt(readFileSync(COUNTER, "utf8"), 10) || 0 : 0;
}

// Count one real upstream call before it is made; throws past the cap.
export function spend(): number {
  mkdirSync(RAW, { recursive: true });
  const n = spent() + 1;
  if (n > CAP) throw new Error(`budget: ${CAP} upstream calls already used`);
  writeFileSync(COUNTER, String(n));
  return n;
}
