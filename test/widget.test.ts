import { describe, expect, test } from "bun:test"
import { UiStream, UiWidget } from "../src"

const stopwatch = `local ms, running = 0, false

function frame()
  text(string.format("Time: %.1fs", ms / 1000))
  begin_row()
    if button(running and "Stop" or "Start") then
      running = not running
      if running then next_frame(advance) end
    end
    if button("Reset") then ms, running = 0, false end
  end_row()
end

function advance(dt)
  if not running then return end
  ms = ms + dt
  next_frame(advance)
end
`

function textOf(nodes: UiWidget.ViewNode[]): string {
  return nodes.map((node) => (typeof node === "string" ? node : node.t === "button" ? `[${textOf(node.c)}]` : textOf(node.c))).join(" ")
}

function mount(source: string) {
  const clock = { now: 0 }
  const widget = new UiWidget.Widget(source, { now: () => clock.now })
  expect(widget.loadError).toBeUndefined()
  return { widget, clock, text: () => textOf(widget.render().view) }
}

describe("widget", () => {
  test("clicks run frame() with the event, then render cleanly", () => {
    const { widget, text } = mount(`local n = 0
function frame()
  text("n=", n)
  if button("+") then n = n + 1 end
end`)
    expect(text()).toBe("n=0 [+]")
    const render = widget.dispatch({ handler: "button:+" })
    expect(textOf(render.view)).toBe("n=1 [+]")
  })

  test("same labels are told apart by draw order, keys override it, and the first match consumes", () => {
    const { widget } = mount(`function frame()
  button("x") button("x") button("x", {key = "k"})
end`)
    const view = widget.render().view as Exclude<UiWidget.ViewNode, string>[]
    expect(view.map((node) => (node.p.onClick as { $h: string }).$h)).toEqual(["button:x", "button:x#1", "button:x@k"])
  })

  test("item_hovered asks about the last element drawn, or the container just closed", () => {
    const { widget } = mount(`function frame()
  text("title")
  if item_hovered() then text("title hovered") end
  for _, name in ipairs({"a", "b"}) do
    begin_row({key = name})
      text(name)
      button("x", {key = name})
      if item_hovered() then text("x on " .. name) end
    end_row()
    if item_hovered() then text("row " .. name) end
  end
end`)
    const shown = (render: UiWidget.Render | undefined) => textOf(render!.view)
    expect(shown(widget.render())).toBe("title a [x] b [x]")
    expect(shown(widget.hover(["text"]))).toBe("title title hovered a [x] b [x]")
    // The mouse over b's text: the text and its row are hovered.
    expect(shown(widget.hover(["text#2", "row@b"]))).toBe("title a [x] b [x] row b")
    expect(shown(widget.hover(["button:x@a", "row@a"]))).toBe("title a [x] x on a row a b [x]")
    expect(widget.hover(["button:x@a", "row@a"])).toBeUndefined()
    expect(shown(widget.hover([]))).toBe("title a [x] b [x]")
  })

  test("state remembered from item_hovered shows on the same hover change", () => {
    const { widget } = mount(`local hot
function frame()
  for _, name in ipairs({"a", "b"}) do
    begin_row({key = name})
      text(hot == name and "> " .. name or name)
    end_row()
    if item_hovered() then hot = name end
  end
end`)
    expect(textOf(widget.render().view)).toBe("a b")
    expect(textOf(widget.hover(["text#1", "row@b"])!.view)).toBe("a > b")
  })

  test("frames that only build temporary tables render once, and frames that always write stop", () => {
    const counted = mount(`renders = 0
function frame()
  renders = renders + 1
  local parts = {}
  for i = 1, 3 do parts[#parts + 1] = i end
  text(table.concat(parts, ","))
end`)
    counted.widget.render()
    // One write per frame (the counter) keeps it going, up to the pass limit.
    expect(counted.widget.lua.globals.get("renders")).toBe(3)
    const quiet = mount(`local tip = 5
function frame()
  local parts = {}
  parts[1] = "x"
  tip = slider(tip, 0, 10)
  text(parts[1])
end`)
    quiet.widget.render()
    expect(quiet.widget.lua.writes).toBe(0)
  })

  test("hover changes cost nothing when the program never asks", () => {
    const { widget } = mount(`function frame() button("x") end`)
    widget.render()
    expect(widget.hover(["button:x"])).toBeUndefined()
  })

  test("sliders snap the event value to the step and range", () => {
    const { widget, text } = mount(`local v = 10
function frame() v = slider(v, 0, 30, 5) text("v=", v) end`)
    widget.dispatch({ handler: "slider", args: [17.4] })
    expect(text()).toBe(" v=15")
    widget.dispatch({ handler: "slider", args: [99] })
    expect(text()).toBe(" v=30")
  })

  test("a failing event is rolled back and reported", () => {
    const { widget, text } = mount(`local items = {1}
function frame()
  text(#items)
  if button("add") then table.insert(items, 2) error("nope") end
end`)
    const render = widget.dispatch({ handler: "button:add" })
    expect(render.error).toBe("line 4: nope")
    expect(text()).toBe("1 [add]")
  })

  test("next_frame runs callbacks with dt, once per frame, and stops when they stop requeueing", () => {
    const { widget, clock, text } = mount(stopwatch)
    expect(widget.nextDue).toBeUndefined()
    widget.dispatch({ handler: "button:Start" })
    expect(widget.nextDue).toBe(0)
    for (let i = 0; i < 5; i++) {
      clock.now += 100
      expect(widget.runQueued().ran).toBe(true)
    }
    expect(text()).toContain("Time: 0.5s")
    widget.dispatch({ handler: "button:Stop" })
    clock.now += 100
    widget.runQueued()
    expect(widget.nextDue).toBeUndefined()
    expect(text()).toContain("Time: 0.5s")
  })

  test("next_frame delays wait for the clock", () => {
    const { widget, clock, text } = mount(`local n = 0
function frame() text(n) end
function tick() n = n + 1 next_frame(tick, 100) end
next_frame(tick, 100)`)
    clock.now = 50
    expect(widget.runQueued().ran).toBe(false)
    clock.now = 100
    expect(widget.runQueued().ran).toBe(true)
    expect(text()).toBe("1")
    expect(widget.nextDue).toBe(200)
  })

  test("a failing callback is rolled back, including what it queued", () => {
    const { widget, clock, text } = mount(`local n = 0
function frame() text(n) end
function tick() n = n + 1 next_frame(tick) error("bad") end
next_frame(tick)`)
    clock.now = 10
    expect(widget.runQueued()).toEqual({ ran: true, error: "line 3: bad" })
    expect(text()).toBe("0")
    expect(widget.nextDue).toBeUndefined()
  })

  test("containers pass gap, padding (clamped) and border to the view", () => {
    const { widget } = mount(`function frame() begin_col({gap = 1, padding = 9, border = true}) text("x") end_col() end`)
    expect((widget.render().view[0] as { p: unknown }).p).toEqual({ gap: 1, padding: 4, border: true })
  })

  test("image names a URL or file and leaves loading to the host", () => {
    const { widget } = mount(`function frame()
  image("https://example.com/cat.png", {width = 30, fit = "cover"})
  image("./shots/a.png", {height = 500})
end`)
    expect(widget.render().view).toEqual([
      { t: "image", p: { src: "https://example.com/cat.png", width: 30, fit: "cover" }, c: [], k: "image" },
      { t: "image", p: { src: "./shots/a.png", height: 60 }, c: [], k: "image#1" },
    ])
    expect(mount(`function frame() image("javascript:alert(1)") end`).widget.render().error).toBe(
      "line 1: bad argument #1 to 'image' (an http(s) URL or a file path expected)",
    )
    expect(mount(`function frame() image("a.png", {fit = "zoom"}) end`).widget.render().error).toContain("bad option 'fit'")
  })

  test("layout containers nest, auto-close with a warning, and mismatches are errors", () => {
    const { widget } = mount(`function frame() begin_row() text("a") begin_col() text("b") end`)
    const view = widget.render().view
    expect(JSON.stringify(view)).toBe('[{"t":"row","p":{},"c":[{"t":"text","p":{},"c":["a"],"k":"text"},{"t":"col","p":{},"c":[{"t":"text","p":{},"c":["b"],"k":"text#1"}],"k":"col"}],"k":"row"}]')
    expect(widget.log).toEqual(["begin_row() was not closed"])
    const bad = mount(`function frame() begin_row() end_col() end`)
    expect(bad.widget.render().error).toBe("line 1: end_col() closes a begin_row()")
  })

  test("an error keeps what frame() drew before it", () => {
    const { widget } = mount(`function frame() text("before") missing() text("after") end`)
    const render = widget.render()
    expect(textOf(render.view)).toBe("before")
    expect(render.error).toBe("line 1: attempt to call a nil value (global 'missing')")
  })

  test("UI functions only work inside frame()", () => {
    const widget = new UiWidget.Widget(`text("hi") function frame() end`)
    expect(widget.loadError).toBe("line 1: text() can only be called while frame() runs")
  })

  test("view size is limited", () => {
    const { widget } = mount(`function frame() for i = 1, 5000 do text(i) end end`)
    expect(widget.render().error).toContain("more than 2000 nodes")
  })

  test("print goes to the log", () => {
    const { widget } = mount(`print("loaded", 1) function frame() end`)
    expect(widget.log).toEqual(["loaded\t1"])
  })
})

