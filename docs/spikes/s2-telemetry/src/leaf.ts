// Grandchild process: proves TRACEPARENT crosses a process boundary via env.
import { initTelemetry, withSpan } from "./telemetry.ts";

const tel = initTelemetry({ serviceName: "leaf-process" });
await withSpan(tel, "leaf.work", { "process.pid": process.pid }, () => new Promise((r) => setTimeout(r, 10)), {
  parent: tel.extract({ traceparent: process.env.TRACEPARENT }),
});
await tel.shutdown();
