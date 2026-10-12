import { call, type Runtime } from "../compiler"
import { LuaError, LuaFunction, LuaLimitError, LuaTable, stringToNumber, tostring, truthy, type, type LuaValue } from "../value"
import { format } from "./format"
import { find, gmatch, gsub } from "./pattern"

type Native = (...args: LuaValue[]) => LuaValue[] | LuaValue

const fn = (name: string, f: Native) =>
  new LuaFunction(`builtin ${name}`, (args) => {
    const r = f(...args)
    return Array.isArray(r) ? r : [r]
  })

function argError(n: number, name: string, message: string): never {
  throw new LuaError(`bad argument #${n} to '${name}' (${message})`)
}

function checkTable(v: LuaValue, n: number, name: string): LuaTable {
  if (v instanceof LuaTable) return v
  argError(n, name, `table expected, got ${v === undefined ? "no value" : type(v)}`)
}

function checkNumber(v: LuaValue, n: number, name: string): number {
  if (typeof v === "number") return v
  const parsed = typeof v === "string" ? stringToNumber(v) : undefined
  if (parsed !== undefined) return parsed
  argError(n, name, `number expected, got ${v === undefined ? "no value" : type(v)}`)
}

function optNumber(v: LuaValue, n: number, name: string, fallback: number) {
  return v === undefined ? fallback : checkNumber(v, n, name)
}

function checkString(v: LuaValue, n: number, name: string): string {
  if (typeof v === "string") return v
  if (typeof v === "number") return tostring(v)
  argError(n, name, `string expected, got ${v === undefined ? "no value" : type(v)}`)
}

function checkFunction(v: LuaValue, n: number, name: string): LuaFunction {
  if (v instanceof LuaFunction) return v
  argError(n, name, `function expected, got ${v === undefined ? "no value" : type(v)}`)
}

function unsupported(name: string, hint: string) {
  return fn(name, () => {
    throw new LuaError(`${name} is not supported in widgets (${hint})`)
  })
}

/** Small seeded PRNG (mulberry32) so math.random is reproducible per widget. */
function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export type StdlibOptions = {
  print?: (text: string) => void
  seed?: number
}

