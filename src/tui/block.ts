import type { MarkdownCodeBlockRenderer, RenderContext } from "@opentui/core"
import { UiFence } from "../index"
import { controllerFor, promoteController } from "./controller"
import { AppCardRenderable, panelApps } from "./panel"
import { UiBlockRenderable, type UiPalette } from "./renderable"

/**
 * Renders ```ui fences as live widgets. Markdown calls this again on every streamed delta and
 * whenever it rebuilds the block (e.g. scrolled away and back); the controller keeps the state.
 */
export function createUiBlockRenderer(
  renderer: RenderContext,
  palette: () => UiPalette,
  directory?: () => string,
  /** When given, apps run in the side panel and the transcript shows a card; `open` reveals the panel. */
  panel?: { open: (options?: { keepFocus?: boolean }) => void },
): MarkdownCodeBlockRenderer {
  return (token) => {
    const frame = UiFence.parseFence(token.lang ?? "")
    if (!frame) return undefined
    // Until the fence line ends, its size and title may still be streaming in.
    if (!token.raw.includes("\n")) return undefined
    const closed = isClosed(token.raw)
    const streamingKey = `streaming:${token.lang}`
    const key = closed ? `block:${Bun.hash(token.lang + "\n" + token.text)}` : streamingKey
    if (closed) promoteController(streamingKey, key)
    const controller = controllerFor(key)
    controller.update(token.text, closed)
    if (!panel) return new UiBlockRenderable(renderer, controller, frame, palette(), directory)
    const app = { key, frame }
    // A reply streaming an app takes the panel; once the fence closes the panel follows it to the
    // finished app. Closed apps from history only show a card and never take the panel.
    if (!closed && panelApps.shown?.key !== key) {
      panelApps.show(app)
      // Opened on the app's behalf, not by a click: the user may be typing the next prompt.
      panel.open({ keepFocus: true })
    }
    if (closed && panelApps.shown?.key === streamingKey) panelApps.show(app)
    return new AppCardRenderable(renderer, app, !closed, palette(), () => panel.open())
  }
}

function isClosed(raw: string) {
  const fence = /^ {0,3}(`{3,}|~{3,})/.exec(raw)?.[1]
  if (!fence) return false
  const lines = raw.trimEnd().split("\n")
  if (lines.length < 2) return false
  const last = lines[lines.length - 1].trim()
  return last.length >= fence.length && last === fence[0].repeat(last.length)
}
