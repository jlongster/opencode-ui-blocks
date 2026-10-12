import { Plugin, Skill } from "@opencode/plugin"

const spec = new URL("./spec.md", import.meta.url).pathname

export default Plugin.define({
  id: "opencode-ui-blocks",
  setup: async (ctx) => {
    const content = await Bun.file(spec).text()
    await ctx.skill.transform((editor) => {
      editor.add(
        Skill.Info.make({
          id: Skill.ID.make("ui-blocks"),
          name: Skill.Name.make("UI blocks"),
          description:
            "Use when an interactive widget would answer better than text: calculators, converters, timers, small games, charts, checklists or controls the user can click and drag. Explains how to write a ```ui lua block that the terminal renders live.",
          path: spec as Skill.Info["path"],
          content,
        }),
      )
    })
  },
})
