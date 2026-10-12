import {
  BoxRenderable,
  TextAttributes,
  TextRenderable,
  type MouseEvent,
  type RGBA,
  type RenderContext,
  type Renderable,
} from "@opentui/core"
import { UiFence, type UiWidget } from "../index"
import type { UiController } from "./controller"

export type UiPalette = {
  text: RGBA
  muted: RGBA
  accent: RGBA
  error: RGBA
  border: RGBA
}

type Element = Exclude<UiWidget.ViewNode, string>

/**
 * One mounted view node. Like a React fiber it outlives renders: event handlers read `node` when
 * they fire, so a button pressed before an update and released after it still clicks.
 */
type Fiber = {
  node: UiWidget.ViewNode
  view: Renderable
  children: Fiber[]
  /** Last value written per property, so unchanged properties are never touched. */
  applied: Map<string, unknown>
  interactive: boolean
  /** Laid out in a row (shrinks sideways and wraps) rather than a column (keeps its height). */
  inRow: boolean
  armed: boolean
  dragging: boolean
}

/**
 * The bordered frame for one ui block. Markdown recreates it on every streamed delta; once the
 * block is complete it persists, and controller updates are reconciled into it in place.
 */
export class UiBlockRenderable extends BoxRenderable {
  private detach: () => void
  private fibers: Fiber[] = []
  /** The view node id each renderable shows, for reporting hover. */
  private ids = new WeakMap<Renderable, string>()
  private hoverSeq = 0

  constructor(
    ctx: RenderContext,
    private controller: UiController,
    frame: UiFence.Frame,
    private palette: UiPalette,
  ) {
    super(ctx, {
      border: true,
      borderStyle: "rounded",
      title: frame.title ? ` ${frame.title} ` : undefined,
      height: frame.height,
      maxHeight: frame.height === "auto" ? UiFence.MAX_HEIGHT : undefined,
      width: frame.width === "auto" ? "100%" : frame.width,
      maxWidth: "100%",
      flexDirection: "column",
      paddingLeft: 1,
      paddingRight: 1,
      overflow: "hidden",
    })
    this.detach = controller.attach(() => this.update())
    this.onSizeChange = () => this.caption()
    // Over and out bubble up from the innermost renderable, so the frame sees every hover change.
    this.onMouseOver = (event: MouseEvent) => {
      this.hoverSeq++
      this.controller.hover(this.idsFrom(event.target))
    }
    this.onMouseOut = () => {
      // Moving between elements sends out then over; only clear when the mouse left the block.
      const seq = this.hoverSeq
      queueMicrotask(() => {
        if (seq === this.hoverSeq && !this.isDestroyed) this.controller.hover([])
      })
    }
    this.update()
  }

  /** The bottom border carries status; OpenTUI drops a title wider than the frame, so fit it. */
  private caption() {
    const diagnostic = this.controller.diagnostic
    const text = diagnostic ? `⚠ ${diagnostic}` : this.controller.interactive ? undefined : "streaming…"
    const room = Math.max(4, (this.width || 40) - 6)
    const fitted = text && text.length > room ? text.slice(0, room - 1) + "…" : text
    const title = fitted ? ` ${fitted} ` : undefined
    if (this.bottomTitle !== title) this.bottomTitle = title
  }

  private update() {
    if (this.isDestroyed) return
    const interactive = this.controller.interactive
    const diagnostic = this.controller.diagnostic
    this.borderColor = diagnostic ? this.palette.error : interactive ? this.palette.border : this.palette.muted
    this.caption()
    // The border only has room for a shortened error, so the full text goes in the body too.
    const view: UiWidget.ViewNode[] = diagnostic
      ? [...this.controller.view, { t: "text", p: { color: "error" }, c: [diagnostic], k: "__error" }]
      : this.controller.view
    this.fibers = this.reconcile(this, this.fibers, view, interactive)
    this.requestRender()
  }

  /**
   * Matches new nodes to existing fibers by key (`{#each}` items) or position, and by type.
   * Matches are patched in place; everything else is mounted fresh or destroyed.
   */
  private reconcile(parent: Renderable, old: Fiber[], nodes: UiWidget.ViewNode[], interactive: boolean, inRow = false) {
    const unmatched = new Map(old.map((fiber, i) => [identity(fiber.node, i), fiber]))
    const next = nodes.map((node, i) => {
      const id = identity(node, i)
      const fiber = unmatched.get(id)
      if (!fiber || typeOf(fiber.node) !== typeOf(node)) return this.mount(node, interactive, inRow)
      unmatched.delete(id)
      fiber.inRow = inRow
      this.patch(fiber, node, interactive)
      return fiber
    })
    unmatched.forEach((fiber) => fiber.view.destroyRecursively())
    next.forEach((fiber, i) => {
      if (parent.getChildren()[i] !== fiber.view) parent.add(fiber.view, i)
    })
    return next
  }

