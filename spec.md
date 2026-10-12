# ui_app

Shows the user a small interactive app, written in Lua, in the side panel of their terminal.
Use it when something they can click, drag or watch would answer better than text: calculators,
converters, timers, small games, charts, checklists, dashboards and explainers.

Input: `title` (shown on the panel) and `program.lua` (the Lua source below). The app appears and
runs while you are still writing it, and you get back an error with a line number if it fails to
load or draw, so fix it and call again. You do not see what the user does in the app. Do not repeat
the program in your reply; say what the app does instead.

## Program shape

Write the program in this order, so the app can appear while it is still being written:

1. **State**: top-level `local` variables. They are set once, when the program loads.
2. **`function frame()`**: draws the UI. It runs again after every click, slider change and queued
   callback, and describes the UI as it is right now by calling the functions below in order.
3. **Helpers**: global `function`s, after `frame`. Do not use `local function` for helpers that
   come after `frame`: a `local` declared later is not in scope inside `frame`.

There are no event handlers: a control's function returns what the user did to it on this frame.

```lua
local count = 0

function frame()
  text("Count: ", count)
  begin_row()
    if button("+") then count = count + 1 end
    if button("Reset") then reset() end
  end_row()
end

function reset()
  count = 0
end
```

## UI functions (call them inside `frame`, in the order they should appear)

| Function | Shows | Returns |
| --- | --- | --- |
| `text(...)` | One line of text; the parts are converted with `tostring` and joined with no separator. A final table gives options: `{bold=true, dim=true, color="accent"/"muted"/"error", key=…}` | – |
| `button(label, opts)` | A button. `opts` (optional): `{disabled=true, key=…}` | `true` on the frame it was clicked |
| `slider(value, min, max, step)` | A slider showing `value` (`step` defaults to 1) | the new value: the dragged value on the frame it changed, otherwise `value` |
| `progress(value, max)` | A progress bar | – |
| `divider()` | A horizontal line | – |
| `image(src, opts)` | An image from an `http(s)` URL or a file path (relative paths start at the project directory). `opts` (optional): `{width=N` cells, default 40`, height=N` (default: the image's own proportions)`, fit="fit"/"cover"/"fill", key=…}` | – |
| `begin_row(opts)` … `end_row()` | Lays out what is drawn between them side by side. `opts` (optional): `{gap=N, padding=N, border=true, key=…}` | – |
| `begin_col(opts)` … `end_col()` | Lays out what is drawn between them vertically (same options) | – |
| `item_hovered()` | – | `true` while the mouse is over the element drawn just before it (after `end_row()`, the whole row, including what is inside it) |
| `next_frame(fn, ms)` | Queues `fn(dt)` to run before the next frame, or after `ms` milliseconds. `dt` is the milliseconds since it was queued | – |

Typical use:

```lua
if button("+") then count = count + 1 end
tip = slider(tip, 0, 30)
```

Buttons are told apart by their label. Give buttons that do different things different labels.
Buttons with the same label (for example a "x" on every row of a list) are told apart by the order
they are drawn in; when rows can be removed or reordered, pass a stable key:
`button("x", {key = item.id})`. Keys on `text` and `begin_row` also keep list rows steady on screen.

Hover is asked about, not handled: draw the element, then check it.

```lua
if button("Delete") then remove(item) end
if item_hovered() then text("removes it for good", {dim = true}) end
```

Images load in the background: the widget shows "loading image…" in their place, then the image
(full resolution in terminals with image support, coloured blocks elsewhere). A failed load shows
the reason in place. Use real image URLs you know exist (PNG, JPEG, WebP or GIF).

## Time and animation

Code runs only when something happens. To animate, queue a callback with `next_frame`. A callback
runs once; queue it again to keep going. Check your state first: a callback queued before the user
pressed Stop may still run once.

```lua
local ms, running = 0, false

function frame()
  text(string.format("Time: %.1fs", ms / 1000))
  if button(running and "Stop" or "Start") then
    running = not running
    if running then next_frame(advance) end
  end
end

function advance(dt)
  if not running then return end
  ms = ms + dt
  next_frame(advance)
end
```

For a fixed rate, pass a delay: `next_frame(step, 100)` runs `step` 100 ms later. Use `dt` instead of
assuming the delay was exact.

## Language

Lua 5.1: `local`, functions and closures, multiple assignment and returns, `...`, `if/elseif/else`,
`while`, numeric and generic `for`, `repeat … until`, `break`, tables, method calls (`s:upper()`).

Standard library:

- `string`: `format sub upper lower rep reverse len byte char find match gmatch gsub` (Lua patterns)
- `table`: `insert remove concat sort unpack`
- `math`: all functions and constants, `math.random` (seeded)
- `type tostring tonumber select error assert pcall print ipairs pairs next unpack`

Differences from standard Lua:

- One number type: `tostring(3.0)` is `"3"`. Format decimals with `string.format("%.2f", x)`.
- Strings are text: `#"✓"` is 1.
- `pairs` visits keys in insertion order.

Not available: metatables, coroutines, `goto`, `load`, `require`, `io`, `os`, `utf8`, `debug`, and
bitwise operators. Time reaches the program only through `next_frame`'s `dt`.