describe("streaming", () => {
  test("every prefix of a program parses after closing, and the UI grows as it streams", () => {
    const counts: number[] = []
    for (let end = 1; end <= stopwatch.length; end++) {
      const closed = UiStream.closePrefix(stopwatch.slice(0, end))
      if (closed === undefined) continue
      const widget = new UiWidget.Widget(closed)
      counts.push(widget.hasFrame ? textOf(widget.render().view).length : 0)
    }
    expect(counts.length).toBeGreaterThan(stopwatch.length * 0.9)
    expect(Math.max(...counts)).toBe(counts.at(-1)!)
    expect(textOf(new UiWidget.Widget(UiStream.closePrefix(stopwatch, true)!).render().view)).toBe("Time: 0.0s [Start] [Reset]")
  })

  test("the frame body renders element by element while it streams", () => {
    const upTo = (needle: string) => {
      const closed = UiStream.closePrefix(stopwatch.slice(0, stopwatch.indexOf(needle)))!
      return textOf(new UiWidget.Widget(closed).render().view)
    }
    expect(upTo("  begin_row()")).toBe("Time: 0.0s")
    expect(upTo('    if button("Reset")')).toBe("Time: 0.0s [Start]")
  })

  test("open tables, strings and repeat blocks are closed or backed off", () => {
    expect(UiStream.closePrefix('local t = {\n  "a",\n  "b')).toBe('local t = {\n  "a",\n}')
    expect(UiStream.closePrefix("repeat\n  x = 1\n")).toBe("repeat\n  x = 1\n\nuntil true")
    expect(UiStream.closePrefix("local s = [[\nunfinished")).toBe("")
  })

  test("a final source that does not parse is not repaired", () => {
    expect(UiStream.closePrefix("function frame()\n", true)).toBeUndefined()
  })
})
