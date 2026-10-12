import { LuaError, LuaFunction, LuaLimitError, LuaState, LuaSyntaxError, LuaTable, tostring, type, type LuaValue } from "./lua"

/** Plain, serializable view data shared by every host. Handlers are ids: `{ onClick: { $h: "button:+" } }`. */
export type ViewNode = string | { t: string; p: Record<string, unknown>; c: ViewNode[]; k?: string }
export type Event = { handler: string; args?: unknown[] }
export type Render = { view: ViewNode[]; error?: string }

export type WidgetOptions = {
  seed?: number
  maxSteps?: number
  /** Clock for `next_frame` delays and `dt`. */
  now?: () => number
}

type Element = Exclude<ViewNode, string>
type Queued = { fn: LuaFunction; queuedAt: number; due: number }

const MAX_VIEW_NODES = 2000
const MAX_TEXT = 10_000
const MAX_LOG = 50
const MAX_DELAY = 60_000
const MAX_PASSES = 3

/**
 * One loaded widget program. Load runs the chunk once; `render` calls the global `frame()` to
 * build a view tree; `dispatch` runs `frame()` once with the event (output discarded) and then
 * renders cleanly. Every run is a transaction: if it throws, its writes are rolled back.
 */
export class Widget {
  readonly lua: LuaState
  /** The load error, if the chunk failed. A widget may still render if `frame` was defined first. */
  readonly loadError: string | undefined
  /** `print` output and warnings, newest last. */
  log: string[] = []
  private queue: Queued[] = []
  private now: () => number
  private build: Builder | undefined
  private hovered = new Set<string>()
  /** Whether the last frame asked `item_hovered()`; if not, hover changes need no new frame. */
  private hoverQueried = false

  constructor(source: string, options: WidgetOptions = {}) {
    this.now = options.now ?? Date.now
    this.lua = new LuaState({ seed: options.seed, maxSteps: options.maxSteps, print: (text) => this.warn(text) })
    this.install()
    this.loadError = this.attempt(() => this.lua.call(this.lua.load(source), []))
  }

  get hasFrame() {
    return this.lua.globals.get("frame") instanceof LuaFunction
  }

  /**
   * Builds the current view. On error, `view` holds what `frame()` drew before it failed.
   *
   * A frame that changes state (e.g. remembering `item_hovered()` to highlight a row drawn before
   * the check) runs again, so nothing waits for an unrelated event to catch up.
   */
  render(): Render {
    let result = this.frame(undefined)
    for (let pass = 1; pass < MAX_PASSES && !result.error && this.lua.writes > 0; pass++) result = this.frame(undefined)
    return result
  }

  /**
   * Delivers a click or slider change. Returns the new view, or an error (with all writes rolled
   * back) if the event frame failed.
   */
  dispatch(event: Event): Render {
    const handled = this.frame(event)
    if (handled.error) return handled
    return this.render()
  }

  /**
   * Sets the elements under the mouse: the innermost one and its containers, as ids. Returns a new
   * view when that changes something the program asked about, otherwise undefined.
   */
  hover(ids: string[]): Render | undefined {
    if (ids.length === this.hovered.size && ids.every((id) => this.hovered.has(id))) return undefined
    this.hovered = new Set(ids)
    if (!this.hoverQueried) return undefined
    return this.render()
  }

  /** When the earliest queued `next_frame` callback is due, or undefined when nothing is queued. */
  get nextDue() {
    if (this.queue.length === 0) return undefined
    return Math.min(...this.queue.map((q) => q.due))
  }

  /**
   * Runs the `next_frame` callbacks that are due, each at most once; callbacks they queue wait for
   * the next frame. Returns the error of the first failing callback (its writes are rolled back).
   */
  runQueued(): { ran: boolean; error?: string } {
    const now = this.now()
    const due = this.queue.filter((q) => q.due <= now)
    if (due.length === 0) return { ran: false }
    this.queue = this.queue.filter((q) => q.due > now)
    const failed = due
      .map((q) => this.attempt(() => this.lua.call(q.fn, [now - q.queuedAt])))
      .find((error) => error !== undefined)
    return { ran: true, error: failed }
  }

