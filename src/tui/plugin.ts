import type { Plugin } from "@opencode/plugin/tui"
import { createUiBlockRenderer } from "./block"

export default {
  id: "opencode-ui-blocks",
  setup(context: Plugin.Context) {
    context.markdown.registerCodeBlockRenderer(
      "ui",
      createUiBlockRenderer(context.renderer, () => ({
        text: context.theme.text.base,
        muted: context.theme.text.muted,
        accent: context.theme.text.action.primary.base,
        error: context.theme.text.feedback.error.base,
        border: context.theme.border.base,
      }), () => context.location?.directory ?? process.cwd()),
    )
  },
} satisfies Plugin.Definition
