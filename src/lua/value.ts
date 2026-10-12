/**
 * Runtime values. nil is `undefined`; booleans, numbers and strings are JS primitives; tables and
 * functions are the classes below.
 */

export type LuaValue = undefined | boolean | number | string | LuaTable | LuaFunction

/** Records writes while a transaction is open so they can be rolled back. */
export class Journal {
  entries: (() => void)[] = []
  active = false
  /** Bumped per transaction. Tables born in the current one need no undo entries: rollback makes them unreachable. */
  epoch = 0
}

export const journal = new Journal()

export class LuaTable {
  /** arr[i] holds key i + 1. Kept free of trailing nils. */
  arr: LuaValue[] = []
  hash = new Map<LuaValue, LuaValue>()
  /** Set on library tables that are deliberately missing (io, os, …) for a helpful error. */
  unavailable?: string
  private born = journal.epoch

  get(key: LuaValue): LuaValue {
    if (typeof key === "number") {
      const i = key - 1
      if (i >= 0 && i < this.arr.length && Number.isInteger(key)) return this.arr[i]
    }
    return this.hash.get(key)
  }

  set(key: LuaValue, value: LuaValue) {
    if (key === undefined) throw new LuaError("table index is nil")
    if (typeof key === "number" && Number.isNaN(key)) throw new LuaError("table index is NaN")
    if (journal.active && this.born !== journal.epoch) {
      const old = this.get(key)
      if (old !== value) journal.entries.push(() => this.rawSet(key, old))
    }
    this.rawSet(key, value)
  }

  rawSet(key: LuaValue, value: LuaValue) {
    if (typeof key === "number" && Number.isInteger(key) && key >= 1) {
      const i = key - 1
      const n = this.arr.length
      if (i < n) {
        this.arr[i] = value
        if (value === undefined && i === n - 1) {
          // Keep the array part free of trailing nils so # stays a valid border.
          while (this.arr.length && this.arr[this.arr.length - 1] === undefined) this.arr.pop()
        }
        return
      }
      if (i === n && value !== undefined) {
        this.arr.push(value)
        this.hash.delete(key)
        // Move following integer keys from the hash part into the array part.
        let next = key + 1
        while (this.hash.has(next)) {
          this.arr.push(this.hash.get(next))
          this.hash.delete(next)
          next++
        }
        return
      }
    }
    if (value === undefined) this.hash.delete(key)
    else this.hash.set(key, value)
  }

  length() {
    return this.arr.length
  }

  /** Lua's next(): array part first, then hash part in insertion order. */
  next(key: LuaValue): [LuaValue, LuaValue] | undefined {
    let start = 0
    if (key !== undefined) {
      if (typeof key === "number" && Number.isInteger(key) && key >= 1 && key <= this.arr.length) start = key
      else {
        const keys = [...this.hash.keys()]
        const at = keys.indexOf(key)
        if (at === -1) throw new LuaError("invalid key to 'next'")
        for (let j = at + 1; j < keys.length; j++) {
          const v = this.hash.get(keys[j])
          if (v !== undefined) return [keys[j], v]
        }
        return undefined
      }
    }
    for (let j = start; j < this.arr.length; j++) if (this.arr[j] !== undefined) return [j + 1, this.arr[j]]
    for (const [k, v] of this.hash) if (v !== undefined) return [k, v]
    return undefined
  }

  static from(values: LuaValue[], fields?: Record<string, LuaValue>) {
    const t = new LuaTable()
    values.forEach((v, i) => t.rawSet(i + 1, v))
    if (fields) for (const [k, v] of Object.entries(fields)) t.rawSet(k, v)
    return t
  }
}

/** A callable: user closures and native functions share this shape. Results are always an array. */
export class LuaFunction {
  constructor(
    readonly name: string,
    readonly call: (args: LuaValue[]) => LuaValue[],
  ) {}
}

export class LuaError extends Error {
  /** The Lua error value (usually a string); `error()` can throw any value. */
  value: LuaValue
  traceLine?: number

