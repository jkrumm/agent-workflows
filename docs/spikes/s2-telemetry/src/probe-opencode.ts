// Does OpenCode 2.0.32 emit OTel, how is it switched on, what do its spans hold, can our step span parent them?
// One throwaway `opencode serve` (pinned build, scratch roots, never the shared store), ONE tiny prompt on the cheap IU chat route.
// IU credentials are read from the macOS Keychain into the child env only; nothing is printed or written.
//   bun src/probe-opencode.ts [--flag] [--tool]
//     --flag  sets experimental.openTelemetry=true in the server config
//     --tool  asks for one bash tool call (config allows bash) instead of a plain reply
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { initTelemetry, withSpan } from "./telemetry.ts";
import { ensureOut, OUT, stopProc } from "./util.ts";

const flag = process.argv.includes("--flag");
const tool = process.argv.includes("--tool");
const noPrompt = process.argv.includes("--no-prompt");
const noResAttr = process.argv.includes("--no-resattr");
const PROMPT_TIMEOUT_MS = 45_000;
const tag = Date.now().toString(36);
const root = join(tmpdir(), `s2-opencode-${tag}`);
const bin = join(homedir(), ".local/share/agent-gateway/opencode-bin/2.0.32/node_modules/.bin/opencode");
const port = 17900 + Math.floor(Math.random() * 90);
const pw = crypto.randomUUID();
const sh = (cmd: string[]) => {
  const r = Bun.spawnSync(cmd);
  if (r.exitCode !== 0) throw new Error(`${cmd[0]} exited ${r.exitCode}: ${new TextDecoder().decode(r.stderr).trim().slice(0, 120)}`);
  return new TextDecoder().decode(r.stdout).trim();
};

const iuKey = sh(["security", "find-generic-password", "-s", "claude-sdk-api-key", "-w"]);
const iuBase = sh(["security", "find-generic-password", "-s", "claude-sdk-base-url", "-w"]).replace(/\/$/, "");
if (!iuKey || !iuBase) throw new Error("IU credentials missing from the Keychain (empty key or base URL)");
const MODEL = "deepseek-v4.1-flash";
const cfg = {
  autoupdate: false,
  share: "disabled",
  ...(flag ? { experimental: { openTelemetry: true } } : {}),
  ...(tool ? { permission: { bash: "allow" } } : {}),
  providers: {
    "iu-chat": {
      package: "aisdk:@ai-sdk/openai-compatible",
      name: "IU chat",
      settings: { baseURL: "{env:IU_OPENAI_BASE}", apiKey: "{env:IU_KEY}" },
      models: { [MODEL]: { name: MODEL, limit: { context: 128000, output: 8000 }, cost: { input: 0, output: 0 } } },
    },
  },
};

// opencode retries a dead endpoint forever (that is what opencode-safe guards against): probe the route first, 5 s ceiling.
const reachable = await fetch(`${iuBase.replace(/\/anthropic$/, "")}/openai/v1/models`, {
  headers: { authorization: `Bearer ${iuKey}` },
  signal: AbortSignal.timeout(5000),
}).then((r) => r.ok, () => false);
if (!reachable) throw new Error("IU chat route unreachable; aborting before starting opencode");
console.log("route reachable");

ensureOut();
rmSync(root, { recursive: true, force: true });
for (const d of ["home", "data", "config", "state", "cache"]) mkdirSync(join(root, d), { recursive: true });

const tel = initTelemetry({ serviceName: "opencode-probe-caller" });
const server = Bun.spawn([bin, "serve", "--hostname", "localhost", "--port", String(port)], {
  cwd: join(root, "home"),
  env: {
    PATH: process.env.PATH!,
    HOME: join(root, "home"),
    TMPDIR: tmpdir(),
    LANG: "en_US.UTF-8",
    XDG_DATA_HOME: join(root, "data"),
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_STATE_HOME: join(root, "state"),
    XDG_CACHE_HOME: join(root, "cache"),
    OPENCODE_SERVER_PASSWORD: pw,
    OPENCODE_CONFIG_CONTENT: JSON.stringify(cfg),
    IU_KEY: iuKey,
    IU_OPENAI_BASE: `${iuBase.replace(/\/anthropic$/, "")}/openai/v1`,
    OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4319",
    ...(noResAttr ? {} : { OTEL_RESOURCE_ATTRIBUTES: `probe.run=${tag}` }),
  },
  stdout: Bun.file(join(root, "server.log")),
  stderr: Bun.file(join(root, "server.log")),
});

