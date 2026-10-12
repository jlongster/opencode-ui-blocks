import type { Plugin } from "@opencode/plugin"
import { UiWidget } from "./src/index"

// Only relative imports: the published OpenCode binary does not provide @opencode/plugin to outside
// plugins at runtime, and the tool is plain data.
const spec = new URL("./spec.md", import.meta.url).pathname

type Tools = Parameters<Parameters<Plugin.Context["tool"]["transform"]>[0]>[0]

export default {
  id: "opencode-ui-blocks",
  setup: async (ctx: Plugin.Context) => {
    const description = await Bun.file(spec).text()
    await ctx.tool.transform((tools: Tools) => {
      tools.add({
        name: "ui_app",
        description,
        // A direct call, not through code mode: the TUI streams the app from the call's input.
        options: { codemode: false },
        input: {
          type: "object",
          properties: {
            title: { type: "string", description: "Short title shown on the side panel" },
            // Nested so the transcript's one-line tool summary shows the title, not the program.
            program: {
              type: "object",
              properties: { lua: { type: "string", description: "The Lua program: state, then frame(), then helpers" } },
              required: ["lua"],
            },
          },
          required: ["title", "program"],
        },
        output: { type: "string" },
        // The host validates the input against the JSON schema above before calling this.
        execute: async (raw: unknown) => {
          const input = raw as { title: string; program: { lua: string } }
          const problem = check(input.program.lua)
          if (problem) throw new Error(`The app failed: ${problem}. Fix the program and call ui_app again.`)
          const output = `Showing "${input.title}" in the user's side panel. They can use it now; you will not see what they do in it.`
          return { output, content: output }
        },
      })
    })
  },
}

/** Loads the program and draws its first frame, as the TUI will, without running timers. */
function check(lua: string) {
  const widget = new UiWidget.Widget(lua)
  if (widget.loadError) return widget.loadError
  return widget.render().error
}
