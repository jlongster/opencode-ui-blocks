import { UiStream, UiWidget } from "../index"

/**
 * Owns one ui block's program instance and last good view.
 *
 * Markdown destroys and recreates custom renderables on every streaming delta, and transcript
 * rows unmount when scrolled away, so everything that must survive lives here instead.
 */
export class UiController {
  source = ""
  final = false
  view: UiWidget.ViewNode[] = []
  error: string | undefined
  private widget: UiWidget.Widget | undefined
  private viewJson = "[]"
  /** Every mounted renderable showing this block; identical blocks share one controller. */
  private listeners = new Set<() => void>()
  private timer: ReturnType<typeof setTimeout> | undefined
  private lastFrame = 0

  /** Reloads when the streamed source changes. While streaming, the program is closed off and previewed. */
  update(source: string, final: boolean) {
    if (source === this.source && final === this.final) return
    this.source = source
    this.final = final
    if (final) return this.load(source)
    const closed = UiStream.closePrefix(source)
    // Nothing parses yet (e.g. inside a long string); keep showing the last preview.
    if (closed === undefined) return
    this.load(closed)
  }

  /** Mouse events only count once the fence is closed; until then the view is a preview. */
  get interactive() {
    return this.final
  }

  get diagnostic() {
    return this.final ? this.error : undefined
  }

  dispatch(event: UiWidget.Event) {
    if (!this.final || !this.widget) return
    this.show(this.widget.dispatch(event), true)
    this.schedule()
  }

  /** The elements under the mouse, innermost first; only complete blocks track hover. */
  hover(ids: string[]) {
    if (!this.final || !this.widget) return
    const render = this.widget.hover(ids)
    if (render) this.show(render, false)
    this.schedule()
  }

  attach(listener: () => void) {
    this.listeners.add(listener)
    this.schedule()
    return () => {
      this.listeners.delete(listener)
      this.schedule()
    }
  }

  private load(source: string) {
    this.widget = new UiWidget.Widget(source)
    const render = this.widget.render()
    this.show({ view: render.view, error: this.widget.loadError ?? render.error }, false)
    this.schedule()
  }

  /**
   * Shows a render. A failed event or callback keeps the previous view (its writes were rolled
   * back); a failed render shows what it drew before the error.
   */
  private show(render: UiWidget.Render, keepOnError: boolean) {
    const error = render.error
    const view = error && keepOnError ? this.view : render.view
    const json = JSON.stringify(view)
    if (json === this.viewJson && error === this.error) return
    this.view = view
    this.viewJson = json
    this.error = error
    this.listeners.forEach((listener) => listener())
  }

  /**
   * Runs queued `next_frame` callbacks while the block is complete and on screen, at most one frame
   * per FRAME_MS. Scrolling the block away destroys its renderable, which detaches its listener and
   * pauses the queue; `dt` covers the gap when it resumes.
   */
  private schedule() {
    clearTimeout(this.timer)
    this.timer = undefined
    const due = this.widget?.nextDue
    if (!this.final || this.listeners.size === 0 || due === undefined) return
    const now = Date.now()
    this.timer = setTimeout(() => this.frame(), Math.max(0, due - now, this.lastFrame + FRAME_MS - now))
  }

  private frame() {
    this.timer = undefined
    const widget = this.widget
    if (!widget) return
    this.lastFrame = Date.now()
    const queued = widget.runQueued()
    if (queued.error) this.show({ view: this.view, error: queued.error }, true)
    else if (queued.ran) this.show(widget.render(), false)
    this.schedule()
  }
}

const FRAME_MS = 50
const MAX_CONTROLLERS = 200
const controllers = new Map<string, UiController>()

/**
 * Finds or creates the controller for a block, keeping the most recently used ones.
 *
 * Code block renderers are not told which message a block belongs to, so blocks are identified by
 * their source: the streaming block by its fence line, a closed block by its whole text. Identical
 * closed blocks therefore share state.
 */
export function controllerFor(key: string) {
  const existing = controllers.get(key)
  if (existing) {
    controllers.delete(key)
    controllers.set(key, existing)
    return existing
  }
  const created = new UiController()
  controllers.set(key, created)
  if (controllers.size > MAX_CONTROLLERS) controllers.delete(controllers.keys().next().value!)
  return created
}
