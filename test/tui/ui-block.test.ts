import { afterEach, expect, test } from "bun:test"
import { createMarkdownCodeBlockRenderer, ImageRenderable, MarkdownRenderable, RGBA, SyntaxStyle, TextRenderable, type Renderable } from "@opentui/core"
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing"
import { createUiBlockRenderer } from "../../src/tui/block"

const widget = `Here you go:

\`\`\`ui lua size=40x8 title="Tip"
-- {ID}
local tip = 18

function frame()
  begin_row()
    text("Tip ", tip, "%")
  end_row()
  for _, pct in ipairs({10, 20}) do
    if button(pct .. "%") then tip = pct end
  end
  tip = slider(tip, 0, 30, 1, {width = 31})
end
\`\`\`

Anything else?`

let setup: TestRendererSetup | undefined
afterEach(() => setup?.renderer.destroy())

async function mount(id: string) {
  setup = await createTestRenderer({ width: 60, height: 20, useMouse: true })
  const color = RGBA.fromHex("#ffffff")
  const markdown = new MarkdownRenderable(setup.renderer, {
    syntaxStyle: SyntaxStyle.create(),
    streaming: true,
    internalBlockMode: "top-level",
    // The host builds renderNode from registered code block renderers in exactly this way.
    renderNode: createMarkdownCodeBlockRenderer({
      ui: createUiBlockRenderer(setup.renderer, () => ({ text: color, muted: color, accent: color, error: color, border: color })),
    }),
  })
  setup.renderer.root.add(markdown)
  // Blocks are identified by their source, so each test gets its own copy of shared fixtures.
  const write = async (text: string) => {
    markdown.content = text.replace("{ID}", id)
    await setup!.renderOnce()
  }
  return { setup, write }
}

// Animations run on timers, so wait in real time rather than for a fixed number of passes.
async function frameWith(setup: TestRendererSetup, predicate: (frame: string) => boolean) {
  const deadline = Date.now() + 3000
  for (;;) {
    await setup.renderOnce()
    const frame = setup.captureCharFrame()
    if (predicate(frame)) return frame
    if (Date.now() > deadline) throw new Error(`Timed out waiting for frame:\n${frame}`)
    await Bun.sleep(10)
  }
}

function texts(root: Renderable, out = new Map<string, Renderable>()) {
  if (root instanceof TextRenderable) out.set(root.plainText, root)
  root.getChildren().forEach((child) => texts(child, out))
  return out
}

const find = (frame: string, needle: string) => {
  const y = frame.split("\n").findIndex((line) => line.includes(needle))
  return { x: frame.split("\n")[y].indexOf(needle), y }
}

test("a streamed ui block renders progressively and becomes interactive when closed", async () => {
  const { setup, write } = await mount("prt_stream")

  // Stream a prefix that ends mid-element: the frame and completed parts already render.
  await write(widget.slice(0, widget.indexOf("  for _, pct")))
  const preview = await frameWith(setup, (frame) => frame.includes("Tip 18%"))
  expect(preview).toContain("streaming…")

  await write(widget)
  const live = await frameWith(setup, (frame) => frame.includes("[ 20% ]") && !frame.includes("streaming…"))
  const button = find(live, "[ 20% ]")
  await setup.mockMouse.click(button.x + 2, button.y)
  await frameWith(setup, (frame) => frame.includes("Tip 20%"))
})

test("dragging the slider updates state", async () => {
  const { setup, write } = await mount("prt_slider")
  await write(widget)
  const frame = await frameWith(setup, (frame) => frame.includes("●"))
  const thumb = find(frame, "●")
  // The slider spans 0..30 over 31 cells, so each cell is one step.
  await setup.mockMouse.drag(thumb.x, thumb.y, thumb.x + 5, thumb.y)
  await frameWith(setup, (frame) => frame.includes("Tip 23%"))
})

test("state survives the markdown being recreated (e.g. scrolled away and back)", async () => {
  const first = await mount("prt_remount")
  await first.write(widget)
  const live = await frameWith(first.setup, (frame) => frame.includes("[ 10% ]") && !frame.includes("streaming…"))
  const button = find(live, "[ 10% ]")
  await first.setup.mockMouse.click(button.x + 2, button.y)
  await frameWith(first.setup, (frame) => frame.includes("Tip 10%"))
  first.setup.renderer.destroy()

  const second = await mount("prt_remount")
  await second.write(widget)
  await frameWith(second.setup, (frame) => frame.includes("Tip 10%"))
})

