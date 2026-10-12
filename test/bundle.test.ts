import { expect, test } from "bun:test"

// OpenCode only gives the plugin's entry file the host's @opentui/core, so the TUI side ships as
// one bundled file. Rebuild with `bun run build` after changing src/.
test("tui.js is up to date and imports nothing but host packages", async () => {
  const committed = await Bun.file(new URL("../tui.js", import.meta.url)).text()
  const result = await Bun.build({
    entrypoints: [new URL("../src/tui/plugin.ts", import.meta.url).pathname],
    target: "bun",
    format: "esm",
    external: ["@opentui/core", "@opencode/plugin", "@opencode/plugin/tui"],
  })
  expect(await result.outputs[0].text()).toBe(committed)
  const imports = new Bun.Transpiler({ loader: "js" }).scan(committed).imports.map((item) => item.path)
  expect(imports).toEqual(["@opentui/core"])
})

test("server.ts has no runtime imports", async () => {
  const source = await Bun.file(new URL("../server.ts", import.meta.url)).text()
  expect(new Bun.Transpiler({ loader: "ts" }).scan(source).imports).toEqual([])
})
