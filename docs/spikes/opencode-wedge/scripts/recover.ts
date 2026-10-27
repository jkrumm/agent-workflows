// Detection and recovery of a server stuck in its watcher boot (and how SIGTERM behaves), one run each:
//   1. SIGTERM latency: watchers on, prompt finished, then SIGTERM and wait up to 120 s (ignored vs slow).
//   2. Session survival: watchers on; create a session, SIGKILL the server DURING the boot stall (prompt in flight), restart on the same
//      data dir with watchers off, and check the session, its messages and a new prompt on it.
//   3. Same with a completed first turn (SIGKILL after the reply), restart, second prompt on the same session.
//   4. Detection: GET /api/info latency while the boot stalls.
// Prints one line per fact. Servers it starts are killed in `finally`.
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { iuCreds, routeReachable } from "./trial.ts";

const creds = iuCreds();
if (!(await routeReachable(creds))) { console.error("IU route unreachable; not starting opencode"); process.exit(75); }
const bin = join(process.env.HOME!, ".local/share/agent-gateway/opencode-bin/2.0.32/node_modules/.bin/opencode");
const root = join(tmpdir(), `ocw-recover-${Date.now().toString(36)}`);
const MODEL = "deepseek-v4.1-flash";
const pw = crypto.randomUUID();
const cfg = JSON.stringify({ autoupdate: false, share: "disabled", providers: { "iu-chat": { package: "aisdk:@ai-sdk/openai-compatible", name: "IU chat",
  settings: { baseURL: "{env:IU_OPENAI_BASE}", apiKey: "{env:IU_KEY}" }, models: { [MODEL]: { name: MODEL, limit: { context: 128000, output: 8000 }, cost: { input: 0, output: 0 } } } } } });
const auth = { authorization: `Basic ${btoa(`opencode:${pw}`)}` };
const h = { ...auth, "content-type": "application/json" };
const started: ReturnType<typeof Bun.spawn>[] = [];

function start(dir: string, port: number, watcher: boolean) {
  for (const d of ["home", "data", "config", "state", "cache"]) mkdirSync(join(dir, d), { recursive: true });
  const p = Bun.spawn([bin, "serve", "--hostname", "localhost", "--port", String(port)], {
    cwd: join(dir, "home"),
    env: { PATH: process.env.PATH!, HOME: join(dir, "home"), TMPDIR: tmpdir(), LANG: "en_US.UTF-8", XDG_DATA_HOME: join(dir, "data"), XDG_CONFIG_HOME: join(dir, "config"),
      XDG_STATE_HOME: join(dir, "state"), XDG_CACHE_HOME: join(dir, "cache"), OPENCODE_SERVER_PASSWORD: pw, OPENCODE_CONFIG_CONTENT: cfg, IU_KEY: creds.key, IU_OPENAI_BASE: creds.openai,
      ...(watcher ? {} : { OPENCODE_DISABLE_FILEWATCHER: "1" }) },
    stdout: Bun.file(join(dir, "server.log")), stderr: Bun.file(join(dir, "server.log")),
  });
  started.push(p);
  return p;
}
const api = (port: number, path: string, init: RequestInit = {}, ms = 10_000) => fetch(`http://localhost:${port}${path}`, { headers: h, signal: AbortSignal.timeout(ms), ...init });
async function up(port: number) { for (let i = 0; i < 60; i++) { if (await api(port, "/api/info", {}, 2000).then((r) => r.ok, () => false)) return true; await Bun.sleep(500); } return false; }
const ms = (t: number) => `${Date.now() - t} ms`;
async function newSession(port: number, dir: string) {
  const r = (await (await api(port, "/api/session", { method: "POST", body: JSON.stringify({ location: { directory: join(dir, "home") }, model: { providerID: "iu-chat", id: MODEL } }) })).json()) as { data: { id: string } };
  return r.data.id;
}
// Timeouts are results here (a stalled boot is the thing under test), not crashes: they come back as a status string.
const prompt = (port: number, sid: string, text: string, to = 90_000) => api(port, `/api/session/${sid}/prompt`, { method: "POST", body: JSON.stringify({ text }) }, to).catch((e) => ({ status: (e as Error).name === "TimeoutError" ? "timeout" : `error ${(e as Error).name}` }));
const wait = (port: number, sid: string, to = 90_000) => api(port, `/api/experimental/session/${sid}/wait`, { method: "POST" }, to).catch((e) => ({ status: (e as Error).name === "TimeoutError" ? "timeout" : `error ${(e as Error).name}` }));
const count = async (port: number, sid: string) => (await api(port, `/api/session/${sid}/message`).then((r) => r.json() as Promise<{ data?: unknown[] }>).catch(() => ({ data: undefined }))).data?.length ?? -1;

