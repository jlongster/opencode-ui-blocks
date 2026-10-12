import { BoxRenderable, TextRenderable, type RenderContext } from "@opentui/core"
import { controllerFor } from "./controller"
import { partialString } from "./partial-json"
import { UiBlockRenderable, type UiPalette } from "./renderable"

export const PANEL = "ui-blocks"
export const TOOL = "ui_app"

/** One `ui_app` tool call. Its id keys the controller, so each call keeps its own state. */
export type App = { id: string; sessionID: string; title: string; input: string; done: boolean }

const apps = new Map<string, App>()
const selected = new Map<string, string>()
const listeners = new Set<() => void>()
const notify = () => listeners.forEach((listener) => listener())

/**
 * The apps the model has opened, fed by the tool call's input as it streams: `begin` on
 * `session.tool.input.started`, `delta` per fragment, `finish` once the input is complete.
 */
export const panelApps = {
  get(id: string) {
    return apps.get(id)
  },
  selected(sessionID: string) {
    const id = selected.get(sessionID)
    return id === undefined ? undefined : apps.get(id)
  },
  select(sessionID: string, id: string) {
    if (selected.get(sessionID) === id) return
    selected.set(sessionID, id)
    notify()
  },
  begin(sessionID: string, id: string) {
    if (!apps.has(id)) apps.set(id, { id, sessionID, title: "App", input: "", done: false })
    if (selected.get(sessionID) === id) return notify()
    this.select(sessionID, id)
  },
  delta(id: string, delta: string) {
    const app = apps.get(id)
    if (!app || app.done) return
    app.input += delta
    sync(app)
  },
  /** The complete input: raw JSON text, or the parsed object from a finished or stored call. */
  finish(sessionID: string, id: string, input: string | Record<string, unknown>) {
    const app = apps.get(id) ?? { id, sessionID, title: "App", input: "", done: false }
    apps.set(id, app)
    const parsed = typeof input === "string" ? parse(input) : input
    if (!parsed) return
    app.input = JSON.stringify(parsed)
    app.done = true
    sync(app)
    notify()
  },
  subscribe(listener: () => void) {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
}

/** Pushes what has arrived of an app's input into its controller. */
function sync(app: App) {
  const title = partialString(app.input, "title")
  const changed = title !== undefined && title !== app.title
  if (title !== undefined) app.title = title
  const lua = partialString(app.input, "lua")
  if (lua === undefined) return changed ? notify() : undefined
  const controller = controllerFor(app.id)
  const first = controller.source === "" && lua !== ""
  // Mid-stream the source is a prefix; the controller closes it off and previews it.
  controller.update(lua, app.done)
  if (changed || first) notify()
}

function parse(text: string) {
  try {
    const value: unknown = JSON.parse(text)
    return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

/** The side panel's content for one session: its selected app, filling the panel. */
export class PanelAppRenderable extends BoxRenderable {
  private unsubscribe: () => void
  /** What is drawn now; null until the first update (undefined means "no app"). */
  private current: string | undefined | null = null

  constructor(
    ctx: RenderContext,
    private sessionID: string,
    private palette: () => UiPalette,
    private directory: () => string,
  ) {
    super(ctx, { width: "100%", height: "100%", flexDirection: "column", padding: 1 })
    this.unsubscribe = panelApps.subscribe(() => this.update())
    this.update()
  }

  private update() {
    const app = panelApps.selected(this.sessionID)
    // OpenCode only hands a tool its input once the model has finished writing it.
    const writing = app !== undefined && !app.done && partialString(app.input, "lua") === undefined
    const key = app ? `${app.id}\n${app.title}\n${writing}` : undefined
    if (this.isDestroyed || key === this.current) return
    this.current = key
    this.getChildren().forEach((child) => child.destroyRecursively())
    if (!app) {
      this.add(new TextRenderable(this.ctx, { content: "No app in this session yet.", fg: this.palette().muted }))
      return
    }
    if (writing) {
      this.add(new TextRenderable(this.ctx, { content: "Writing the app…", fg: this.palette().muted }))
      return
    }
    const frame = { width: "auto" as const, height: "auto" as const, title: app.title }
    this.add(new UiBlockRenderable(this.ctx, controllerFor(app.id), frame, this.palette(), this.directory, { fill: true }))
  }

  protected override destroySelf() {
    this.unsubscribe()
    super.destroySelf()
  }
}