  private frame(event: Event | undefined): Render {
    const frame = this.lua.globals.get("frame")
    if (!(frame instanceof LuaFunction)) return { view: [], error: "the program must define a global function frame()" }
    const build = new Builder(event)
    this.build = build
    const error = this.attempt(() => this.lua.call(frame, []))
    this.build = undefined
    this.hoverQueried = build.hoverQueried
    const unclosed = build.close()
    if (unclosed && !error) this.warn(`${unclosed} was not closed`)
    return { view: build.root.c, error }
  }

  /** Runs `body` as a transaction; returns its error message, if any. */
  private attempt(body: () => void): string | undefined {
    const queue = this.queue
    try {
      this.lua.transaction(body)
      return undefined
    } catch (error) {
      this.queue = queue
      if (error instanceof LuaError) return typeof error.value === "string" ? error.value : error.message
      if (error instanceof LuaSyntaxError) return error.message
      throw error
    }
  }

  private warn(text: string) {
    this.log = [...this.log.slice(-(MAX_LOG - 1)), text]
  }

  private builder(name: string) {
    if (!this.build) throw new LuaError(`${name}() can only be called while frame() runs`)
    return this.build
  }

  private install() {
    const define = (name: string, f: (args: LuaValue[]) => LuaValue[] | LuaValue) => this.lua.define(name, f)

    define("text", (args) => {
      const options = args.length > 1 && args[args.length - 1] instanceof LuaTable ? (args.pop() as LuaTable) : undefined
      const content = args.map(tostring).join("")
      const build = this.builder("text")
      build.add({
        t: "text",
        p: style(options),
        c: [content.length > MAX_TEXT ? content.slice(0, MAX_TEXT) + "…" : content],
        k: build.id("text", "", options?.get("key")),
      })
      return []
    })

    define("button", ([label, options]) => {
      const build = this.builder("button")
      const text = tostring(label)
      const opts = options instanceof LuaTable ? options : undefined
      const disabled = opts?.get("disabled") === true
      const id = build.id("button", text, opts?.get("key"))
      build.add({ t: "button", p: { onClick: { $h: id }, ...(disabled ? { disabled } : {}) }, c: [text], k: id })
      return !disabled && build.consume(id) !== undefined
    })

    define("slider", ([value, min, max, step, options]) => {
      const build = this.builder("slider")
      const lo = num(min, 0, "slider", 2)
      const hi = Math.max(lo, num(max, 100, "slider", 3))
      const inc = num(step, 1, "slider", 4)
      if (inc <= 0) throw new LuaError("bad argument #4 to 'slider' (step must be positive)")
      const current = clamp(num(value, lo, "slider", 1), lo, hi)
      const opts = options instanceof LuaTable ? options : undefined
      const id = build.id("slider", "", opts?.get("key"))
      const width = opts?.get("width")
      build.add({
        t: "slider",
        p: { value: current, min: lo, max: hi, step: inc, onChange: { $h: id }, ...(typeof width === "number" ? { width } : {}) },
        c: [],
        k: id,
      })
      const event = build.consume(id)
      if (!event) return current
      const raw = Number(event.args?.[0])
      if (!Number.isFinite(raw)) return current
      return clamp(lo + Math.round((raw - lo) / inc) * inc, lo, hi)
    })

    define("progress", ([value, max, options]) => {
      const opts = options instanceof LuaTable ? options : undefined
      const width = opts?.get("width")
      const build = this.builder("progress")
      build.add({
        t: "progress",
        p: { value: num(value, 0, "progress", 1), max: num(max, 100, "progress", 2), ...style(opts), ...(typeof width === "number" ? { width } : {}) },
        c: [],
        k: build.id("progress", "", opts?.get("key")),
      })
      return []
    })

    define("divider", () => {
      const build = this.builder("divider")
      build.add({ t: "divider", p: {}, c: [], k: build.id("divider", "", undefined) })
      return []
    })

    for (const kind of ["row", "col"]) {
      define(`begin_${kind}`, ([options]) => {
        const opts = options instanceof LuaTable ? options : undefined
        const p: Record<string, unknown> = {}
        const gap = opts?.get("gap")
        if (typeof gap === "number") p.gap = gap
        const padding = opts?.get("padding")
        if (typeof padding === "number") p.padding = Math.max(0, Math.min(4, padding))
        if (opts?.get("border") === true) p.border = true
        const build = this.builder(`begin_${kind}`)
        build.open({ t: kind, p, c: [], k: build.id(kind, "", opts?.get("key")) })
        return []
      })
      define(`end_${kind}`, () => {
        this.builder(`end_${kind}`).end(kind)
        return []
      })
    }

    define("item_hovered", () => {
      const build = this.builder("item_hovered")
      build.hoverQueried = true
      return build.lastId !== undefined && this.hovered.has(build.lastId)
    })

    define("next_frame", ([fn, ms]) => {
      if (!(fn instanceof LuaFunction)) throw new LuaError(`bad argument #1 to 'next_frame' (function expected, got ${fn === undefined ? "no value" : type(fn)})`)
      const delay = clamp(num(ms, 0, "next_frame", 2), 0, MAX_DELAY)
      // Each function runs at most once per frame: queueing it again keeps the existing entry.
      if (this.queue.some((q) => q.fn === fn)) return []
      const now = this.now()
      this.queue = [...this.queue, { fn, queuedAt: now, due: now + delay }]
      return []
    })
  }
}

