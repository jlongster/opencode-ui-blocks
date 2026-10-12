# opencode-ui-blocks

Interactive widgets in the OpenCode TUI. The model writes a small Lua program in a
` ```ui lua ` fence; the plugin runs it in its own interpreter and draws it as a live widget with
buttons, sliders, progress bars and animation, while the reply is still streaming.

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

- **TUI side** (`tui.ts`): registers a markdown code block renderer for `ui` fences.
- **Server side** (`server.ts`): registers a `ui-blocks` skill containing [`spec.md`](./spec.md),
  so the model can look up how to write widgets when one would help.

## Layout

| Path | What |
| --- | --- |
| `src/lua/` | Lua 5.1-style interpreter: lexer, parser, resolver, closure compiler, standard library (string patterns, `string.format`, `table`, `math`). No dependencies. |
| `src/widget.ts` | Widget runtime: `frame()`, controls and their ids, events, `item_hovered()`, `next_frame`, rollback of failed runs, limits. Produces a plain view tree. |
| `src/stream.ts` | Closes a partially streamed program so it can render before the fence ends. |
| `src/fence.ts` | Reads `size=` and `title=` from the fence line. |
| `src/tui/` | OpenTUI renderable (fiber reconciler, mouse handling) and the per-block controller. |
| `spec.md` | The language and API reference given to the model. |

## Development

The plugin uses the host's `@opentui/core` and `@opencode/plugin` at runtime. For types and tests,
link them from an OpenCode checkout:

```bash
OPENCODE_REPO=/path/to/opencode bun run dev:link
bun test
bun run typecheck
```

## Known limits

- Code block renderers are not told which message a block is in, so a block is identified by its
  source. Two identical blocks in one session share their state.
- Mouse only: there is no text input yet.
- Controls become clickable once the fence closes; while streaming the widget is a preview.