let ourTrace = "";
let ourStep = "";
let messages: unknown;
try {
  const base = `http://localhost:${port}`;
  const auth = { authorization: `Basic ${btoa(`opencode:${pw}`)}` };
  for (let i = 0; i < 80; i++) {
    const ok = await fetch(`${base}/api/info`, { headers: auth, signal: AbortSignal.timeout(2000) }).then((r) => r.ok).catch(() => false);
    if (ok) break;
    await Bun.sleep(500);
  }

  await withSpan(tel, "agw.step research", { "agw.step.id": "research", "agw.step.kind": "agent", "probe.run": tag }, async (span) => {
    ourTrace = span.spanContext().traceId;
    ourStep = span.spanContext().spanId;
    const h = { ...auth, "content-type": "application/json", ...tel.inject({}) };
    console.log("server up");
    const created = await fetch(`${base}/api/session`, {
      method: "POST",
      headers: h,
      signal: AbortSignal.timeout(30_000),
      body: JSON.stringify({ location: { directory: join(root, "home") }, model: { providerID: "iu-chat", id: MODEL } }),
    }).then((r) => r.json() as Promise<{ data: { id: string } }>);
    const sid = created.data.id;
    console.log("session:", sid);
    let promptStatus: number | string;
    if (noPrompt) {
      for (const path of ["/api/info", "/api/session", "/api/session/active"]) {
        const r = await fetch(`${base}${path}`, { headers: h, signal: AbortSignal.timeout(10_000) });
        console.log("GET", path, r.status);
      }
      promptStatus = "skipped";
    } else try {
      const body = JSON.stringify({ text: tool ? "Use the bash tool to run `echo ok`, then reply with the single word DONE." : "Reply with the single word OK." });
      const viaCurl = process.argv.includes("--curl");
      if (viaCurl) {
        const out = Bun.spawnSync(["curl", "-sS", "-m", String(PROMPT_TIMEOUT_MS / 1000), "-o", "/dev/null", "-w", "%{http_code}", "-X", "POST",
          "-u", `opencode:${pw}`, "-H", "content-type: application/json", ...Object.entries(tel.inject({})).flatMap(([k, v]) => ["-H", `${k}: ${v}`]),
          `${base}/api/session/${sid}/prompt`, "-d", body]);
        promptStatus = `curl ${out.stdout.toString()} ${out.stderr.toString().slice(0, 80)}`.trim();
      } else {
        const prompt = await fetch(`${base}/api/session/${sid}/prompt`, { method: "POST", headers: h, signal: AbortSignal.timeout(PROMPT_TIMEOUT_MS), body });
        promptStatus = prompt.status;
      }
      const waited = await fetch(`${base}/api/experimental/session/${sid}/wait`, { method: "POST", headers: h, signal: AbortSignal.timeout(PROMPT_TIMEOUT_MS) });
      console.log("wait:", waited.status);
    } catch (e) {
      promptStatus = `HUNG/ERR after ${PROMPT_TIMEOUT_MS} ms: ${(e as Error).name}`;
    }
    console.log("prompt:", promptStatus);
    messages = await fetch(`${base}/api/session/${sid}/message`, { headers: h, signal: AbortSignal.timeout(10_000) })
      .then((r) => r.json())
      .catch((e) => ({ error: String(e) }));
    writeFileSync(join(OUT, `opencode-messages.${flag ? "flag" : "noflag"}${tool ? ".tool" : ""}.json`), JSON.stringify(messages, null, 2));
  });
  await tel.forceFlush();
  await Bun.sleep(6000); // opencode's exporter batch interval
} finally {
  // bounded: SIGTERM first so opencode flushes its spans, SIGKILL if it wedged (it did in every prompt attempt)
  const end = await stopProc(server, 8000);
  if (end === "killed") console.log("server ignored SIGTERM for 8 s; SIGKILL (its spans are lost)");
  console.log("server log tail:\n" + Bun.spawnSync(["tail", "-n", "15", join(root, "server.log")]).stdout.toString().slice(0, 2500));
  await tel.shutdown();
}
writeFileSync(join(OUT, "opencode-trace-id.txt"), `${ourTrace}\n${tag}\n${ourStep}\n`);
console.log(`flag=${flag} ourTrace=${ourTrace} run=${tag}`);
