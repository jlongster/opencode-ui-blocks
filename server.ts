import type { Plugin } from "@opencode/plugin"

// No runtime imports: the published OpenCode binary does not provide @opencode/plugin to outside
// plugins, and a skill is plain data.
const spec = new URL("./spec.md", import.meta.url).pathname

type Skill = Parameters<Parameters<Plugin.Context["skill"]["transform"]>[0]>[0] extends { add(skill: infer S): void } ? S : never

export default {
  id: "opencode-ui-blocks",
  setup: async (ctx: Plugin.Context) => {
    const content = await Bun.file(spec).text()
    await ctx.skill.transform((editor) => {
      editor.add({
        id: "ui-blocks",
        name: "UI blocks",
        description:
          "Use when an interactive widget would answer better than text: calculators, converters, timers, small games, charts, checklists or controls the user can click and drag. Explains how to write a ```ui lua block that the terminal renders live.",
        path: spec,
        content,
      } as Skill)
    })
  },
}
