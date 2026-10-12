export type Frame = {
  /** Width in cells, or "auto" to fill the available width. */
  width: number | "auto"
  /** Height in cells, or "auto" to fit the content (up to MAX_HEIGHT). */
  height: number | "auto"
  title?: string
}

const MAX_WIDTH = 200
export const MAX_HEIGHT = 60

/** Reads frame settings from a fence info string such as `ui lua size=52x14 title="Tip splitter"`. */
export function parseFence(info: string): Frame | undefined {
  const words = /^ui(?:\s+lua)?(?=\s|$)/.exec(info.trim())
  if (!words) return
  const settings = Object.fromEntries(
    [...info.trim().slice(words[0].length).matchAll(/([a-zA-Z]+)=("([^"]*)"|'([^']*)'|(\S+))/g)].map((match) => [
      match[1],
      match[3] ?? match[4] ?? match[5],
    ]),
  )
  // Models write `size=44x12`, `size=auto x32` or `size=44×12`; either side may be "auto".
  const size = /size=\s*(auto|\d+)\s*[xX×]\s*(auto|\d+)/.exec(info)
  return {
    width: !size || size[1] === "auto" ? "auto" : clamp(Number(size[1]), 10, MAX_WIDTH),
    height: !size || size[2] === "auto" ? "auto" : clamp(Number(size[2]), 1, MAX_HEIGHT),
    title: settings.title || undefined,
  }
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}
