# opencode-ui-blocks

Interactive apps in the OpenCode TUI. The model calls the `ui_app` tool with a small Lua program;
the plugin runs it in its own interpreter and shows it in the right-hand session panel: buttons,
sliders, progress bars, images, hover and animation.

```json
{
  "title": "Counter",
  "program": {
    "lua": "local count = 0\nfunction frame()\n  text(\"Count: \", count)\n  if button(\"+\") then count = count + 1 end\nend"
  }
}
```

## Install

Add the plugin to your OpenCode config:

```json
{ "plugins": ["/path/to/opencode-ui-blocks"] }
```

- **Server side** (`server.ts`): registers the `ui_app` tool. Its description is [`spec.md`](./spec.md),
  the language and API reference. The tool loads the program and draws a first frame; if that fails,
  the error goes back to the model so it can fix the program and call again.
- **TUI side** (`tui.js`, built from `src/tui/plugin.ts`): watches the session's tool events, opens
  the session panel when a `ui_app` call starts, and runs the app there. The transcript shows the
  call as one line (`✓ ui_app [title=Counter]`), not the program.

## Using it

- A new app opens the panel on its own and leaves the keyboard with the prompt.
- Each call is its own app with its own state. **Open UI app…** in the command palette lists the
  session's apps (newest first) and reopens one, with its state if it ran in this TUI.
- The panel can be resized and made fullscreen like any session panel.

## Layout

| Path | What |
| --- | --- |
| `src/lua/` | Lua 5.1-style interpreter: lexer, parser, resolver, closure compiler, standard library (string patterns, `string.format`, `table`, `math`). No dependencies. |
| `src/widget.ts` | Widget runtime: `frame()`, controls and their ids, events, `item_hovered()`, `next_frame`, rollback of failed runs, limits. Produces a plain view tree. |
| `src/stream.ts` | Closes a partially written program so it can render before it is complete. |
| `src/fence.ts` | Frame size and title types. |
| `src/tui/` | Plugin entry (tool events, panel slot, palette command), the panel, the OpenTUI renderable (fiber reconciler, mouse handling), the per-app controller and the image loader. |
| `spec.md` | The language and API reference given to the model. |

## Development

The plugin must use the host's `@opentui/core`: renderables from another copy cannot join the
host's tree (OpenTUI throws "remove expects a renderable child object"). Two rules keep it that way:

- **The TUI side ships as one bundled file**, `tui.js`, with `@opentui/core` external. OpenCode
  redirects `@opentui/core` to its own copy only for imports in the entry file, not for files it
  imports. Run `bun run build` after changing `src/`; a test fails if `tui.js` is stale.
- **No host packages in `node_modules`.** `server.ts` has no runtime imports, and the packages used
  for types and tests are linked into `.dev/node_modules` (mapped in `tsconfig.json`), where the
  runtime never looks.

```bash
OPENCODE_REPO=/path/to/opencode bun run dev:link   # links .dev/node_modules
bun run build
bun test
bun run typecheck
```

## Images

`image(src)` accepts `http(s)` URLs and file paths (relative to the session's directory). The
program only names the image; the TUI side fetches or reads it (16 MB limit, 15 s timeout, small
cache) and draws it with OpenTUI: kitty graphics or sixel where the terminal supports them,
coloured half-blocks elsewhere. URLs are fetched as soon as the widget renders.

## Known limits

- **Apps appear once the model has finished writing them.** OpenCode streams a tool call's input to
  the server but only publishes it to clients when it is complete, so the panel says "Writing the
  app…" until then. The TUI side already consumes `session.tool.input.delta` events, so apps will
  build up live as soon as OpenCode publishes them.
- Mouse only: there is no text input yet.
- The model does not see what the user does in an app.
