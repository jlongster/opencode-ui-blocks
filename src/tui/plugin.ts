import type { Plugin } from "@opencode/plugin/tui"
import { onCleanup } from "solid-js"
import { createUiBlockRenderer } from "./block"
import { PANEL, PanelAppRenderable } from "./panel"

/**
 * Options (set on the plugin's entry in the TUI config): `display` is "panel" (default: apps open in
 * the right-hand session panel, the transcript shows a card) or "inline" (apps render in the
 * transcript).
 */
export default {
  id: "opencode-ui-blocks",
  setup(context: Plugin.Context) {
    const palette = () => ({
      text: context.theme.text.base,
      muted: context.theme.text.muted,
      accent: context.theme.text.action.primary.base,
      error: context.theme.text.feedback.error.base,
      border: context.theme.border.base,
    })
    const directory = () => context.location?.directory ?? process.cwd()
    const inline = context.options.display === "inline"
    // The host focuses a panel when it mounts. An app arriving on its own must not take the keyboard
    // from the prompt, so hand focus back to the session pane once the panel is up.
    let returnFocus = false
    const panel = inline
      ? undefined
      : {
          open: (options?: { keepFocus?: boolean }) => {
            if (context.ui.panel.current()?.name === PANEL) return
            returnFocus = options?.keepFocus === true
            context.ui.panel.open(PANEL)
          },
        }
    context.markdown.registerCodeBlockRenderer("ui", createUiBlockRenderer(context.renderer, palette, directory, panel))
    if (inline) return
    context.ui.slot({
      append: "session.panel",
      render: (input) => {
        if (input.name !== PANEL) return undefined
        const view = new PanelAppRenderable(context.renderer, palette, directory)
        onCleanup(() => view.destroyRecursively())
        // The host's own "Focus session pane" command: focusing the prompt directly is ignored while the
        // panel holds the input scope.
        if (returnFocus) setTimeout(() => context.keymap.dispatch("pane.focus.left"), 0)
        returnFocus = false
        // OpenTUI's Solid renderer inserts renderables as they are.
        return view as unknown as ReturnType<Parameters<Plugin.Context["ui"]["slot"]>[0]["render"]>
      },
    })
  },
} satisfies Plugin.Definition