  private mount(node: UiWidget.ViewNode, interactive: boolean, inRow: boolean): Fiber {
    const fiber: Fiber = {
      node,
      view: this.create(node),
      children: [],
      applied: new Map(),
      interactive,
      inRow,
      armed: false,
      dragging: false,
    }
    if (typeof node !== "string" && node.k !== undefined) this.ids.set(fiber.view, node.k)
    if (typeof node !== "string" && node.t === "button") this.listenButton(fiber)
    if (typeof node !== "string" && node.t === "slider") this.listenSlider(fiber)
    this.patch(fiber, node, interactive)
    return fiber
  }

  private create(node: UiWidget.ViewNode): Renderable {
    if (typeof node === "string" || isLeaf(node.t))
      // Controls must not start a text selection when pressed.
      return new TextRenderable(this.ctx, {
        content: "",
        selectable: typeof node === "string" || !["button", "slider"].includes(node.t),
      })
    return new BoxRenderable(this.ctx, {})
  }

  /** Writes only the properties whose value changed since the last patch. */
  private patch(fiber: Fiber, node: UiWidget.ViewNode, interactive: boolean) {
    fiber.node = node
    fiber.interactive = interactive
    const palette = this.palette
    const set = (key: string, value: unknown, apply: () => void) => {
      if (fiber.applied.has(key) && fiber.applied.get(key) === value) return
      fiber.applied.set(key, value)
      apply()
    }

    if (typeof node === "string") {
      const text = fiber.view as TextRenderable
      set("content", node, () => (text.content = node))
      set("fg", palette.text, () => (text.fg = palette.text))
      set("wrap", "word", () => (text.wrapMode = "word"))
      return
    }

    if (!isLeaf(node.t)) {
      const box = fiber.view as BoxRenderable
      const row = node.t === "row"
      set("direction", row, () => (box.flexDirection = row ? "row" : "column"))
      set("align", row, () => (box.alignItems = row ? "center" : "stretch"))
      set("shrink", 0, () => (box.flexShrink = 0))
      const gap = numberOf(node.p.gap, row ? 1 : 0)
      set("gap", gap, () => (box.gap = gap))
      const padding = numberOf(node.p.padding, 0)
      set("padding", padding, () => (box.padding = padding))
      const border = node.p.border === true
      set("border", border, () => {
        // Setting borderStyle turns the border on, so only style it when it is wanted.
        box.border = border
        if (!border) return
        box.borderStyle = "rounded"
        box.borderColor = palette.border
      })
      fiber.children = this.reconcile(box, fiber.children, node.c, interactive, row)
      return
    }

    const text = fiber.view as TextRenderable
    const leaf = this.leaf(fiber, node)
    set("content", leaf.content, () => (text.content = leaf.content))
    set("fg", leaf.fg, () => (text.fg = leaf.fg))
    set("attributes", leaf.attributes, () => (text.attributes = leaf.attributes))
    set("wrap", leaf.wrap, () => (text.wrapMode = leaf.wrap))
    set("width", leaf.width, () => (text.width = leaf.width ?? "auto"))
    set("height", leaf.height, () => (text.height = leaf.height ?? "auto"))
    set("shrink", leaf.shrink, () => (text.flexShrink = leaf.shrink))
  }

  /** How a leaf element looks for its current props. */
  private leaf(fiber: Fiber, node: Element) {
    const palette = this.palette
    if (node.t === "button") {
      const enabled = buttonEnabled(fiber, node)
      return {
        content: `[ ${textOf(node.c)} ]`,
        fg: enabled ? palette.accent : palette.muted,
        attributes: TextAttributes.BOLD | (fiber.armed ? TextAttributes.INVERSE : 0),
        wrap: "word" as const,
        shrink: 0,
      }
    }
    if (node.t === "slider") {
      const slider = sliderOf(node)
      return {
        // While dragging, the thumb follows the mouse; ignore values from in-flight runs.
        content: fiber.dragging ? String(fiber.applied.get("content")) : drawSlider(slider, slider.value),
        fg: fiber.interactive && slider.handler ? palette.accent : palette.muted,
        attributes: 0,
        wrap: "none" as const,
        width: slider.width,
        height: 1,
        shrink: 0,
      }
    }
    if (node.t === "progress") {
      const width = numberOf(node.p.width, 20)
      const ratio = Math.min(1, Math.max(0, numberOf(node.p.value, 0) / numberOf(node.p.max, 100)))
      const filled = Math.round(ratio * width)
      return {
        content: "█".repeat(filled) + "░".repeat(width - filled),
        fg: colorOf(node.p.color, palette) ?? palette.accent,
        attributes: 0,
        wrap: "none" as const,
        height: 1,
        shrink: 0,
      }
    }
    if (node.t === "divider")
      return { content: "─".repeat(200), fg: palette.border, attributes: 0, wrap: "none" as const, height: 1, shrink: fiber.inRow ? 1 : 0 }
    return {
      content: textOf(node.c),
      fg: colorOf(node.p.color, palette) ?? (node.p.dim ? palette.muted : palette.text),
      attributes: (node.p.bold ? TextAttributes.BOLD : 0) | (node.p.dim ? TextAttributes.DIM : 0),
      wrap: "word" as const,
      // In a column, shrinking would collapse lines that do not fit onto their neighbours; clip instead.
      shrink: fiber.inRow ? 1 : 0,
    }
  }