try {
  // 1 + 4: SIGTERM latency on a healthy-after-boot watcher-on server; detection latency during the boot
  {
    const dir = join(root, "sigterm"); const port = 18100; const p = start(dir, port, true);
    console.log("boot reachable:", await up(port));
    const sid = await newSession(port, dir);
    const t0 = Date.now();
    const pending = prompt(port, sid, "Reply with the single word OK.").then((r) => r.status);
    const probes: string[] = [];
    for (let i = 0; i < 6; i++) { const t = Date.now(); const st = await api(port, "/api/info", {}, 2000).then((r) => String(r.status), () => "timeout(2s)"); probes.push(`${Math.round((t - t0) / 1000)}s:${st}`); await Bun.sleep(2000); }
    console.log("DETECT  GET /api/info during the first-prompt stall (watchers on):", probes.join(" "));
    const ps = await pending;
    console.log("prompt status:", ps, "after", ms(t0));
    if (ps === 200) console.log("wait status:", (await wait(port, sid)).status);
    const tt = Date.now(); p.kill("SIGTERM");
    const ended = await Promise.race([p.exited.then(() => true), Bun.sleep(120_000).then(() => false)]);
    console.log("SIGTERM after the turn (or after the 90 s ceiling if the stall outlasted it), watchers on: exited =", ended, ended ? `after ${ms(tt)}` : "(still alive after 120 s)");
    if (!ended) { const k = Date.now(); p.kill("SIGKILL"); await p.exited; console.log("SIGKILL then exited after", ms(k)); }
  }
  // 2: SIGKILL during the boot stall, restart, re-attach
  {
    const dir = join(root, "midboot"); const p = start(dir, 18101, true);
    await up(18101);
    const sid = await newSession(18101, dir);
    const pend = prompt(18101, sid, "Reply with the single word OK.", 8000).catch(() => "client-timeout");
    await Bun.sleep(3000);
    p.kill("SIGKILL"); await p.exited; await pend;
    console.log("SIGKILL mid-boot-stall: server gone; restarting on the same data dir, watchers off");
    start(dir, 18102, false);
    console.log("restart reachable:", await up(18102));
    const list = (await (await api(18102, "/api/session")).json()) as { data?: { id: string }[] };
    console.log("session survives restart (mid-stall kill):", list.data?.some((s) => s.id === sid) ?? false, "| messages on it:", await count(18102, sid));
    const pr = await prompt(18102, sid, "Reply with the single word OK.", 60_000);
    console.log("new prompt on the old session:", pr.status, "| wait:", (await wait(18102, sid, 60_000)).status, "| messages now:", await count(18102, sid));
  }
  // 3: SIGKILL after a finished turn, restart, second turn
  {
    const dir = join(root, "afterturn"); const p = start(dir, 18103, false);
    await up(18103);
    const sid = await newSession(18103, dir);
    await prompt(18103, sid, "Reply with the single word OK."); await wait(18103, sid);
    const before = await count(18103, sid);
    p.kill("SIGKILL"); await p.exited;
    start(dir, 18104, false); await up(18104);
    const after = await count(18104, sid);
    const pr = await prompt(18104, sid, "Reply with the single word OK.");
    console.log(`session after a finished turn + SIGKILL + restart: messages ${before} -> ${after}; second prompt ${pr.status}, wait ${(await wait(18104, sid)).status}, messages now ${await count(18104, sid)}`);
  }
} finally {
  for (const p of started) { try { p.kill("SIGKILL"); } catch {} }
  await Promise.all(started.map((p) => p.exited));
  rmSync(root, { recursive: true, force: true });
}
