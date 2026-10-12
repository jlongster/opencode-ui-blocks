# opencode-ui-blocks

Interactive widgets in the OpenCode TUI. The model writes a small Lua program in a
` ```ui lua ` fence; the plugin runs it in its own interpreter and draws it as a live widget with
buttons, sliders, progress bars, images and animation, while the reply is still streaming.

````
```ui lua title="Counter"
local count = 0

function frame()
  text("Count: ", count)
  begin_row()
    if button("+") then count = count + 1 end
    if button("Reset") then count = 0 end
  end_row()
end
```
````

## Install

Add the plugin to your OpenCode config:

```json
{ "plugins": ["/path/to/opencode-ui-blocks"] }
```

- **TUI side** (`tui.js`, built from `src/tui/plugin.ts`): registers a markdown code block renderer
  for `ui` fences and a `session.panel` slot.
- **Server side** (`server.ts`): registers a `ui-blocks` skill containing [`spec.md`](./spec.md),
  so the model can look up how to write widgets when one would help.

## Where apps appear

By default an app runs in the **right-hand session panel**. When a reply starts streaming a
` ```ui ` block, the plugin opens the panel and the app streams into it; the transcript shows a
card ("running in the side panel") whose button brings that app back later. Apps from history
only show their card and never take the panel over. Opening the panel automatically hands the
keyboard back to the prompt, so you can keep typing.

To render apps inline in the transcript instead, set the option on the plugin's entry in the
**TUI** config (TUI plugin options are read from there):

```json
{ "plugins": [{ "package": "/path/to/opencode-ui-blocks", "options": { "display": "inline" } }] }
```

## Layout

| Path | What |
| --- | --- |
| `src/lua/` | Lua 5.1-style interpreter: lexer, parser, resolver, closure compiler, standard library (string patterns, `string.format`, `table`, `math`). No dependencies. |
| `src/widget.ts` | Widget runtime: `frame()`, controls and their ids, events, `item_hovered()`, `next_frame`, rollback of failed runs, limits. Produces a plain view tree. |
| `src/stream.ts` | Closes a partially streamed program so it can render before the fence ends. |
| `src/fence.ts` | Reads `size=` and `title=` from the fence line. |
| `src/tui/` | Plugin entry, OpenTUI renderable (fiber reconciler, mouse handling), the per-block controller, the side panel and transcript card, and the image loader. |
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

- Code block renderers are not told which message a block is in, so a block is identified by its
  source. Two identical blocks in one session share their state.
- Mouse only: there is no text input yet.
- Controls become clickable once the fence closes; while streaming the widget is a preview.
- An app that arrives already complete (e.g. a very fast stream) counts as history: it shows its
  card, and its button opens it in the panel.
