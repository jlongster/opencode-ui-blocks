/**
 * Bundles the TUI side into one file. OpenCode only redirects @opentui/core to its own copy for
 * imports in the plugin's entry file, so everything else is inlined and the host packages stay external.
 */
const result = await Bun.build({
  entrypoints: [new URL("../src/tui/plugin.ts", import.meta.url).pathname],
  target: "bun",
  format: "esm",
  external: ["@opentui/core", "@opencode/plugin", "@opencode/plugin/tui"],
})
if (!result.success) throw new AggregateError(result.logs, "build failed")
await Bun.write(new URL("../tui.js", import.meta.url).pathname, result.outputs[0])
console.log(`tui.js: ${(result.outputs[0].size / 1024).toFixed(1)} KB`)
