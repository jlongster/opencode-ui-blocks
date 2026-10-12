import { formatG, formatNumber, LuaError, tostring, type, type LuaValue } from "../value"

/** string.format: %d %i %u %c %x %X %o %e %E %f %F %g %G %q %s %% with flags, width and precision. */
export function format(fmt: string, args: LuaValue[]): string {
  let out = ""
  let argi = 0
  for (let i = 0; i < fmt.length; i++) {
    const c = fmt[i]
    if (c !== "%") {
      out += c
      continue
    }
    if (fmt[i + 1] === "%") {
      out += "%"
      i++
      continue
    }
    const m = /^([-+ #0]*)(\d*)(?:\.(\d*))?([a-zA-Z])/.exec(fmt.slice(i + 1))
    if (!m) throw new LuaError(`invalid conversion '%${fmt.slice(i + 1, i + 3)}' to 'format'`)
    const [whole, flags, widthText, precisionText, conv] = m
    i += whole.length
    const argn = ++argi
    if (argn > args.length && conv !== "%") throw new LuaError(`bad argument #${argn + 1} to 'format' (no value)`)
    const arg = args[argn - 1]
    const width = widthText ? Number(widthText) : 0
    const precision = precisionText === undefined ? undefined : Number(precisionText || "0")
    const left = flags.includes("-")
    const zero = flags.includes("0") && !left
    const plus = flags.includes("+")
    const space = flags.includes(" ")
    const alt = flags.includes("#")

    const num = () => {
      if (typeof arg === "number") return arg
      const n = typeof arg === "string" ? Number(arg.trim()) : NaN
      if (typeof arg !== "string" || Number.isNaN(n))
        throw new LuaError(`bad argument #${argn + 1} to 'format' (number expected, got ${arg === undefined ? "no value" : type(arg)})`)
      return n
    }
    const signed = (body: string, negative: boolean) => (negative ? "-" : plus ? "+" : space ? " " : "") + body
    const pad = (text: string, numeric: boolean) => {
      if (text.length >= width) return text
      if (left) return text + " ".repeat(width - text.length)
      if (zero && numeric) {
        const sign = /^[+\- ]/.test(text) ? text[0] : ""
        const rest = sign ? text.slice(1) : text
        const prefix = /^0[xX]/.test(rest) ? rest.slice(0, 2) : ""
        return sign + prefix + "0".repeat(width - text.length) + rest.slice(prefix.length)
      }
      return " ".repeat(width - text.length) + text
    }

    switch (conv) {
      case "d":
      case "i": {
        const n = Math.trunc(num())
        let body = Math.abs(n).toString()
        if (precision !== undefined) body = body.padStart(precision, "0")
        out += pad(signed(body, n < 0), precision === undefined)
        break
      }
      case "u": {
        const n = Math.trunc(num())
        out += pad(String(n < 0 ? n + 2 ** 64 : n), true)
        break
      }
      case "c":
        out += pad(String.fromCharCode(Math.trunc(num())), false)
        break
      case "x":
      case "X":
      case "o": {
        const n = Math.trunc(num())
        let body = (n < 0 ? BigInt.asUintN(64, BigInt(n)) : BigInt(n)).toString(conv === "o" ? 8 : 16)
        if (precision !== undefined) body = body.padStart(precision, "0")
        if (alt && n !== 0) body = (conv === "o" ? "0" : "0x") + body
        if (conv === "X") body = body.toUpperCase()
        out += pad(body, precision === undefined)
        break
      }
      case "e":
      case "E": {
        const n = num()
        let body = Number.isFinite(n) ? Math.abs(n).toExponential(precision ?? 6).replace(/e([+-])(\d)$/, "e$10$2") : nonFinite(n)
        if (conv === "E") body = body.toUpperCase()
        out += pad(signed(body, n < 0 || Object.is(n, -0)), Number.isFinite(n))
        break
      }
      case "f":
      case "F": {
        const n = num()
        let body = Number.isFinite(n) ? Math.abs(n).toFixed(precision ?? 6) : nonFinite(n)
        if (alt && precision === 0) body += "."
        if (conv === "F") body = body.toUpperCase()
        out += pad(signed(body, n < 0 || Object.is(n, -0)), Number.isFinite(n))
        break
      }
      case "g":
      case "G": {
        const n = num()
        const body = Number.isFinite(n) ? formatG(Math.abs(n), precision ?? 6, alt, conv === "G") : nonFinite(n)
        out += pad(signed(body, n < 0), Number.isFinite(n))
        break
      }
      case "q":
        out += quote(arg)
        break
      case "s": {
        let text = tostring(arg)
        if (precision !== undefined) text = text.slice(0, precision)
        out += pad(text, false)
        break
      }
      case "a":
      case "A":
        throw new LuaError("'%a' is not supported in format")
      default:
        throw new LuaError(`invalid conversion '%${conv}' to 'format'`)
    }
  }
  return out
}

function nonFinite(n: number) {
  return Number.isNaN(n) ? "nan" : "inf"
}

function quote(v: LuaValue): string {
  if (typeof v === "string") {
    let out = '"'
    for (let i = 0; i < v.length; i++) {
      const c = v[i]
      const code = c.charCodeAt(0)
      if (c === '"' || c === "\\") out += "\\" + c
      else if (c === "\n") out += "\\n"
      else if (c === "\r") out += "\\r"
      else if (c === "\0") out += /[0-9]/.test(v[i + 1] ?? "") ? "\\000" : "\\0"
      else if (code < 32 || code === 127) out += "\\" + code
      else out += c
    }
    return out + '"'
  }
  if (typeof v === "number") return Number.isInteger(v) ? formatNumber(v) : v === Infinity ? "1e9999" : v === -Infinity ? "-1e9999" : Number.isNaN(v) ? "(0/0)" : formatG(v, 17, false)
  if (v === undefined || typeof v === "boolean") return tostring(v)
  throw new LuaError("bad argument to 'format' (value has no literal form)")
}
