// Bun has no Workflow integration: this preload applies the SWC step-mode transform to app code,
// as the SDK's framework-integration guide shows.
import { transform } from "@swc/core";
import { plugin } from "bun";

plugin({
  name: "workflow-transform",
  setup(build) {
    build.onLoad({ filter: /workflows\/.*\.ts$/ }, async (args) => {
      const source = await Bun.file(args.path).text();
      const result = await transform(source, {
        filename: args.path,
        jsc: {
          parser: { syntax: "typescript" },
          target: "es2022",
          experimental: { plugins: [[require.resolve("@workflow/swc-plugin"), { mode: "step" }]] },
        },
      });
      return { contents: result.code, loader: "js" };
    });
  },
});