export function installStdlib(rt: Runtime, options: StdlibOptions = {}) {
  const G = rt.globals
  const set = (name: string, f: Native) => G.rawSet(name, fn(name, f))

  // ---- base
  set("print", (...args) => {
    options.print?.(args.map(tostring).join("\t"))
    return []
  })
  set("type", (...args) => {
    if (args.length === 0) argError(1, "type", "value expected")
    return type(args[0])
  })
  set("tostring", (v) => tostring(v))
  set("tonumber", (v, base) => {
    if (base === undefined) {
      if (typeof v === "number") return v
      return typeof v === "string" ? stringToNumber(v) : undefined
    }
    const b = checkNumber(base, 2, "tonumber")
    if (b < 2 || b > 36) argError(2, "tonumber", "base out of range")
    const s = checkString(v, 1, "tonumber").trim().toLowerCase()
    const digits = "0123456789abcdefghijklmnopqrstuvwxyz".slice(0, b)
    const neg = s.startsWith("-")
    const body = neg ? s.slice(1) : s
    if (!body || [...body].some((c) => !digits.includes(c))) return undefined
    const n = [...body].reduce((acc, c) => acc * b + digits.indexOf(c), 0)
    return neg ? -n : n
  })
  set("ipairs", (t) => {
    const table = checkTable(t, 1, "ipairs")
    const iter = fn("ipairs_iterator", (_, i) => {
      const next = (i as number) + 1
      const v = table.get(next)
      return v === undefined ? [undefined] : [next, v]
    })
    return [iter, table, 0]
  })
  set("pairs", (t) => {
    const table = checkTable(t, 1, "pairs")
    // A stateful iterator (array part, then hash in insertion order); avoids O(n) next() lookups.
    let i = 0
    let keys: IterableIterator<LuaValue> | undefined
    const iter = fn("pairs_iterator", () => {
      while (i < table.arr.length) {
        const v = table.arr[i++]
        if (v !== undefined) return [i, v]
      }
      keys ??= table.hash.keys()
      for (;;) {
        const next = keys.next()
        if (next.done) return [undefined]
        const v = table.hash.get(next.value)
        if (v !== undefined) return [next.value, v]
      }
    })
    return [iter, table, undefined]
  })
  set("next", (t, k) => checkTable(t, 1, "next").next(k) ?? [undefined])
  set("select", (n, ...rest) => {
    if (n === "#") return rest.length
    const i = Math.trunc(checkNumber(n, 1, "select"))
    if (i < 0) {
      if (-i > rest.length) argError(1, "select", "index out of range")
      return rest.slice(rest.length + i)
    }
    if (i === 0) argError(1, "select", "index out of range")
    return rest.slice(i - 1)
  })
  set("error", (message, level) => {
    // Level 1 (the default) adds the caller's position; the call site fills in the line.
    if (typeof message === "string" && level !== 0) throw new LuaError(message)
    const error = new LuaError(message)
    error.traceLine = -1
    throw error
  })
  set("assert", (v, message, ...rest) => {
    if (truthy(v)) return [v, message, ...rest]
    if (message === undefined) throw new LuaError("assertion failed!")
    const error = new LuaError(message)
    error.traceLine = -1
    throw error
  })
  set("pcall", (f, ...args) => {
    try {
      return [true, ...call(rt, f, args, 0, "")]
    } catch (error) {
      if (error instanceof LuaLimitError) throw error
      if (error instanceof LuaError) return [false, error.value]
      throw error
    }
  })
  set("unpack", (t, i, j) => unpack(t, i, j, "unpack"))
  set("rawget", (t, k) => checkTable(t, 1, "rawget").get(k))
  set("rawset", (t, k, v) => {
    checkTable(t, 1, "rawset").set(k, v)
    return t
  })
  set("rawequal", (a, b) => a === b)
  set("rawlen", (v) => (v instanceof LuaTable ? v.length() : typeof v === "string" ? v.length : argError(1, "rawlen", "table or string expected")))
  for (const name of ["setmetatable", "getmetatable"]) G.rawSet(name, unsupported(name, "metatables are not available"))
  for (const name of ["load", "loadstring", "dofile", "loadfile", "require"]) G.rawSet(name, unsupported(name, "widgets are a single program"))
  G.rawSet("collectgarbage", fn("collectgarbage", () => 0))
  G.rawSet("_G", G)
  G.rawSet("_VERSION", "Lua 5.1")

  // ---- string
  const string = new LuaTable()
  const sset = (name: string, f: Native) => string.rawSet(name, fn(name, f))
  sset("len", (s) => checkString(s, 1, "len").length)
  sset("sub", (s, i, j) => {
    const str = checkString(s, 1, "sub")
    const n = str.length
    let a = optNumber(i, 2, "sub", 1)
    let b = optNumber(j, 3, "sub", -1)
    if (a < 0) a = Math.max(n + a + 1, 1)
    else if (a === 0) a = 1
    if (b < 0) b = n + b + 1
    else if (b > n) b = n
    return a > b ? "" : str.slice(a - 1, b)
  })
  sset("upper", (s) => checkString(s, 1, "upper").toUpperCase())
  sset("lower", (s) => checkString(s, 1, "lower").toLowerCase())
  sset("rep", (s, n, sep) => {
    const str = checkString(s, 1, "rep")
    const count = Math.trunc(checkNumber(n, 2, "rep"))
    if (count <= 0) return ""
    if ((str.length + (typeof sep === "string" ? sep.length : 0)) * count > 1_000_000) throw new LuaLimitError("resulting string too large")
    return sep === undefined ? str.repeat(count) : Array(count).fill(str).join(checkString(sep, 3, "rep"))
  })
  sset("reverse", (s) => [...checkString(s, 1, "reverse")].reverse().join(""))
  sset("byte", (s, i, j) => {
    const str = checkString(s, 1, "byte")
    const a = optNumber(i, 2, "byte", 1)
    const b = optNumber(j, 3, "byte", a)
    const from = a < 0 ? str.length + a + 1 : a
    const to = b < 0 ? str.length + b + 1 : b
    const out: LuaValue[] = []
    for (let k = Math.max(from, 1); k <= Math.min(to, str.length); k++) out.push(str.charCodeAt(k - 1))
    return out
  })
  sset("char", (...codes) => codes.map((c, k) => String.fromCharCode(checkNumber(c, k + 1, "char"))).join(""))
  sset("format", (f, ...args) => format(checkString(f, 1, "format"), args))
  sset("find", (s, p, init, plain) => find(checkString(s, 1, "find"), checkString(p, 2, "find"), init === undefined ? undefined : checkNumber(init, 3, "find"), truthy(plain), true))
  sset("match", (s, p, init) => find(checkString(s, 1, "match"), checkString(p, 2, "match"), init === undefined ? undefined : checkNumber(init, 3, "match"), false, false))
  sset("gmatch", (s, p) => {
    const next = gmatch(checkString(s, 1, "gmatch"), checkString(p, 2, "gmatch"))
    return fn("gmatch_iterator", () => next())
  })
  sset("gsub", (s, p, r, n) => {
    const str = checkString(s, 1, "gsub")
    const pat = checkString(p, 2, "gsub")
    const max = n === undefined ? undefined : Math.trunc(checkNumber(n, 4, "gsub"))
    const replace = (whole: string, captures: LuaValue[]): string | undefined => {
      let value: LuaValue
      if (typeof r === "string" || typeof r === "number") {
        const template = tostring(r)
        return template.replace(/%([\s\S])/g, (_, d: string) => {
          if (d === "%") return "%"
          if (d === "0") return whole
          if (/[1-9]/.test(d)) {
            const cap = captures[Number(d) - 1]
            if (cap === undefined && Number(d) !== 1) throw new LuaError(`invalid capture index %${d} in replacement string`)
            return tostring(cap ?? whole)
          }
          throw new LuaError("invalid use of '%' in replacement string")
        })
      }
      if (r instanceof LuaTable) value = r.get(captures[0])
      else if (r instanceof LuaFunction) value = call(rt, r, captures, 0, "")[0]
      else argError(3, "gsub", `string/function/table expected, got ${type(r)}`)
      if (value === undefined || value === false) return undefined
      if (typeof value !== "string" && typeof value !== "number") throw new LuaError(`invalid replacement value (a ${type(value)})`)
      return tostring(value)
    }
    return gsub(str, pat, replace, max)
  })
  G.rawSet("string", string)
  rt.stringMeta = string

  // ---- table
  const table = new LuaTable()
  const tset = (name: string, f: Native) => table.rawSet(name, fn(name, f))
  tset("insert", (t, ...rest) => {
    const tbl = checkTable(t, 1, "insert")
    const n = tbl.length()
    if (rest.length === 1) {
      tbl.set(n + 1, rest[0])
      return []
    }
    if (rest.length !== 2) throw new LuaError("wrong number of arguments to 'insert'")
    const [a, b] = rest
    const pos = Math.trunc(checkNumber(a, 2, "insert"))
    if (pos < 1 || pos > n + 1) argError(2, "insert", "position out of bounds")
    for (let k = n; k >= pos; k--) tbl.set(k + 1, tbl.get(k))
    tbl.set(pos, b)
    return []
  })
  tset("remove", (t, p) => {
    const tbl = checkTable(t, 1, "remove")
    const n = tbl.length()
    if (p === undefined) {
      if (n === 0) return [undefined]
      const v = tbl.get(n)
      tbl.set(n, undefined)
      return v
    }
    const pos = Math.trunc(checkNumber(p, 2, "remove"))
    if (n === 0 && (pos === 0 || pos === n)) return tbl.get(pos)
    if (pos < 1 || pos > n + 1) argError(2, "remove", "position out of bounds")
    const v = tbl.get(pos)
    for (let k = pos; k < n; k++) tbl.set(k, tbl.get(k + 1))
    if (pos <= n) tbl.set(n, undefined)
    return v
  })
  tset("concat", (t, sep, i, j) => {
    const tbl = checkTable(t, 1, "concat")
    const s = sep === undefined ? "" : checkString(sep, 2, "concat")
    const a = optNumber(i, 3, "concat", 1)
    const b = optNumber(j, 4, "concat", tbl.length())
    const parts: string[] = []
    for (let k = a; k <= b; k++) {
      const v = tbl.get(k)
      if (typeof v !== "string" && typeof v !== "number") throw new LuaError(`invalid value (at index ${k}) in table for 'concat'`)
      parts.push(tostring(v))
    }
    return parts.join(s)
  })
  tset("sort", (t, comp) => {
    const tbl = checkTable(t, 1, "sort")
    const n = tbl.length()
    const values = tbl.arr.slice(0, n)
    const less = comp === undefined
      ? (a: LuaValue, b: LuaValue) => {
          if ((typeof a === "number" && typeof b === "number") || (typeof a === "string" && typeof b === "string")) return a < b
          throw new LuaError(`attempt to compare ${type(a)} with ${type(b)}`)
        }
      : (a: LuaValue, b: LuaValue) => truthy(call(rt, checkFunction(comp, 2, "sort"), [a, b], 0, "")[0])
    values.sort((a, b) => (less(a, b) ? -1 : less(b, a) ? 1 : 0))
    values.forEach((v, k) => tbl.set(k + 1, v))
    return []
  })
  tset("unpack", (t, i, j) => unpack(t, i, j, "unpack"))
  tset("pack", (...args) => {
    const t = LuaTable.from(args)
    t.rawSet("n", args.length)
    return t
  })
  G.rawSet("table", table)

  // ---- math
  const math = new LuaTable()
  const random = rng(options.seed ?? 0x5eed)
  let rand = random
  const mset = (name: string, f: Native) => math.rawSet(name, fn(name, f))
  const unary = (name: string, f: (x: number) => number) => mset(name, (x) => f(checkNumber(x, 1, name)))
  unary("abs", Math.abs)
  unary("ceil", Math.ceil)
  unary("floor", Math.floor)
  unary("sqrt", Math.sqrt)
  unary("sin", Math.sin)
  unary("cos", Math.cos)
  unary("tan", Math.tan)
  unary("asin", Math.asin)
  unary("acos", Math.acos)
  unary("exp", Math.exp)
  unary("deg", (x) => (x * 180) / Math.PI)
  unary("rad", (x) => (x * Math.PI) / 180)
  mset("atan", (y, x) => Math.atan2(checkNumber(y, 1, "atan"), optNumber(x, 2, "atan", 1)))
  mset("log", (x, base) => {
    const v = checkNumber(x, 1, "log")
    if (base === undefined) return Math.log(v)
    const b = checkNumber(base, 2, "log")
    return b === 2 ? Math.log2(v) : b === 10 ? Math.log10(v) : Math.log(v) / Math.log(b)
  })
  mset("max", (...xs) => {
    if (!xs.length) argError(1, "max", "number expected, got no value")
    return xs.map((x, k) => checkNumber(x, k + 1, "max")).reduce((a, b) => (b > a ? b : a))
  })
  mset("min", (...xs) => {
    if (!xs.length) argError(1, "min", "number expected, got no value")
    return xs.map((x, k) => checkNumber(x, k + 1, "min")).reduce((a, b) => (b < a ? b : a))
  })
  mset("fmod", (a, b) => {
    const x = checkNumber(a, 1, "fmod")
    const y = checkNumber(b, 2, "fmod")
    if (y === 0 && Number.isInteger(x)) argError(2, "fmod", "zero")
    return x % y
  })
  mset("modf", (x) => {
    const v = checkNumber(x, 1, "modf")
    const int = v >= 0 ? Math.floor(v) : Math.ceil(v)
    return [int, Number.isFinite(v) ? v - int : 0]
  })
  mset("tointeger", (x) => (typeof x === "number" && Number.isInteger(x) ? x : undefined))
  mset("type", (x) => (typeof x !== "number" ? undefined : Number.isInteger(x) ? "integer" : "float"))
  mset("ult", (a, b) => BigInt.asUintN(64, BigInt(checkNumber(a, 1, "ult"))) < BigInt.asUintN(64, BigInt(checkNumber(b, 2, "ult"))))
  mset("random", (m, n) => {
    const r = rand()
    if (m === undefined) return r
    const lo = n === undefined ? 1 : Math.trunc(checkNumber(m, 1, "random"))
    const hi = n === undefined ? Math.trunc(checkNumber(m, 1, "random")) : Math.trunc(checkNumber(n, 2, "random"))
    if (lo > hi) argError(n === undefined ? 1 : 2, "random", "interval is empty")
    return lo + Math.floor(r * (hi - lo + 1))
  })
  mset("randomseed", (s) => {
    rand = rng(s === undefined ? 0x5eed : Math.trunc(checkNumber(s, 1, "randomseed")))
    return []
  })
  math.rawSet("pi", Math.PI)
  math.rawSet("huge", Infinity)
  math.rawSet("maxinteger", Number.MAX_SAFE_INTEGER)
  math.rawSet("mininteger", Number.MIN_SAFE_INTEGER)
  G.rawSet("math", math)

  // ---- unavailable libraries: clear errors instead of "attempt to index a nil value"
  for (const lib of ["io", "os", "debug", "coroutine", "utf8", "package"]) {
    const stub = new LuaTable()
    stub.unavailable = lib
    G.rawSet(lib, stub)
  }
}

function unpack(t: LuaValue, i: LuaValue, j: LuaValue, name: string): LuaValue[] {
  const tbl = checkTable(t, 1, name)
  const a = optNumber(i, 2, name, 1)
  const b = optNumber(j, 3, name, tbl.length())
  if (b - a >= 10000) throw new LuaLimitError("too many results to unpack")
  const out: LuaValue[] = []
  for (let k = a; k <= b; k++) out.push(tbl.get(k))
  return out
}
