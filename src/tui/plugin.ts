import type { Plugin } from "@opencode/plugin/tui"
import { onCleanup } from "solid-js"
import { PANEL, PanelAppRenderable, panelApps, TOOL } from "./panel"

/**
 * Apps arrive as `ui_app` tool calls (registered by server.ts). Their input streams in as the model
 * writes it; this side opens the right-hand session panel and runs the app there.
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
    const viewing = () => {
      const route = context.ui.router.current()
      return route.type === "session" ? route.sessionID : undefined
    }
    // The host focuses a panel when it mounts. An app arriving on its own must not take the keyboard
    // from the prompt, so hand focus back to the session pane once the panel is up.
    let returnFocus = false
    const open = (options: { keepFocus: boolean }) => {
      if (context.ui.panel.current()?.name === PANEL) return
      returnFocus = options.keepFocus
      context.ui.panel.open(PANEL)
    }

    context.ui.slot({
      append: "session.panel",
      render: (input) => {
        if (input.name !== PANEL) return undefined
        const view = new PanelAppRenderable(context.renderer, input.sessionID, palette, directory)
        onCleanup(() => view.destroyRecursively())
        // The host's own "Focus session pane" command: focusing the prompt directly is ignored while
        // the panel holds the input scope.
        if (returnFocus) setTimeout(() => context.keymap.dispatch("pane.focus.left"), 0)
        returnFocus = false
        // OpenTUI's Solid renderer inserts renderables as they are.
        return view as unknown as ReturnType<Parameters<Plugin.Context["ui"]["slot"]>[0]["render"]>
      },
    })

    // Apps from earlier in the session (or from before the TUI started) live in its history. Keymap
    // layers need the host's component context, so the command is registered from an app slot.
    context.ui.slot({
      append: "app",
      render: () => {
        context.keymap.layer(() => ({
          mode: "global",
          commands: [
        {
          id: "ui-blocks.open",
          title: "Open UI app…",
          group: "UI apps",
          palette: true,
          enabled: () => viewing() !== undefined,
          run: async () => {
            const sessionID = viewing()
            if (!sessionID) return
            await context.data.session.message.sync(sessionID)
            const calls = history(context.data.session.message.list(sessionID))
            if (calls.length === 0) {
              await context.ui.dialog.alert({ title: "UI apps", message: "No apps in this session yet." })
              return
            }
            const id = await context.ui.dialog.select({
              title: "Open UI app",
              current: panelApps.selected(sessionID)?.id,
              options: calls.map((call) => ({ title: call.title, value: call.id })),
            })
            if (!id) return
            const call = calls.find((item) => item.id === id)!
            if (!panelApps.get(id)?.done) panelApps.finish(sessionID, id, call.input)
            panelApps.select(sessionID, id)
            open({ keepFocus: false })
          },
        },
      ],
        }))
        return undefined
      },
    })

    // Subscribed last, so a setup that fails earlier leaves nothing behind. The host does not clean
    // up data.on subscriptions itself, so the returned cleanup does it when the plugin reloads.
    const unsubscribe = [
      context.data.on("session.tool.input.started", (event) => {
        if (event.data.name !== TOOL) return
        panelApps.begin(event.data.sessionID, event.data.id)
        if (viewing() === event.data.sessionID) open({ keepFocus: true })
      }),
      context.data.on("session.tool.input.delta", (event) => panelApps.delta(event.data.id, event.data.delta)),
      context.data.on("session.tool.input.ended", (event) => {
        if (panelApps.get(event.data.id)) panelApps.finish(event.data.sessionID, event.data.id, event.data.text)
      }),
      context.data.on("session.tool.called", (event) => {
        if (panelApps.get(event.data.id)) panelApps.finish(event.data.sessionID, event.data.id, event.data.input)
      }),
    ]
    return () => unsubscribe.forEach((stop) => stop())
  },
} satisfies Plugin.Definition

/** The session's `ui_app` calls, newest first. */
function history(messages: readonly object[]) {
  return messages
    .flatMap((message) => {
      const content = (message as { content?: unknown }).content
      return Array.isArray(content) ? (content as unknown[]) : []
    })
    .flatMap((part) => {
      const tool = part as { type?: string; name?: string; id?: string; state?: { input?: unknown } }
      const input = tool.state?.input
      if (tool.type !== "tool" || tool.name !== TOOL || !tool.id || !input || typeof input !== "object") return []
      const title = (input as { title?: unknown }).title
      return [{ id: tool.id, title: typeof title === "string" ? title : "App", input: input as Record<string, unknown> }]
    })
    .reverse()
}
