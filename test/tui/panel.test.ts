import { afterEach, expect, test } from "bun:test"
import { BoxRenderable, createMarkdownCodeBlockRenderer, MarkdownRenderable, RGBA, SyntaxStyle } from "@opentui/core"
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing"
import { createUiBlockRenderer } from "../../src/tui/block"
import { PanelAppRenderable, panelApps } from "../../src/tui/panel"

let setup: TestRendererSetup | undefined
afterEach(() => setup?.renderer.destroy())

const color = RGBA.fromHex("#ffffff")
const palette = () => ({ text: color, muted: color, accent: color, error: color, border: color })

/** The transcript on the left, and the host's session panel (here a plain box) on the right. */
async function mount() {
  setup = await createTestRenderer({ width: 100, height: 24, useMouse: true })
  const opened: number[] = []
  const layout = new BoxRenderable(setup.renderer, { flexDirection: "row", width: "100%", height: "100%" })
  const markdown = new MarkdownRenderable(setup.renderer, {
    syntaxStyle: SyntaxStyle.create(),
    streaming: true,
    internalBlockMode: "top-level",
    width: 50,
    renderNode: createMarkdownCodeBlockRenderer({
      ui: createUiBlockRenderer(setup.renderer, palette, undefined, { open: () => opened.push(Date.now()) }),
    }),
  })
  const panel = new BoxRenderable(setup.renderer, { width: 50, height: "100%" })
  panel.add(new PanelAppRenderable(setup.renderer, palette, () => process.cwd()))
  layout.add(markdown)
  layout.add(panel)
  setup.renderer.root.add(layout)
  const write = async (text: string) => {
    markdown.content = text
    await setup!.renderOnce()
  }
  return { setup: setup!, write, opened }
}

async function frameWith(predicate: (frame: string) => boolean) {
  const deadline = Date.now() + 3000
  for (;;) {
    await setup!.renderOnce()
    const frame = setup!.captureCharFrame()
    if (predicate(frame)) return frame
    if (Date.now() > deadline) throw new Error(`Timed out waiting for frame:\n${frame}`)
    await Bun.sleep(10)
  }
}

test("an empty panel says how to get an app", async () => {
  setup = await createTestRenderer({ width: 60, height: 6 })
  setup.renderer.root.add(new PanelAppRenderable(setup.renderer, palette, () => "/"))
  await frameWith((frame) => frame.includes("No app yet"))
})

const counter = (title: string) =>
  `\`\`\`ui lua title="${title}"\nlocal n = 0\nfunction frame()\n  text("${title} n=", n)\n  if button("bump ${title}") then n = n + 1 end\nend\n\`\`\`\n`

test("a streaming app opens the panel, runs there, and the transcript shows a card", async () => {
  const { write, opened } = await mount()
  const app = counter("Alpha")
  // Cut partway into the next line, as a live stream would be.
  await write("Here:\n" + app.slice(0, app.indexOf("button(")))
  // Mid-stream: the panel already shows what has arrived; the transcript has only a card.
  const streaming = await frameWith((frame) => frame.includes("Alpha n=0") && frame.includes("streaming into the side panel"))
  expect(opened.length).toBeGreaterThan(0)
  expect(streaming.split("\n").find((line) => line.includes("Alpha n=0"))!.indexOf("Alpha n=0")).toBeGreaterThan(50)

  await write("Here:\n" + app + "\nDone.")
  const live = await frameWith((frame) => frame.includes("[ bump Alpha ]") && frame.includes("running in the side panel"))
  // The finished app is interactive in the panel.
  const y = live.split("\n").findIndex((line) => line.includes("[ bump Alpha ]"))
  const x = live.split("\n")[y].indexOf("[ bump Alpha ]")
  await setup!.mockMouse.click(x + 2, y)
  await frameWith((frame) => frame.includes("Alpha n=1"))
})

test("apps from history show a card but leave the panel alone, until their card is clicked", async () => {
  const { write } = await mount()
  const beta = counter("Beta")
  await write(beta.slice(0, beta.indexOf("button(")))
  await write(beta + "\nok")
  await frameWith((frame) => frame.includes("Beta n=0"))
  const before = panelApps.shown
  // A finished app arriving as history (no streaming phase) does not take the panel.
  await write(counter("Beta") + "\nok\n\n" + counter("Gamma"))
  const frame = await frameWith((frame) => frame.includes("Gamma") && frame.includes("[ Open in panel ]"))
  expect(panelApps.shown).toBe(before)
  expect(frame).not.toContain("Gamma n=0")

  const lines = frame.split("\n")
  const y = lines.findLastIndex((line) => line.includes("[ Open in panel ]"))
  await setup!.mockMouse.click(lines[y].indexOf("[ Open in panel ]") + 2, y)
  await frameWith((frame) => frame.includes("Gamma n=0"))
})
