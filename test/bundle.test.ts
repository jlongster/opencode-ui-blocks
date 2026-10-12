import { expect, test } from "bun:test"
import { builtinModules } from "node:module"

// OpenCode only gives the plugin's entry file the host's @opentui/core, so the TUI side ships as
// one bundled file. Rebuild with `bun run build` after changing src/.
test("tui.js is up to date and imports nothing but host packages (@opentui/core, solid-js)", async () => {
  const committed = await Bun.file(new URL("../tui.js", import.meta.url)).text()
  const result = await Bun.build({
    entrypoints: [new URL("../src/tui/plugin.ts", import.meta.url).pathname],
    target: "bun",
    format: "esm",
    external: ["@opentui/core", "@opencode/plugin", "@opencode/plugin/tui", "solid-js"],
  })
  expect(await result.outputs[0].text()).toBe(committed)
  const imports = new Bun.Transpiler({ loader: "js" }).scan(committed).imports.map((item) => item.path)
  // Node built-ins come from the runtime itself; @opentui/core must be the host's.
  const host = new Set(imports.filter((path) => !builtinModules.includes(path.replace(/^node:/, ""))))
  expect([...host].sort()).toEqual(["@opentui/core", "solid-js"])
})

test("server.ts imports only the plugin's own files at runtime", async () => {
  const source = await Bun.file(new URL("../server.ts", import.meta.url)).text()
  const imports = new Bun.Transpiler({ loader: "ts" }).scan(source).imports.map((item) => item.path)
  expect(imports.every((path) => path.startsWith("./"))).toBe(true)
})