  constructor(value: LuaValue, line?: number) {
    const text = typeof value === "string" ? value : tostring(value)
    super(line !== undefined ? `line ${line}: ${text}` : text)
    this.value = line !== undefined && typeof value === "string" ? `line ${line}: ${value}` : value
    this.traceLine = line
  }

  /** Adds a line to errors raised without one (e.g. inside native functions). */
  withLine(line: number) {
    if (this.traceLine !== undefined || typeof this.value !== "string") return this
    // Keep the subclass so limit errors stay uncatchable.
    return new (this.constructor as typeof LuaError)(this.value, line)
  }
}

/** Resource limits (steps, depth, sizes). pcall cannot catch these. */
export class LuaLimitError extends LuaError {}

export function type(v: LuaValue): string {
  if (v === undefined) return "nil"
  if (typeof v === "boolean") return "boolean"
  if (typeof v === "number") return "number"
  if (typeof v === "string") return "string"
  if (v instanceof LuaTable) return "table"
  return "function"
}

const ids = new WeakMap<object, number>()
let nextId = 1
const addressOf = (o: object) => {
  let id = ids.get(o)
  if (id === undefined) ids.set(o, (id = nextId++))
  return "0x" + id.toString(16).padStart(8, "0")
}

export function tostring(v: LuaValue): string {
  if (v === undefined) return "nil"
  if (v === true) return "true"
  if (v === false) return "false"
  if (typeof v === "number") return formatNumber(v)
  if (typeof v === "string") return v
  if (v instanceof LuaTable) return "table: " + addressOf(v)
  return (v.name.startsWith("builtin") ? "builtin: " : "function: ") + addressOf(v)
}

/** Lua's number formatting (`%.14g`): 3 → "3", 0.1 → "0.1", 1e20 → "1e+20". */
export function formatNumber(n: number): string {
  if (Number.isNaN(n)) return n > 0 || Object.is(n, NaN) ? "nan" : "-nan"
  if (n === Infinity) return "inf"
  if (n === -Infinity) return "-inf"
  if (Number.isInteger(n) && Math.abs(n) < 1e15) return String(n)
  return formatG(n, 14, false)
}

/** C's %g with the given precision. */
export function formatG(n: number, precision: number, alt: boolean, upper = false): string {
  if (!Number.isFinite(n)) return Number.isNaN(n) ? "nan" : n > 0 ? "inf" : "-inf"
  const p = precision === 0 ? 1 : precision
  if (n === 0) return alt ? (0).toFixed(p - 1) : Object.is(n, -0) ? "-0" : "0"
  const exp = Math.floor(Math.log10(Math.abs(Number(n.toExponential(p - 1)))))
  let out: string
  if (exp < -4 || exp >= p) {
    out = n.toExponential(p - 1)
    if (!alt) out = out.replace(/\.?0+e/, "e")
    out = out.replace(/e([+-])(\d)$/, "e$10$2")
  } else {
    out = n.toFixed(Math.max(0, p - 1 - exp))
    if (!alt && out.includes(".")) out = out.replace(/\.?0+$/, "")
  }
  return upper ? out.toUpperCase() : out
}

export function truthy(v: LuaValue) {
  return v !== undefined && v !== false
}

/** Converts strings in arithmetic, as Lua does ("10" + 1 == 11). */
export function toNumber(v: LuaValue): number | undefined {
  if (typeof v === "number") return v
  if (typeof v === "string") return stringToNumber(v)
  return undefined
}

export function stringToNumber(s: string): number | undefined {
  const t = s.trim()
  if (t === "") return undefined
  const hex = /^([+-])?0[xX]([0-9a-fA-F]+)(?:\.([0-9a-fA-F]*))?(?:[pP]([+-]?\d+))?$/.exec(t)
  if (hex) {
    let value = parseInt(hex[2], 16)
    const frac = hex[3] ?? ""
    for (let k = 0; k < frac.length; k++) value += parseInt(frac[k], 16) / 16 ** (k + 1)
    if (hex[4]) value *= 2 ** Number(hex[4])
    return hex[1] === "-" ? -value : value
  }
  if (/^[+-]?(inf|nan|infinity)$/i.test(t)) return undefined
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t)) return undefined
  return Number(t)
}