test("next_frame animates the block on its own", async () => {
  const { setup, write } = await mount("prt_tick")
  await write(
    'Clock:\n\n```ui lua size=30x4 title="Clock"\nlocal frames = 0\nfunction frame() text("frames ", frames) end\nfunction tick() frames = frames + 1 next_frame(tick) end\nnext_frame(tick)\n```\n',
  )
  await frameWith(setup, (frame) => /frames [3-9]/.test(frame))
})

test("a click held across animation ticks still lands (buttons are patched, not rebuilt)", async () => {
  const { setup, write } = await mount("prt_hold")
  await write(
    '```ui lua size=36x5 title="Anim"\nlocal n, playing = 0, true\nfunction frame()\n  text("frame ", n)\n  if button(playing and "Pause" or "Play") then\n    playing = not playing\n    if playing then next_frame(tick) end\n  end\nend\nfunction tick()\n  if not playing then return end\n  n = n + 1\n  next_frame(tick)\nend\nnext_frame(tick)\n```\n',
  )
  const live = await frameWith(setup, (frame) => frame.includes("[ Pause ]") && /frame [2-9]/.test(frame))
  const button = find(live, "[ Pause ]")
  await setup.mockMouse.pressDown(button.x + 2, button.y)
  // Several ticks re-render the widget while the button is held.
  const before = find(await frameWith(setup, () => true), "frame ")
  await Bun.sleep(300)
  await setup.renderOnce()
  expect(setup.captureCharFrame().split("\n")[before.y]).not.toEqual(live.split("\n")[before.y])
  await setup.mockMouse.release(button.x + 2, button.y)
  const paused = await frameWith(setup, (frame) => frame.includes("[ Play ]"))
  const frozen = paused.split("\n")[before.y]
  await Bun.sleep(200)
  await setup.renderOnce()
  expect(setup.captureCharFrame().split("\n")[before.y]).toEqual(frozen)
})

test("keyed list items keep their renderables when the list reorders", async () => {
  const { setup, write } = await mount("prt_keys")
  await write(
    '```ui lua size=30x6 title="List"\nlocal items = {"a", "b", "c"}\nfunction frame()\n  for _, item in ipairs(items) do text("item ", item, {key = item}) end\n  if button("Flip") then flip() end\nend\nfunction flip()\n  local r = {}\n  for i = #items, 1, -1 do r[#r + 1] = items[i] end\n  items = r\nend\n```\n',
  )
  const live = await frameWith(setup, (frame) => frame.includes("[ Flip ]"))
  const before = texts(setup.renderer.root)
  const button = find(live, "[ Flip ]")
  await setup.mockMouse.click(button.x + 2, button.y)
  const flipped = await frameWith(setup, (frame) => frame.indexOf("item c") < frame.indexOf("item a"))
  expect(flipped.indexOf("item b")).toBeGreaterThan(flipped.indexOf("item c"))
  const after = texts(setup.renderer.root)
  // Same renderable objects, moved rather than recreated.
  expect(["item a", "item b", "item c"].map((label) => after.get(label) === before.get(label))).toEqual([true, true, true])
})

test("without a size the frame grows to fit, and a frame that is too small clips instead of overlapping", async () => {
  const lines = 'function frame()\n  text("GET api.example.com")\n  for i = 1, 12 do text("line ", i) end\n  text("footer")\nend'
  const { setup, write } = await mount("prt_height")
  await write("```ui lua title=\"Tall\"\n" + lines + "\n```\n")
  const tall = await frameWith(setup, (frame) => frame.includes("footer"))
  expect(tall).toContain("line 12")

  await write("```ui lua size=40x6 title=\"Short\"\n" + lines + "\n```\n")
  const short = await frameWith(setup, (frame) => frame.includes("Short") && frame.includes("line 1"))
  const rows = short.split("\n").filter((row) => row.includes("│"))
  // Each visible row holds exactly one line of the program, in order.
  expect(rows.map((row) => row.replace(/[│\s]+/g, " ").trim())).toEqual(["GET api.example.com", "line 1", "line 2", "line 3"])
})

