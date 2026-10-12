/** How a widget's frame is sized and titled. */
export type Frame = {
  /** Width in cells, or "auto" to fill the available width. */
  width: number | "auto"
  /** Height in cells, or "auto" to fit the content (up to MAX_HEIGHT). */
  height: number | "auto"
  title?: string
}

export const MAX_HEIGHT = 60
