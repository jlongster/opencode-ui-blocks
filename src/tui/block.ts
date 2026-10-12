import type { MarkdownCodeBlockRenderer, RenderContext } from "@opentui/core"
import { UiFence } from "../index"
import { controllerFor } from "./controller"
import { UiBlockRenderable, type UiPalette } from "./renderable"

/**
 * Renders ```ui fences as live widgets. Markdown calls this again on every streamed delta and
 * whenever it rebuilds the block (e.g. scrolled away and back); the controller keeps the state.
 */
export function createUiBlockRenderer(renderer: RenderContext, palette: () => UiPalette): MarkdownCodeBlockRenderer {
  return (token) => {
    const frame = UiFence.parseFence(token.lang ?? "")
    if (!frame) return undefined
    // Until the fence line ends, its size and title may still be streaming in.
    if (!token.raw.includes("\n")) return undefined
    const closed = isClosed(token.raw)
    const controller = controllerFor(closed ? `block:${Bun.hash(token.lang + "\n" + token.text)}` : `streaming:${token.lang}`)
    controller.update(token.text, closed)
    return new UiBlockRenderable(renderer, controller, frame, palette())
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