test("item_hovered follows the mouse, including a list row's children", async () => {
  const { setup, write } = await mount("prt_hover")
  await write(
    '```ui lua title="Hover"\nlocal hot\nfunction frame()\n  local any = false\n  for _, name in ipairs({"alpha", "beta"}) do\n    begin_row({key = name})\n      text(hot == name and "> " .. name or name)\n      button("open", {key = name})\n    end_row()\n    if item_hovered() then hot, any = name, true end\n  end\n  if not any then hot = nil end\n  text("over: ", hot or "none")\nend\n```\n',
  )
  const live = await frameWith(setup, (frame) => frame.includes("over: none") && frame.includes("[ open ]"))
  const beta = find(live, "beta")
  await setup.mockMouse.moveTo(beta.x + 1, beta.y)
  const overBeta = await frameWith(setup, (frame) => frame.includes("> beta") && frame.includes("over: beta"))
  // Moving onto a row's button keeps that row hovered (find returns alpha's, the first).
  const button = find(overBeta, "[ open ]")
  await setup.mockMouse.moveTo(button.x + 2, button.y)
  await frameWith(setup, (frame) => frame.includes("> alpha") && !frame.includes("> beta"))
  await setup.mockMouse.moveTo(0, 19)
  await frameWith(setup, (frame) => frame.includes("over: none") && !frame.includes("> "))
})

test("identical blocks share one widget, and both stay live", async () => {
  const { setup, write } = await mount("prt_twins")
  const block = '```ui lua title="Twin"\nlocal n = 0\nfunction frame()\n  text("n=", n)\n  if button("bump") then n = n + 1 end\nend\n```\n'
  await write(block + "\nand again:\n\n" + block)
  const live = await frameWith(setup, (frame) => frame.split("n=0").length === 3)
  const button = find(live, "[ bump ]")
  await setup.mockMouse.click(button.x + 2, button.y)
  await frameWith(setup, (frame) => frame.split("n=1").length === 3)
})

test("a blank line separates the widget from the paragraph above it", async () => {
  const { setup, write } = await mount("prt_gap")
  await write('Here you go:\n```ui lua title="Gap"\nfunction frame() text("inside") end\n```\n')
  const frame = await frameWith(setup, (frame) => frame.includes("inside"))
  const lines = frame.split("\n")
  const intro = lines.findIndex((line) => line.includes("Here you go:"))
  expect(lines[intro + 1].trim()).toBe("")
  expect(lines[intro + 2]).toContain("Gap")
})

function findImage(root: Renderable): ImageRenderable | undefined {
  if (root instanceof ImageRenderable) return root
  return root.getChildren().map(findImage).find((image) => image !== undefined)
}

test("image() shows a local file (relative to the session) and an http URL, sized to the image", async () => {
  const png = await Bun.file(new URL("../fixtures/checker.png", import.meta.url)).bytes()
  const server = Bun.serve({ port: 0, fetch: (request) => (new URL(request.url).pathname === "/checker.png" ? new Response(png) : new Response("no", { status: 404 })) })
  try {
    for (const src of ["test/fixtures/checker.png", `http://127.0.0.1:${server.port}/checker.png`]) {
      const { setup, write } = await mount(`prt_image_${src.length}`)
      await write(`\`\`\`ui lua title="Pic"\nfunction frame() image("${src}", {width = 20}) text("below") end\n\`\`\`\n`)
      await frameWith(setup, () => findImage(setup.renderer.root)?.image != null)
      const box = findImage(setup.renderer.root)!.parent!
      // 16x8 pixels at 20 cells wide keeps its 2:1 shape (cells are about twice as tall as wide).
      expect(box.width).toBe(20)
      expect(box.height).toBeGreaterThan(2)
      expect(box.height).toBeLessThan(10)
      await frameWith(setup, (frame) => frame.includes("below"))
      setup.renderer.destroy()
    }
  } finally {
    server.stop(true)
  }
})

test("image() failures show in place without breaking the widget", async () => {
  const server = Bun.serve({ port: 0, fetch: () => new Response("no", { status: 404 }) })
  try {
    const { setup, write } = await mount("prt_image_errors")
    await write(
      `\`\`\`ui lua title="Broken"\nfunction frame()\n  image("http://127.0.0.1:${server.port}/missing.png")\n  image("no/such/file.png")\n  text("still here")\nend\n\`\`\`\n`,
    )
    const frame = await frameWith(setup, (frame) => frame.includes("HTTP 404") && frame.includes("file not found"))
    expect(frame).toContain("still here")
  } finally {
    server.stop(true)
  }
})
