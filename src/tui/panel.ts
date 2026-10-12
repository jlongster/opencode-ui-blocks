import { BoxRenderable, TextAttributes, TextRenderable, type MouseEvent, type RenderContext } from "@opentui/core"
import type { UiFence } from "../index"
import { controllerFor } from "./controller"
import { UiBlockRenderable, type UiPalette } from "./renderable"

export const PANEL = "ui-blocks"

/** An app as the panel needs it: which controller holds its state, and its fence settings. */
export type PanelApp = { key: string; frame: UiFence.Frame }

let shown: PanelApp | undefined
const listeners = new Set<() => void>()

/** Which app the side panel shows. Shared by the transcript cards and the panel itself. */
export const panelApps = {
  get shown() {
    return shown
  },
  show(app: PanelApp) {
    if (shown?.key === app.key && shown.frame === app.frame) return
    shown = app
    listeners.forEach((listener) => listener())
  },
  subscribe(listener: () => void) {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
}

/** The side panel's content: the shown app, filling the panel. */
export class PanelAppRenderable extends BoxRenderable {
  private unsubscribe: () => void
  /** What is drawn now; null until the first update (undefined means "no app"). */
  private current: string | undefined | null = null

  constructor(
    ctx: RenderContext,
    private palette: () => UiPalette,
    private directory: () => string,
  ) {
    super(ctx, { width: "100%", height: "100%", flexDirection: "column", padding: 1 })
    this.unsubscribe = panelApps.subscribe(() => this.update())
    this.update()
  }

  private update() {
    const app = panelApps.shown
    const key = app ? `${app.key}\n${app.frame.title ?? ""}` : undefined
    if (this.isDestroyed || key === this.current) return
    this.current = key
    this.getChildren().forEach((child) => child.destroyRecursively())
    if (!app) {
      this.add(new TextRenderable(this.ctx, { content: "No app yet. Ask for a ```ui lua widget.", fg: this.palette().muted }))
      return
    }
    // The panel sizes the app; the fence's size= only applies inline.
    const frame = { ...app.frame, width: "auto" as const, height: "auto" as const }
    this.add(new UiBlockRenderable(this.ctx, controllerFor(app.key), frame, this.palette(), this.directory, { fill: true }))
  }

  protected override destroySelf() {
    this.unsubscribe()
    super.destroySelf()
  }
}

/**
 * Stands in for a ```ui block in the transcript when apps open in the side panel. Clicking it
 * shows that app in the panel again.
 */
export class AppCardRenderable extends BoxRenderable {
  private unsubscribe: () => void
  private status: TextRenderable
  private action: TextRenderable
  private shownText = ""

  constructor(
    ctx: RenderContext,
    private app: PanelApp,
    private streaming: boolean,
    private palette: UiPalette,
    private open: () => void,
  ) {
    super(ctx, {
      border: true,
      borderStyle: "rounded",
      borderColor: palette.border,
      title: ` ${app.frame.title ?? "App"} `,
      flexDirection: "row",
      gap: 2,
      paddingLeft: 1,
      paddingRight: 1,
      marginTop: 1,
      width: "100%",
    })
    this.status = new TextRenderable(ctx, { content: "", fg: palette.muted, flexGrow: 1, flexShrink: 1 })
    this.action = new TextRenderable(ctx, { content: "", fg: palette.accent, attributes: TextAttributes.BOLD, selectable: false, flexShrink: 0 })
    this.action.onMouseDown = (event: MouseEvent) => {
      if (event.button !== 0) return
      event.stopPropagation()
      panelApps.show(this.app)
      this.open()
    }
    this.add(this.status)
    this.add(this.action)
    this.unsubscribe = panelApps.subscribe(() => this.update())
    this.update()
  }

  private update() {
    if (this.isDestroyed) return
    const showing = panelApps.shown?.key === this.app.key
    const status = this.streaming ? "streaming into the side panel…" : showing ? "running in the side panel" : "app"
    const action = showing ? "[ Show panel ]" : "[ Open in panel ]"
    if (this.shownText === status + action) return
    this.shownText = status + action
    this.status.content = status
    this.action.content = action
  }

  protected override destroySelf() {
    this.unsubscribe()
    super.destroySelf()
  }
}
