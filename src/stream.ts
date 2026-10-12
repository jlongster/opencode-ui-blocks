import { tokenize } from "./lua/lexer"
import { parse } from "./lua/parser"

const MAX_BACKOFF = 12

/**
 * Turns a partially streamed program into one that parses: drops the unfinished last line, appends
 * closers for every open block and bracket, and backs off a line at a time while that still fails.
 * Returns undefined when no prefix parses.
 */
export function closePrefix(source: string, final = false): string | undefined {
  if (parses(source)) return source
  if (final) return undefined
  const lines = source.split("\n")
  // Without a trailing newline the last line is still being written.
  const complete = source.endsWith("\n") ? lines.length : lines.length - 1
  for (let count = complete; count >= Math.max(0, complete - MAX_BACKOFF); count--) {
    const prefix = lines.slice(0, count).join("\n")
    const closers = closersFor(prefix)
    if (closers === undefined) continue
    const candidate = closers ? `${prefix}\n${closers}` : prefix
    if (parses(candidate)) return candidate
  }
  return undefined
}

function parses(source: string) {
  try {
    parse(source)
    return true
  } catch {
    return false
  }
}

const OPENERS: Record<string, string> = {
  function: "end",
  if: "end",
  do: "end",
  repeat: "until true",
  "(": ")",
  "{": "}",
  "[": "]",
}

/** The closers needed for the constructs left open in `source`, innermost first. */
function closersFor(source: string) {
  const tokens = (() => {
    try {
      return tokenize(source)
    } catch {
      return undefined
    }
  })()
  if (!tokens) return undefined
  const stack: string[] = []
  for (const token of tokens) {
    if (token.kind !== "keyword" && token.kind !== "op") continue
    const closer = OPENERS[token.value]
    if (closer) {
      stack.push(closer)
      continue
    }
    if (token.value === "end" || token.value === "until" || token.value === ")" || token.value === "}" || token.value === "]") {
      if (stack.length === 0) return undefined
      stack.pop()
    }
  }
  return stack.reverse().join("\n")
}
