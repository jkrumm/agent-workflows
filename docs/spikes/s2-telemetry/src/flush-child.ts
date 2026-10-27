// One flush scenario per process. The batch delay is 30 s, so only an explicit flush path can deliver the span.
import { initTelemetry, withSpan } from "./telemetry.ts";

const mode = process.argv[2]!;
const tel = initTelemetry({
  serviceName: "probe-flush",
  scheduleDelayMs: 30_000,
  handlers: !mode.startsWith("nohandler"),
  resourceAttrs: { "probe.run": process.env.PROBE_RUN!, "probe.case": mode },
});
await withSpan(tel, `flush.${mode}`, {}, async () => {});

switch (mode) {
  case "nohandler-exit": // process.exit right after span end, no flush
    process.exit(0);
  case "nohandler-natural": // loop empties, nothing flushes (timer is unref'd)
    break;
  case "handler-natural": // beforeExit handler flushes
    break;
  case "shutdown-then-exit": // explicit await shutdown(), then exit
    await tel.shutdown();
    process.exit(0);
  case "nohandler-sigterm":
  case "handler-sigterm":
  case "handler-sigint":
    setInterval(() => {}, 1000); // stay alive like a server
    console.log("READY");
    break;
}