  // Arm on press and fire on a matching release, so a drag that starts elsewhere never clicks.
  private listenButton(fiber: Fiber) {
    const text = fiber.view as TextRenderable
    const repaint = () => this.patch(fiber, fiber.node, fiber.interactive)
    text.onMouseDown = (event: MouseEvent) => {
      if (event.button !== 0 || typeof fiber.node === "string" || !buttonEnabled(fiber, fiber.node)) return
      event.stopPropagation()
      fiber.armed = true
      repaint()
    }
    text.onMouseUp = (event: MouseEvent) => {
      if (!fiber.armed) return
      fiber.armed = false
      repaint()
      if (event.button !== 0 || typeof fiber.node === "string" || !buttonEnabled(fiber, fiber.node)) return
      event.stopPropagation()
      // Read the handler now: the button may have been re-rendered since it was pressed.
      const handler = handlerOf(fiber.node.p.onClick)
      if (handler) this.controller.dispatch({ handler })
    }
  }

  private listenSlider(fiber: Fiber) {
    const text = fiber.view as TextRenderable
    const move = (event: MouseEvent, done: boolean, dragging = false) => {
      if (event.button !== 0 || typeof fiber.node === "string") return
      const slider = sliderOf(fiber.node)
      if (!fiber.interactive || !slider.handler) return
      event.stopPropagation()
      const ratio = Math.min(1, Math.max(0, (event.x - text.x) / (slider.width - 1)))
      const raw = slider.min + ratio * (slider.max - slider.min)
      const value = Math.min(slider.max, Math.max(slider.min, Math.round(raw / slider.step) * slider.step))
      const content = drawSlider(slider, value)
      fiber.applied.set("content", content)
      text.content = content
      // Only a real drag pins the thumb; a press whose release gets lost must not freeze it.
      fiber.dragging = dragging && !done
      this.controller.dispatch({ handler: slider.handler, args: [value] })
    }
    text.onMouseDown = (event: MouseEvent) => move(event, false)
    text.onMouseDrag = (event: MouseEvent) => move(event, false, true)
    // The final release can arrive as a drag end or as a plain mouse-up.
    text.onMouseDragEnd = (event: MouseEvent) => move(event, true)
    text.onMouseUp = (event: MouseEvent) => move(event, true)
  }

  /** Ids of the hovered renderable and its containers, innermost first. */
  private idsFrom(target: Renderable | null) {
    const out: string[] = []
    for (let view = target; view && view !== this; view = view.parent) {
      const id = this.ids.get(view)
      if (id) out.push(id)
    }
    return out
  }

  protected override destroySelf() {
    this.detach()
    super.destroySelf()
  }
}

function identity(node: UiWidget.ViewNode, index: number) {
  return typeof node !== "string" && node.k !== undefined ? `k:${node.k}` : `#${index}`
}

function typeOf(node: UiWidget.ViewNode) {
  return typeof node === "string" ? "#text" : node.t
}

function isLeaf(type: string) {
  return ["text", "button", "slider", "progress", "divider"].includes(type)
}

function buttonEnabled(fiber: Fiber, node: Element) {
  return fiber.interactive && handlerOf(node.p.onClick) !== undefined && node.p.disabled !== true
}

function sliderOf(node: Element) {
  const min = numberOf(node.p.min, 0)
  return {
    min,
    max: Math.max(min + 1, numberOf(node.p.max, 100)),
    step: numberOf(node.p.step, 1),
    width: Math.max(5, numberOf(node.p.width, 24)),
    value: numberOf(node.p.value, min),
    handler: handlerOf(node.p.onChange),
  }
}

function drawSlider(slider: ReturnType<typeof sliderOf>, value: number) {
  const position = Math.round(((value - slider.min) / (slider.max - slider.min)) * (slider.width - 1))
  return "━".repeat(position) + "●" + "─".repeat(slider.width - 1 - position)
}

function textOf(children: UiWidget.ViewNode[]): string {
  return children.map((child) => (typeof child === "string" ? child : textOf(child.c))).join("")
}

function numberOf(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback
}

function handlerOf(value: unknown) {
  if (value && typeof value === "object" && "$h" in value && typeof value.$h === "string") return value.$h
  return undefined
}

function colorOf(value: unknown, palette: UiPalette) {
  if (value === "muted") return palette.muted
  if (value === "accent") return palette.accent
  if (value === "error") return palette.error
  return undefined
}
