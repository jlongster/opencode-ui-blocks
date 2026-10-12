import { afterEach, describe, expect, test } from "bun:test"
import { BoxRenderable, RGBA } from "@opentui/core"
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing"
import { PanelAppRenderable, panelApps } from "../../src/tui/panel"
import { partialString } from "../../src/tui/partial-json"

let setup: TestRendererSetup | undefined
afterEach(() => setup?.renderer.destroy())

const color = RGBA.fromHex("#ffffff")
const palette = () => ({ text: color, muted: color, accent: color, error: color, border: color })

/** The host's session panel for one session, here a plain box. */
async function mountPanel(sessionID: string) {
  setup = await createTestRenderer({ width: 60, height: 16, useMouse: true })
  const panel = new BoxRenderable(setup.renderer, { width: "100%", height: "100%" })
  panel.add(new PanelAppRenderable(setup.renderer, sessionID, palette, () => process.cwd()))
  setup.renderer.root.add(panel)
  return setup
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

const counter = (name: string) =>
  JSON.stringify({
    title: `${name} counter`,
    program: { lua: `local n = 0\nfunction frame()\n  text("${name} n=", n)\n  if button("bump ${name}") then n = n + 1 end\nend` },
  })

/** Feeds a tool call's JSON input in small fragments, as session.tool.input.delta events would. */
function stream(sessionID: string, id: string, json: string, upTo = json.length) {
  panelApps.begin(sessionID, id)
  for (let i = 0; i < upTo; i += 7) panelApps.delta(id, json.slice(i, Math.min(i + 7, upTo)))
}

test("a ui_app call streams into the panel and becomes interactive when its input is complete", async () => {
  await mountPanel("ses_a")
  const json = counter("Alpha")
  // Partway into the button line: the title and the first line are already showing.
  stream("ses_a", "call_alpha", json, json.indexOf("if button"))
  const streaming = await frameWith((frame) => frame.includes("Alpha counter") && frame.includes("Alpha n=0"))
  expect(streaming).toContain("streaming…")

  panelApps.delta("call_alpha", json.slice(json.indexOf("if button")))
  panelApps.finish("ses_a", "call_alpha", json)
  const live = await frameWith((frame) => frame.includes("[ bump Alpha ]") && !frame.includes("streaming…"))
  const y = live.split("\n").findIndex((line) => line.includes("[ bump Alpha ]"))
  await setup!.mockMouse.click(live.split("\n")[y].indexOf("[ bump Alpha ]") + 2, y)
  await frameWith((frame) => frame.includes("Alpha n=1"))
})

test("each call keeps its own state, and the panel shows the session's selected app", async () => {
  await mountPanel("ses_b")
  stream("ses_b", "call_one", counter("Same"))
  panelApps.finish("ses_b", "call_one", counter("Same"))
  const first = await frameWith((frame) => frame.includes("[ bump Same ]"))
  const y = first.split("\n").findIndex((line) => line.includes("[ bump Same ]"))
  await setup!.mockMouse.click(first.split("\n")[y].indexOf("[ bump Same ]") + 2, y)
  await frameWith((frame) => frame.includes("Same n=1"))

  // An identical second call is a separate app with fresh state.
  stream("ses_b", "call_two", counter("Same"))
  panelApps.finish("ses_b", "call_two", counter("Same"))
  await frameWith((frame) => frame.includes("Same n=0"))

  // Reopening the first one (e.g. from the "Open UI app…" picker) brings its state back.
  panelApps.select("ses_b", "call_one")
  await frameWith((frame) => frame.includes("Same n=1"))
})

test("until the input arrives, the panel says the app is being written", async () => {
  await mountPanel("ses_w")
  panelApps.begin("ses_w", "call_writing")
  await frameWith((frame) => frame.includes("Writing the app…"))
  panelApps.finish("ses_w", "call_writing", counter("Late"))
  await frameWith((frame) => frame.includes("[ bump Late ]"))
})

test("apps from history open from their stored input", async () => {
  await mountPanel("ses_c")
  panelApps.finish("ses_c", "call_old", JSON.parse(counter("Old")))
  panelApps.select("ses_c", "call_old")
  await frameWith((frame) => frame.includes("Old counter") && frame.includes("[ bump Old ]"))
})

test("a session without apps says so, and other sessions' apps stay out of its panel", async () => {
  stream("ses_other", "call_elsewhere", counter("Elsewhere"))
  await mountPanel("ses_empty")
  const frame = await frameWith((frame) => frame.includes("No app in this session yet."))
  expect(frame).not.toContain("Elsewhere")
})

describe("partialString", () => {
  test.each([
    ['{"title":"Sto', "title", "Sto"],
    ['{"title":"Stopwatch","program":{"lua":"local n', "lua", "local n"],
    ['{"program":{"lua":"a\\nb\\"c\\u00e9"}}', "lua", 'a\nb"cé'],
    ['{"lua":"half escape \\', "lua", "half escape "],
    ['{"lua":"half unicode \\u00', "lua", "half unicode "],
    ['{"title":', "title", undefined],
  ])("%s", (json, key, expected) => expect(partialString(json, key)).toBe(expected))
})
