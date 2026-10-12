export type TokenKind = "name" | "keyword" | "number" | "string" | "op" | "eof"

export type Token = {
  kind: TokenKind
  value: string
  /** Parsed value for numbers and strings. */
  literal?: number | string
  line: number
  start: number
  end: number
}

export class LuaSyntaxError extends Error {
  constructor(
    message: string,
    readonly line: number,
    /** The source ended before the construct was finished (useful while streaming). */
    readonly incomplete = false,
  ) {
    super(`line ${line}: ${message}`)
  }
}

const KEYWORDS = new Set([
  "and", "break", "do", "else", "elseif", "end", "false", "for", "function", "goto", "if", "in",
  "local", "nil", "not", "or", "repeat", "return", "then", "true", "until", "while",
])

// Longest first so "..." wins over ".." and "." etc.
const OPS = ["...", "..", "==", "~=", "<=", ">=", "//", "::", "<<", ">>", "+", "-", "*", "/", "%", "^", "#", "&", "~", "|", "<", ">", "=", "(", ")", "{", "}", "[", "]", ";", ":", ",", "."]

export function tokenize(source: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  let line = 1
  const n = source.length

  const fail = (message: string, incomplete = false): never => {
    throw new LuaSyntaxError(message, line, incomplete)
  }

  /** Length of a long bracket opener `[[`, `[=[`, … at `at`, or -1. Returns the level. */
  const longOpen = (at: number) => {
    if (source[at] !== "[") return -1
    let j = at + 1
    while (source[j] === "=") j++
    return source[j] === "[" ? j - at - 1 : -1
  }

  const readLong = (at: number, level: number) => {
    const close = "]" + "=".repeat(level) + "]"
    const bodyStart = at + level + 2
    const end = source.indexOf(close, bodyStart)
    if (end === -1) fail("unfinished long string or comment", true)
    let body = source.slice(bodyStart, end)
    // A newline right after the opening bracket is skipped.
    if (body.startsWith("\r\n")) body = body.slice(2)
    else if (body.startsWith("\n") || body.startsWith("\r")) body = body.slice(1)
    line += (source.slice(at, end + close.length).match(/\n/g) ?? []).length
    return { body, next: end + close.length }
  }

  while (i < n) {
    const c = source[i]
    if (c === "\n") { line++; i++; continue }
    if (c === " " || c === "\t" || c === "\r" || c === "\f" || c === "\v") { i++; continue }

    if (c === "-" && source[i + 1] === "-") {
      const level = longOpen(i + 2)
      if (level >= 0) { i = readLong(i + 2, level).next; continue }
      while (i < n && source[i] !== "\n") i++
      continue
    }

    const start = i
    const startLine = line

    if (/[A-Za-z_]/.test(c)) {
      let j = i + 1
      while (j < n && /[A-Za-z0-9_]/.test(source[j])) j++
      const word = source.slice(i, j)
      tokens.push({ kind: KEYWORDS.has(word) ? "keyword" : "name", value: word, line: startLine, start, end: j })
      i = j
      continue
    }

    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(source[i + 1] ?? ""))) {
      const m = /^0[xX]([0-9a-fA-F]*)(\.[0-9a-fA-F]*)?([pP][+-]?[0-9]+)?|^[0-9]*\.?[0-9]*([eE][+-]?[0-9]+)?/.exec(source.slice(i))!
      const text = m[0]
      let j = i + text.length
      if (/[A-Za-z_]/.test(source[j] ?? "")) {
        // Keep a malformed numeral like "3x" together for the error message.
        while (j < n && /[A-Za-z0-9_.]/.test(source[j])) j++
        fail(`malformed number near '${source.slice(i, j)}'`)
      }
      tokens.push({ kind: "number", value: text, literal: parseNumber(text) ?? fail(`malformed number near '${text}'`), line: startLine, start, end: j })
      i = j
      continue
    }

    if (c === '"' || c === "'") {
      let j = i + 1
      let out = ""
      for (;;) {
        if (j >= n) fail("unfinished string", true)
        const ch = source[j]
        if (ch === c) { j++; break }
        if (ch === "\n") fail("unfinished string")
        if (ch !== "\\") { out += ch; j++; continue }
        const e = source[j + 1]
        if (e === undefined) fail("unfinished string", true)
        const simple: Record<string, string> = { n: "\n", t: "\t", r: "\r", a: "\x07", b: "\b", f: "\f", v: "\v", "\\": "\\", '"': '"', "'": "'", "\n": "\n" }
        if (e in simple) {
          if (e === "\n") line++
          out += simple[e]
          j += 2
        } else if (e === "x") {
          const hex = source.slice(j + 2, j + 4)
          if (!/^[0-9a-fA-F]{2}$/.test(hex)) fail("hexadecimal digit expected")
          out += String.fromCharCode(parseInt(hex, 16))
          j += 4
        } else if (e === "z") {
          j += 2
          while (j < n && /\s/.test(source[j])) { if (source[j] === "\n") line++; j++ }
        } else if (e === "u") {
          const m = /^\{([0-9a-fA-F]+)\}/.exec(source.slice(j + 2))
          if (!m) fail("missing '{' or '}' in \\u{xxxx}")
          out += String.fromCodePoint(parseInt(m![1], 16))
          j += 2 + m![0].length
        } else if (/[0-9]/.test(e)) {
          const digits = /^[0-9]{1,3}/.exec(source.slice(j + 1))![0]
          const code = Number(digits)
          if (code > 255) fail("decimal escape too large")
          out += String.fromCharCode(code)
          j += 1 + digits.length
        } else fail(`invalid escape sequence '\\${e}'`)
      }
      tokens.push({ kind: "string", value: source.slice(i, j), literal: out, line: startLine, start, end: j })
      i = j
      continue
    }

    const level = longOpen(i)
    if (level >= 0) {
      const long = readLong(i, level)
      tokens.push({ kind: "string", value: source.slice(i, long.next), literal: long.body, line: startLine, start, end: long.next })
      i = long.next
      continue
    }

    const op = OPS.find((o) => source.startsWith(o, i))
    if (!op) fail(`unexpected symbol near '${c}'`)
    tokens.push({ kind: "op", value: op!, line: startLine, start, end: i + op!.length })
    i += op!.length
  }
  tokens.push({ kind: "eof", value: "<eof>", line, start: n, end: n })
  return tokens
}

/** Lua numeral syntax (decimal, hex, hex floats); undefined if malformed. */
export function parseNumber(text: string): number | undefined {
  const t = text.trim()
  const hex = /^([+-])?0[xX]([0-9a-fA-F]*)(?:\.([0-9a-fA-F]*))?(?:[pP]([+-]?[0-9]+))?$/.exec(t)
  if (hex) {
    const [, sign, int = "", frac = "", exp] = hex
    if (!int && !frac) return undefined
    let value = int ? parseInt(int, 16) : 0
    for (let k = 0; k < frac.length; k++) value += parseInt(frac[k], 16) / 16 ** (k + 1)
    if (exp) value *= 2 ** Number(exp)
    return sign === "-" ? -value : value
  }
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t)) return undefined
  return Number(t)
}
