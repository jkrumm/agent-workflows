// One OpenCode 2.0.32 server, one prompt, one verdict. Every variable the bisect flips is an option.
// Library: matrix.ts imports runTrial(); `bun scripts/trial.ts key=value ...` runs a single trial and prints JSON.
// IU credentials come from the macOS Keychain into the child env only; nothing is printed or written.
import { mkdirSync, rmSync, writeFileSync, existsSync, cpSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

export type Opts = {
  env: "bun-min" | "parent"; // bun-min = S2's explicit env (replaces the whole env, same as `env -i`); parent = inherit process.env + overrides
  cwd: "home" | "repo" | "empty" | "clean"; // home = the scratch HOME (both earlier spikes), repo = a git repo with an ancestor AGENTS.md, empty = fresh empty dir under the trial root (outside any repo), clean = fresh empty dir under CLEAN_BASE
  home: "cold" | "warm"; // warm = HOME/XDG roots seeded by an earlier server that already ran a prompt
  otel: "up" | "down" | "unset"; // OTLP endpoint: a local sink that answers 200, a dead port, or no OTEL_* at all
  resattr: boolean; // OTEL_RESOURCE_ATTRIBUTES set (S2) or OTEL_SERVICE_NAME (dotfiles)
  flag: boolean; // experimental.openTelemetry in the config
  client: "fetch" | "curl";
  host: "localhost" | "127.0.0.1" | "::1";
  port: "fixed" | "random";
  stdio: "file" | "pipe-unread" | "pipe-read" | "inherit" | "null"; // child stdout+stderr handling
  extra: string; // extra child env, "A=1;B=2" (e.g. OPENCODE_DISABLE_MODELS_FETCH=1)
  ceilingMs: number; // prompt+wait ceiling
  cwdBase?: string; // cwd=clean only: parent of the cwd dir (default CLEAN_BASE)
  depth?: number; // cwd=clean only: extra nested directory levels below CLEAN_BASE
  base?: string; // parent dir of the trial root (default: the scratch dir the caller passes); the cwd and HOME live under it
  tag?: string;
};
export const DEFAULTS: Opts = {
  env: "bun-min", cwd: "home", home: "cold", otel: "up", resattr: true, flag: false,
  client: "fetch", host: "localhost", port: "random", stdio: "file", extra: "", ceilingMs: 25_000,
};
export type Result = Opts & {
  outcome: "prompt" | "wedge";
  where: string; // which call hung, or "ok"
  promptStatus: string; waitStatus: string; promptMs: number;
  replied: boolean; // the message list holds an assistant reply
  infoAfter: string; // GET /api/info on the same server after the prompt
  term: string; // how the child ended: "term <ms>" or "ignored SIGTERM" (then SIGKILL)
  kill: string;
  otlpPosts: number; // POSTs the sink saw while this server lived (only when otel=up)
  cpuMean: number; // mean %CPU of the server, sampled each second until the prompt call returned
  locBootSpans: number; // http.span counter on that line: work done by the boot (Effect spans), load-independent
  locBootMs: number; // server log "location services booted durationMs" (-1 = never logged)
  root: string; // scratch root of this trial (server.log.scrubbed lives there)
};

/** A scratch parent whose ancestors are small directories (the OS TMPDIR holds ~30k entries on the mini). */
export const CLEAN_BASE = "/tmp/ocw-wedge";
const MODEL = "deepseek-v4.1-flash";
const bin = join(homedir(), ".local/share/agent-gateway/opencode-bin/2.0.32/node_modules/.bin/opencode");
export const REPO_FOR_CWD = join(import.meta.dir, "..", "..", "..", ".."); // this worktree: has AGENTS.md at its root
const sh = (cmd: string[]) => {
  const r = Bun.spawnSync(cmd);
  if (r.exitCode !== 0) throw new Error(`${cmd[0]} exited ${r.exitCode}`);
  return new TextDecoder().decode(r.stdout).trim();
};

export function iuCreds() {
  const key = sh(["security", "find-generic-password", "-s", "claude-sdk-api-key", "-w"]);
  const base = sh(["security", "find-generic-password", "-s", "claude-sdk-base-url", "-w"]).replace(/\/$/, "").replace(/\/anthropic$/, "");
  if (!key || !base) throw new Error("IU credentials missing from the Keychain");
  return { key, openai: `${base}/openai/v1` };
}

/** opencode retries a dead endpoint forever (what opencode-safe guards against): same 5 s probe before any LLM-bound server starts. */
export async function routeReachable(c: { key: string; openai: string }) {
  // GET /models on the IU route times out at 5 s on roughly a third of calls (measured, unrelated to opencode): up to 4 tries before giving up.
  for (let i = 0; i < 4; i++) {
    const ok = await fetch(`${c.openai}/models`, { headers: { authorization: `Bearer ${c.key}` }, signal: AbortSignal.timeout(5000) }).then((r) => r.status < 500, () => false);
    if (ok) return true;
  }
  return false;
}

/** A local OTLP/HTTP sink that answers 200 and counts requests. */
export function startSink() {
  let posts = 0;
  const srv = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (r) => { if (r.method === "POST") posts++; return new Response("{}", { status: 200, headers: { "content-type": "application/json" } }); } });
  return { url: `http://127.0.0.1:${srv.port}`, posts: () => posts, stop: () => srv.stop(true) };
}
function deadPort() { const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") }); const p = s.port; s.stop(true); return p; }

const warmRoots = new Map<string, Promise<string>>(); // per-process cache of seeded roots (promise: concurrent trials share one seed)

export async function runTrial(o: Opts, creds: ReturnType<typeof iuCreds>, sink: ReturnType<typeof startSink>, scratch: string): Promise<Result> {
  const id = `${o.tag ?? "t"}-${Math.random().toString(36).slice(2, 8)}`;
  const root = join(o.base ?? scratch, id);
  const dirs = ["home", "data", "config", "state", "cache"];
  rmSync(root, { recursive: true, force: true });
  for (const d of dirs) mkdirSync(join(root, d), { recursive: true });
  if (o.home === "warm") {
    // seed once: boot a server in a cold root, send one prompt, stop it cleanly; copy that root for every warm trial
    let pending = warmRoots.get(scratch);
    if (!pending) {
      pending = (async () => {
        const seed = join(scratch, "warm-seed");
        const r = await runTrial({ ...DEFAULTS, otel: "unset", resattr: false, extra: "OPENCODE_DISABLE_FILEWATCHER=1", tag: "seed", ceilingMs: 60_000 }, creds, sink, scratch);
        if (r.outcome !== "prompt") throw new Error(`warm seed itself failed (${r.where})`);
        cpSync(r.root, seed, { recursive: true });
        return seed;
      })();
      warmRoots.set(scratch, pending);
    }
    const seed = await pending;
    for (const d of dirs) cpSync(join(seed, d), join(root, d), { recursive: true });
  }

  const port = o.port === "fixed" ? 17900 : 17900 + Math.floor(Math.random() * 90) + Math.floor(Math.random() * 20000);
  const pw = crypto.randomUUID();
  const cfg = {
    autoupdate: false, share: "disabled",
    ...(o.flag ? { experimental: { openTelemetry: true } } : {}),
    providers: { "iu-chat": { package: "aisdk:@ai-sdk/openai-compatible", name: "IU chat", settings: { baseURL: "{env:IU_OPENAI_BASE}", apiKey: "{env:IU_KEY}" },
      models: { [MODEL]: { name: MODEL, limit: { context: 128000, output: 8000 }, cost: { input: 0, output: 0 } } } } },
  };
  const endpoint = o.otel === "up" ? sink.url : o.otel === "down" ? `http://127.0.0.1:${deadPort()}` : "";
  const homeDir = join(root, "home");
  const cwd = o.cwd === "home" ? homeDir : o.cwd === "repo" ? REPO_FOR_CWD : o.cwd === "clean" ? (() => { const d = join(o.cwdBase ?? CLEAN_BASE, `cwd-${id}`, ...Array.from({ length: o.depth ?? 0 }, (_, i) => `d${i}`)); mkdirSync(d, { recursive: true }); return d; })() : (() => { const d = join(root, "empty"); mkdirSync(d); return d; })();
  const childEnv: Record<string, string> = {
    ...(o.env === "parent" ? (process.env as Record<string, string>) : {}),
    PATH: process.env.PATH!, HOME: homeDir, TMPDIR: tmpdir(), LANG: "en_US.UTF-8",
    XDG_DATA_HOME: join(root, "data"), XDG_CONFIG_HOME: join(root, "config"), XDG_STATE_HOME: join(root, "state"), XDG_CACHE_HOME: join(root, "cache"),
    OPENCODE_PRINT_LOGS: "1", // the only way to see the boot timeline; a constant in every cell
    OPENCODE_SERVER_PASSWORD: pw, OPENCODE_CONFIG_CONTENT: JSON.stringify(cfg),
    IU_KEY: creds.key, IU_OPENAI_BASE: creds.openai,
    ...(endpoint ? { OTEL_EXPORTER_OTLP_ENDPOINT: endpoint, ...(o.resattr ? { OTEL_RESOURCE_ATTRIBUTES: `probe.run=${id}` } : { OTEL_SERVICE_NAME: "opencode-spike" }) } : {}),
  };
  for (const kv of o.extra.split(";").filter(Boolean)) { const i = kv.indexOf("="); childEnv[kv.slice(0, i)] = kv.slice(i + 1); }
  if (o.env === "parent") for (const k of Object.keys(childEnv)) if (k.startsWith("OTEL_") && !endpoint) delete childEnv[k];
  const logPath = join(root, "server.log");
  const stdio = o.stdio === "file" ? Bun.file(logPath) : o.stdio === "null" ? "ignore" : o.stdio === "inherit" ? "inherit" : "pipe";
  const postsBefore = sink.posts();
  const server = Bun.spawn([bin, "serve", "--hostname", o.host, "--port", String(port)], { cwd, env: childEnv, stdout: stdio as any, stderr: stdio as any });
  if (o.stdio === "pipe-read") { for (const s of [server.stdout, server.stderr]) (async () => { for await (const _ of s as ReadableStream) {} })(); }

  const cpu: number[] = [];
  const cpuTimer = setInterval(() => { const v = Number(Bun.spawnSync(["ps", "-o", "%cpu=", "-p", String(server.pid)]).stdout.toString().trim()); if (!Number.isNaN(v)) cpu.push(v); }, 1000);
  const hostUrl = o.host === "::1" ? "[::1]" : o.host;
  const base = `http://${hostUrl}:${port}`;
  const auth = { authorization: `Basic ${btoa(`opencode:${pw}`)}` };
  const h = { ...auth, "content-type": "application/json" };
  const r: Result = { ...o, outcome: "wedge", where: "boot", promptStatus: "-", waitStatus: "-", promptMs: 0, replied: false, infoAfter: "-", term: "-", kill: "-", otlpPosts: 0, locBootMs: -1, locBootSpans: -1, cpuMean: -1, root };
  try {
    let up = false;
    for (let i = 0; i < 80 && !up; i++) { up = await fetch(`${base}/api/info`, { headers: auth, signal: AbortSignal.timeout(2000) }).then((x) => x.ok).catch(() => false); if (!up) await Bun.sleep(500); }
    if (!up) return r;
    r.where = "session-create";
    const created = await fetch(`${base}/api/session`, { method: "POST", headers: h, signal: AbortSignal.timeout(15_000),
      body: JSON.stringify({ location: { directory: cwd }, model: { providerID: "iu-chat", id: MODEL } }) }).then((x) => x.json() as Promise<{ data: { id: string } }>);
    const sid = created.data.id;
    r.where = "prompt";
    const body = JSON.stringify({ text: "Reply with the single word OK." });
    const t0 = Date.now();
    const deadline = t0 + o.ceilingMs;
    try {
      if (o.client === "curl") {
        const out = Bun.spawnSync(["curl", "-sS", "-m", String(Math.ceil(o.ceilingMs / 1000)), "-o", "/dev/null", "-w", "%{http_code}", "-X", "POST", "-u", `opencode:${pw}`, "-H", "content-type: application/json", `${base}/api/session/${sid}/prompt`, "-d", body]);
        r.promptStatus = out.stdout.toString() === "000" ? "timeout" : out.stdout.toString();
      } else {
        r.promptStatus = String((await fetch(`${base}/api/session/${sid}/prompt`, { method: "POST", headers: h, signal: AbortSignal.timeout(o.ceilingMs), body })).status);
      }
      r.promptMs = Date.now() - t0;
      if (r.promptStatus !== "200") throw new Error("prompt " + r.promptStatus);
      r.where = "wait";
      const left = Math.max(1000, deadline - Date.now());
      r.waitStatus = String((await fetch(`${base}/api/experimental/session/${sid}/wait`, { method: "POST", headers: h, signal: AbortSignal.timeout(left) })).status);
      r.where = "messages";
      const msgs = await fetch(`${base}/api/session/${sid}/message`, { headers: h, signal: AbortSignal.timeout(8000) }).then((x) => x.text());
      r.replied = /"role"\s*:\s*"assistant"/.test(msgs) || /assistant/.test(msgs);
      r.outcome = r.waitStatus === "204" || r.waitStatus === "200" ? "prompt" : "wedge";
      r.where = r.outcome === "prompt" ? "ok" : "wait";
    } catch (e) {
      if (r.promptStatus === "-") r.promptStatus = "timeout";
      else if (r.where === "wait") r.waitStatus = "timeout";
    }
    r.promptMs ||= Date.now() - t0;
    clearInterval(cpuTimer);
    r.cpuMean = cpu.length ? Math.round(cpu.reduce((a, b) => a + b, 0) / cpu.length) : -1;
    r.infoAfter = await fetch(`${base}/api/info`, { headers: auth, signal: AbortSignal.timeout(3000) }).then((x) => String(x.status)).catch(() => "timeout");
    return r;
  } catch (e) {
    r.where += `:${(e as Error).name}`;
    return r;
  } finally {
    clearInterval(cpuTimer);
    const t = Date.now();
    server.kill("SIGTERM");
    const ended = await Promise.race([server.exited.then(() => true), Bun.sleep(6000).then(() => false)]);
    if (ended) r.term = `term ${Date.now() - t}ms`;
    else {
      r.term = "ignored SIGTERM 6s";
      const k = Date.now();
      server.kill("SIGKILL");
      r.kill = (await Promise.race([server.exited.then(() => true), Bun.sleep(3000).then(() => false)])) ? `SIGKILL ok ${Date.now() - k}ms` : "SIGKILL FAILED";
    }
    r.otlpPosts = sink.posts() - postsBefore;
    if (existsSync(logPath)) {
      const log = readFileSync(logPath, "utf8");
      r.locBootMs = Number(/location services booted[^\n]*?durationMs=(\d+)/.exec(log)?.[1] ?? -1);
      r.locBootSpans = Number(/location services booted[^\n]*?http\.span=(\d+)/.exec(log)?.[1] ?? -1);
      writeFileSync(join(root, "server.log.scrubbed"), log.replaceAll(creds.key, "<key>").replaceAll(creds.openai, "<base>").replaceAll(pw, "<pw>"));
    }
  }
}

if (import.meta.main) {
  const o: any = { ...DEFAULTS };
  for (const a of process.argv.slice(2)) { const i = a.indexOf("="); const k = a.slice(0, i), v = a.slice(i + 1); o[k] = v === "true" ? true : v === "false" ? false : k === "ceilingMs" ? Number(v) : v; }
  const creds = iuCreds();
  if (!(await routeReachable(creds))) { console.error("IU route unreachable; not starting opencode"); process.exit(75); }
  const sink = startSink();
  const scratch = join(tmpdir(), `ocw-trial-${Date.now().toString(36)}`);
  mkdirSync(scratch, { recursive: true });
  console.log(JSON.stringify(await runTrial(o, creds, sink, scratch)));
  sink.stop();
}
