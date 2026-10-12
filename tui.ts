import { Plugin } from "@opencode/plugin/tui"
import { createUiBlockRenderer } from "./src/tui/block"

export default Plugin.define({
  id: "opencode-ui-blocks",
  setup(context) {
    context.markdown.registerCodeBlockRenderer(
      "ui",
      createUiBlockRenderer(context.renderer, () => ({
        text: context.theme.text.base,
        muted: context.theme.text.muted,
        accent: context.theme.text.action.primary.base,
        error: context.theme.text.feedback.error.base,
        border: context.theme.border.base,
      })),
    )
  },
})