/** Accumulates the view tree for one `frame()` call and resolves control ids against the event. */
class Builder {
  root: Element = { t: "root", p: {}, c: [] }
  private stack: Element[] = [this.root]
  private nodes = 0
  private seen = new Map<string, number>()
  private consumed = false
  /** The id of the last element drawn, or of the container just closed: what `item_hovered()` asks about. */
  lastId: string | undefined
  hoverQueried = false

  constructor(private event: Event | undefined) {}

  add(node: Element) {
    if (++this.nodes > MAX_VIEW_NODES) throw new LuaLimitError(`the view has more than ${MAX_VIEW_NODES} nodes`)
    this.stack[this.stack.length - 1].c.push(node)
    this.lastId = node.k
  }

  open(node: Element) {
    this.add(node)
    this.stack.push(node)
  }

  end(kind: string) {
    const top = this.stack[this.stack.length - 1]
    if (top.t !== kind) throw new LuaError(this.stack.length === 1 ? `end_${kind}() without begin_${kind}()` : `end_${kind}() closes a begin_${top.t}()`)
    this.stack.pop()
    this.lastId = top.k
  }

  /** Closes containers left open; returns a description of the first one, if any. */
  close() {
    const open = this.stack.length > 1 ? `begin_${this.stack[1].t}()` : undefined
    this.stack = [this.root]
    return open
  }

  /**
   * `button:+`, `button:+#1` for the second "+", or `button:x@42` when a key is given. Text and
   * containers pass no label (`text#3`) so changing content keeps the same id.
   */
  id(kind: string, label: string, key: LuaValue) {
    const base = label ? `${kind}:${label}` : kind
    if (key !== undefined) return `${base}@${tostring(key)}`
    const count = this.seen.get(base) ?? 0
    this.seen.set(base, count + 1)
    return count === 0 ? base : `${base}#${count}`
  }

  /** The event, if it targets `id` and no earlier control has taken it. */
  consume(id: string) {
    if (this.consumed || this.event?.handler !== id) return undefined
    this.consumed = true
    return this.event
  }
}

function style(options: LuaTable | undefined) {
  const p: Record<string, unknown> = {}
  if (!options) return p
  if (options.get("bold") === true) p.bold = true
  if (options.get("dim") === true) p.dim = true
  const color = options.get("color")
  if (typeof color === "string") p.color = color
  return p
}

function num(v: LuaValue, fallback: number, name: string, n: number) {
  if (v === undefined) return fallback
  if (typeof v === "number" && !Number.isNaN(v)) return v
  throw new LuaError(`bad argument #${n} to '${name}' (number expected, got ${type(v)})`)
}

function clamp(v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, v))
}
