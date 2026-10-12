import type { Expr, FunctionBody, Stat } from "./ast"
import { formatNumber, journal, LuaError, LuaFunction, LuaLimitError, LuaTable, toNumber, tostring, truthy, type LuaValue } from "./value"

/** Shared mutable state for one program instance: globals, string library, limits. */
export type Runtime = {
  globals: LuaTable
  /** Methods available on strings (`("x"):upper()`). */
  stringMeta: LuaTable
  steps: number
  maxSteps: number
  depth: number
  maxDepth: number
}

class Cell {
  constructor(public v: LuaValue) {}
}

type Frame = { regs: unknown[]; ups: Cell[]; va: LuaValue[] }
type Ev = (f: Frame) => LuaValue
type Multi = (f: Frame) => LuaValue[]
type Ex = (f: Frame) => Signal

class Return {
  constructor(readonly values: LuaValue[]) {}
}
const BREAK = Symbol("break")
type Signal = undefined | typeof BREAK | Return

// ---------------------------------------------------------------- resolution

type Local = { name: string; slot: number; captured: boolean }
type Upvalue = { name: string; fromLocal?: Local; fromUp?: number }
type FnState = { parent?: FnState; blocks: Map<string, Local>[]; slots: number; upvalues: Upvalue[]; vararg: boolean }
type Resolved = { kind: "local"; local: Local } | { kind: "up"; index: number } | { kind: "global"; name: string }

/**
 * Pass 1: decide where every name lives. Locals captured by an inner function are marked so the
 * compiler stores them in cells; everything else is a plain register slot.
 */
class Resolver {
  names = new Map<Expr, Resolved>()
  decls = new Map<object, Local[]>()
  fns = new Map<FunctionBody, FnState>()
  fn!: FnState

  function(body: FunctionBody, parent?: FnState) {
    const state: FnState = { parent, blocks: [new Map()], slots: 0, upvalues: [], vararg: body.vararg }
    this.fns.set(body, state)
    const outer = this.fn
    this.fn = state
    this.decls.set(body, body.params.map((p) => this.declare(p)))
    this.block(body.body, false)
    this.fn = outer
  }

  declare(name: string): Local {
    const local: Local = { name, slot: this.fn.slots++, captured: false }
    this.fn.blocks[this.fn.blocks.length - 1].set(name, local)
    return local
  }

  resolve(name: string, fn: FnState = this.fn): Resolved {
    for (let i = fn.blocks.length - 1; i >= 0; i--) {
      const local = fn.blocks[i].get(name)
      if (local) return { kind: "local", local }
    }
    const existing = fn.upvalues.findIndex((u) => u.name === name)
    if (existing !== -1) return { kind: "up", index: existing }
    if (!fn.parent) return { kind: "global", name }
    const outer = this.resolve(name, fn.parent)
    if (outer.kind === "global") return outer
    if (outer.kind === "local") outer.local.captured = true
    fn.upvalues.push(outer.kind === "local" ? { name, fromLocal: outer.local } : { name, fromUp: outer.index })
    return { kind: "up", index: fn.upvalues.length - 1 }
  }

  block(stats: Stat[], scoped = true, extra?: () => void) {
    if (scoped) this.fn.blocks.push(new Map())
    stats.forEach((s) => this.stat(s))
    extra?.()
    if (scoped) this.fn.blocks.pop()
  }

  stat(s: Stat) {
    switch (s.k) {
      case "local":
        s.values.forEach((e) => this.expr(e))
        this.decls.set(s, s.names.map((n) => this.declare(n)))
        return
      case "localfunction":
        this.decls.set(s, [this.declare(s.name)])
        this.function(s.fn, this.fn)
        return
      case "assign":
        s.targets.forEach((e) => this.expr(e))
        s.values.forEach((e) => this.expr(e))
        return
      case "call":
        return this.expr(s.call)
      case "do":
        return this.block(s.body)
      case "while":
        this.expr(s.cond)
        return this.block(s.body)
      case "repeat":
        // The condition can see the body's locals.
        return this.block(s.body, true, () => this.expr(s.cond))
      case "if":
        s.clauses.forEach((c) => {
          this.expr(c.cond)
          this.block(c.body)
        })
        if (s.orelse) this.block(s.orelse)
        return
      case "fornum":
        this.expr(s.start)
        this.expr(s.stop)
        if (s.step) this.expr(s.step)
        this.fn.blocks.push(new Map())
        this.decls.set(s, [this.declare(s.name)])
        this.block(s.body)
        this.fn.blocks.pop()
        return
      case "forin":
        s.exprs.forEach((e) => this.expr(e))
        this.fn.blocks.push(new Map())
        this.decls.set(s, s.names.map((n) => this.declare(n)))
        this.block(s.body)
        this.fn.blocks.pop()
        return
      case "function":
        this.expr(s.target)
        return this.function(s.fn, this.fn)
      case "return":
        return s.values.forEach((e) => this.expr(e))
      case "break":
        return
    }
  }

  expr(e: Expr): void {
    switch (e.k) {
      case "name":
        this.names.set(e, this.resolve(e.name))
        return
      case "vararg":
        if (!this.fn.vararg) throw new LuaError("cannot use '...' outside a vararg function", e.line)
        return
      case "function":
        return this.function(e.fn, this.fn)
      case "index":
        this.expr(e.obj)
        return this.expr(e.key)
      case "call":
        this.expr(e.fn)
        return e.args.forEach((a) => this.expr(a))
      case "method":
        this.expr(e.obj)
        return e.args.forEach((a) => this.expr(a))
      case "binop":
      case "and":
      case "or":
        this.expr(e.left)
        return this.expr(e.right)
      case "unop":
        return this.expr(e.expr)
      case "paren":
        return this.expr(e.expr)
      case "table":
        return e.items.forEach((item) => {
          if (item.k === "keyed") this.expr(item.key)
          this.expr(item.value)
        })
    }
  }
}

// ---------------------------------------------------------------- compilation

/** Compiles a parsed chunk into a function for the given runtime. */
export function compile(chunk: FunctionBody, rt: Runtime): LuaFunction {
  const resolver = new Resolver()
  resolver.function(chunk)
  const c = new Compiler(resolver, rt)
  const make = c.function(chunk)
  return make({ regs: [], ups: [], va: [] })
}

class Compiler {
  constructor(
    readonly r: Resolver,
    readonly rt: Runtime,
  ) {}

  /** Returns a factory that creates the closure at runtime, capturing upvalues from the defining frame. */
  function(body: FunctionBody): (f: Frame) => LuaFunction {
    const state = this.r.fns.get(body)!
    const params = this.r.decls.get(body)!
    const run = this.block(body.body)
    const rt = this.rt
    const nparams = params.length
    const ups = state.upvalues
    const name = body.name
    return (outer) => {
      const cells = ups.map((u) => (u.fromLocal ? (outer.regs[u.fromLocal.slot] as Cell) : outer.ups[u.fromUp!]))
      return new LuaFunction(name, (args) => {
        if (++rt.depth > rt.maxDepth) {
          rt.depth = 0
          throw new LuaLimitError("stack overflow (too many nested calls)")
        }
        tick(rt)
        const regs: unknown[] = new Array(state.slots)
        for (let i = 0; i < nparams; i++) {
          const local = params[i]
          regs[local.slot] = local.captured ? new Cell(args[i]) : args[i]
        }
        const f: Frame = { regs, ups: cells, va: state.vararg ? args.slice(nparams) : EMPTY }
        try {
          const signal = run(f)
          return signal instanceof Return ? signal.values : EMPTY
        } finally {
          rt.depth--
        }
      })
    }
  }

  block(stats: Stat[]): Ex {
    const compiled = stats.map((s) => this.stat(s))
    if (compiled.length === 0) return () => undefined
    if (compiled.length === 1) return compiled[0]
    return (f) => {
      for (let i = 0; i < compiled.length; i++) {
        const signal = compiled[i](f)
        if (signal !== undefined) return signal
      }
      return undefined
    }
  }

  /** Assigns a freshly declared local: captured locals get a new cell (new binding per iteration). */
  declare(local: Local): (f: Frame, v: LuaValue) => void {
    const slot = local.slot
    return local.captured ? (f, v) => void (f.regs[slot] = new Cell(v)) : (f, v) => void (f.regs[slot] = v)
  }

  stat(s: Stat): Ex {
    const rt = this.rt
    switch (s.k) {
      case "local": {
        const locals = this.r.decls.get(s)!.map((l) => this.declare(l))
        if (s.values.length === 0) return (f) => void locals.forEach((d) => d(f, undefined))
        if (locals.length === 1 && s.values.length === 1) {
          const value = this.expr(s.values[0])
          const d = locals[0]
          return (f) => void d(f, value(f))
        }
        const values = this.exprList(s.values)
        return (f) => {
          const vs = values(f)
          for (let i = 0; i < locals.length; i++) locals[i](f, vs[i])
          return undefined
        }
      }
      case "localfunction": {
        const local = this.r.decls.get(s)![0]
        const make = this.function(s.fn)
        const slot = local.slot
        if (!local.captured) return (f) => void (f.regs[slot] = make(f))
        return (f) => {
          // Declare first so the function can refer to itself.
          const cell = new Cell(undefined)
          f.regs[slot] = cell
          cell.v = make(f)
          return undefined
        }
      }
      case "assign": {
        if (s.targets.length === 1 && s.values.length === 1) {
          const set = this.target(s.targets[0])
          const value = this.expr(s.values[0])
          return (f) => {
            const assign = set(f)
            assign(value(f))
            return undefined
          }
        }
        const setters = s.targets.map((t) => this.target(t))
        const values = this.exprList(s.values)
        return (f) => {
          const assigns = setters.map((set) => set(f))
          const vs = values(f)
          for (let i = 0; i < assigns.length; i++) assigns[i](vs[i])
          return undefined
        }
      }
      case "call": {
        const call = this.multi(s.call)
        return (f) => void call(f)
      }
      case "do":
        return this.block(s.body)
      case "while": {
        const cond = this.expr(s.cond)
        const body = this.block(s.body)
        return (f) => {
          while (truthy(cond(f))) {
            tick(rt)
            const signal = body(f)
            if (signal === BREAK) break
            if (signal !== undefined) return signal
          }
          return undefined
        }
      }
      case "repeat": {
        const body = this.block(s.body)
        const cond = this.expr(s.cond)
        return (f) => {
          for (;;) {
            tick(rt)
            const signal = body(f)
            if (signal === BREAK) break
            if (signal !== undefined) return signal
            if (truthy(cond(f))) break
          }
          return undefined
        }
      }
      case "if": {
        const clauses = s.clauses.map((c) => ({ cond: this.expr(c.cond), body: this.block(c.body) }))
        const orelse = s.orelse ? this.block(s.orelse) : undefined
        return (f) => {
          for (const clause of clauses) if (truthy(clause.cond(f))) return clause.body(f)
          return orelse?.(f)
        }
      }
      case "fornum": {
        const start = this.expr(s.start)
        const stop = this.expr(s.stop)
        const step = s.step ? this.expr(s.step) : () => 1
        const set = this.declare(this.r.decls.get(s)![0])
        const body = this.block(s.body)
        const line = s.line
        return (f) => {
          const a = forNumber(start(f), "initial", line)
          const b = forNumber(stop(f), "limit", line)
          const d = forNumber(step(f), "step", line)
          if (d === 0) throw new LuaError("'for' step is zero", line)
          for (let i = a; d > 0 ? i <= b : i >= b; i += d) {
            tick(rt)
            set(f, i)
            const signal = body(f)
            if (signal === BREAK) break
            if (signal !== undefined) return signal
          }
          return undefined
        }
      }
      case "forin": {
        const exprs = this.exprList(s.exprs)
        const sets = this.r.decls.get(s)!.map((l) => this.declare(l))
        const body = this.block(s.body)
        const line = s.line
        return (f) => {
          const values = exprs(f)
          return runForIn(rt, values[0], values[1], values[2], f, sets, body, line)
        }
      }
      case "function": {
        const set = this.target(s.target)
        const make = this.function(s.fn)
        return (f) => {
          set(f)(make(f))
          return undefined
        }
      }
      case "return": {
        if (s.values.length === 1 && (s.values[0].k === "call" || s.values[0].k === "method")) {
          const values = this.multi(s.values[0])
          return (f) => new Return(values(f))
        }
        const values = this.exprList(s.values)
        return (f) => new Return(values(f))
      }
      case "break":
        return () => BREAK
    }
  }

  /** Returns a function that evaluates the target's object/key and yields a setter. */
  target(e: Expr): (f: Frame) => (v: LuaValue) => void {
    if (e.k === "name") {
      const res = this.r.names.get(e)!
      if (res.kind === "local") {
        const slot = res.local.slot
        if (!res.local.captured) return (f) => (v) => void (f.regs[slot] = v)
        return (f) => (v) => setCell(f.regs[slot] as Cell, v)
      }
      if (res.kind === "up") {
        const index = res.index
        return (f) => (v) => setCell(f.ups[index], v)
      }
      const globals = this.rt.globals
      const name = res.name
      return () => (v) => globals.set(name, v)
    }
    if (e.k === "index") {
      const obj = this.expr(e.obj)
      const key = this.expr(e.key)
      const line = e.line
      const desc = describe(e.obj, this.r)
      return (f) => {
        const o = obj(f)
        const k = key(f)
        return (v) => {
          if (!(o instanceof LuaTable)) throw new LuaError(`attempt to index a ${typeName(o)} value${desc}`, line)
          try {
            o.set(k, v)
          } catch (error) {
            throw error instanceof LuaError ? error.withLine(line) : error
          }
        }
      }
    }
    throw new LuaError("cannot assign to this expression", e.line)
  }

  exprList(exprs: Expr[]): Multi {
    if (exprs.length === 0) return () => EMPTY
    const last = exprs[exprs.length - 1]
    const lastMulti = last.k === "call" || last.k === "method" || last.k === "vararg"
    const singles = (lastMulti ? exprs.slice(0, -1) : exprs).map((e) => this.expr(e))
    if (!lastMulti) {
      if (singles.length === 1) {
        const only = singles[0]
        return (f) => [only(f)]
      }
      return (f) => singles.map((s) => s(f))
    }
    const tail = this.multi(last)
    if (singles.length === 0) return tail
    return (f) => {
      const head = singles.map((s) => s(f))
      return head.concat(tail(f))
    }
  }

  /** Expressions that can produce several values: calls, method calls and `...`. */
  multi(e: Expr): Multi {
    const rt = this.rt
    if (e.k === "vararg") return (f) => f.va
    if (e.k === "call") {
      const fn = this.expr(e.fn)
      const args = this.exprList(e.args)
      const line = e.line
      const desc = describe(e.fn, this.r)
      return (f) => call(rt, fn(f), args(f), line, desc)
    }
    if (e.k === "method") {
      const obj = this.expr(e.obj)
      const args = this.exprList(e.args)
      const name = e.name
      const line = e.line
      const desc = describe(e.obj, this.r)
      return (f) => {
        const o = obj(f)
        const method = index(rt, o, name, line, desc)
        const a = args(f)
        return call(rt, method, [o, ...a], line, ` (method '${name}')`)
      }
    }
    const single = this.expr(e)
    return (f) => [single(f)]
  }

  expr(e: Expr): Ev {
    const rt = this.rt
    switch (e.k) {
      case "nil": return () => undefined
      case "true": return () => true
      case "false": return () => false
      case "number": { const v = e.value; return () => v }
      case "string": { const v = e.value; return () => v }
      case "vararg": return (f) => f.va[0]
      case "paren": return this.expr(e.expr)
      case "function": return this.function(e.fn)
      case "name": {
        const res = this.r.names.get(e)!
        if (res.kind === "local") {
          const slot = res.local.slot
          return res.local.captured ? (f) => (f.regs[slot] as Cell).v : (f) => f.regs[slot] as LuaValue
        }
        if (res.kind === "up") {
          const index = res.index
          return (f) => f.ups[index].v
        }
        const globals = rt.globals
        const name = res.name
        return () => globals.get(name)
      }
      case "index": {
        const obj = this.expr(e.obj)
        const key = this.expr(e.key)
        const line = e.line
        const desc = describe(e.obj, this.r)
        return (f) => index(rt, obj(f), key(f), line, desc)
      }
      case "call":
      case "method": {
        const m = this.multi(e)
        return (f) => m(f)[0]
      }
      case "and": {
        const left = this.expr(e.left)
        const right = this.expr(e.right)
        return (f) => {
          const l = left(f)
          return truthy(l) ? right(f) : l
        }
      }
      case "or": {
        const left = this.expr(e.left)
        const right = this.expr(e.right)
        return (f) => {
          const l = left(f)
          return truthy(l) ? l : right(f)
        }
      }
      case "unop": return this.unop(e.op, this.expr(e.expr), e.line, describe(e.expr, this.r))
      case "binop": return this.binop(e)
      case "table": {
        const items = e.items.map((item, i) => {
          const isLast = i === e.items.length - 1
          if (item.k === "pos" && isLast && (item.value.k === "call" || item.value.k === "method" || item.value.k === "vararg"))
            return { k: "spread" as const, value: this.multi(item.value) }
          if (item.k === "pos") return { k: "pos" as const, value: this.expr(item.value) }
          if (item.k === "named") return { k: "keyed" as const, key: (() => item.name) as Ev, value: this.expr(item.value) }
          return { k: "keyed" as const, key: this.expr(item.key), value: this.expr(item.value) }
        })
        const line = e.line
        return (f) => {
          const t = new LuaTable()
          let n = 1
          for (const item of items) {
            if (item.k === "pos") t.rawSet(n++, item.value(f))
            else if (item.k === "spread") for (const v of item.value(f)) t.rawSet(n++, v)
            else {
              const k = item.key(f)
              if (k === undefined) throw new LuaError("table index is nil", line)
              t.rawSet(k, item.value(f))
            }
          }
          return t
        }
      }
    }
  }

  unop(op: string, operand: Ev, line: number, desc: string): Ev {
    if (op === "not") return (f) => !truthy(operand(f))
    if (op === "-")
      return (f) => {
        const v = operand(f)
        if (typeof v === "number") return -v
        const n = toNumber(v)
        if (n === undefined) throw new LuaError(`attempt to perform arithmetic on a ${typeName(v)} value${desc}`, line)
        return -n
      }
    // #
    return (f) => {
      const v = operand(f)
      if (typeof v === "string") return v.length
      if (v instanceof LuaTable) return v.length()
      throw new LuaError(`attempt to get length of a ${typeName(v)} value${desc}`, line)
    }
  }

  binop(e: Extract<Expr, { k: "binop" }>): Ev {
    const left = this.expr(e.left)
    const right = this.expr(e.right)
    const line = e.line
    const r = this.r
    const descs = () => [describe(e.left, r), describe(e.right, r)]
    switch (e.op) {
      case "+": return arith(left, right, (a, b) => a + b, line, descs)
      case "-": return arith(left, right, (a, b) => a - b, line, descs)
      case "*": return arith(left, right, (a, b) => a * b, line, descs)
      case "/": return arith(left, right, (a, b) => a / b, line, descs)
      case "%": return arith(left, right, (a, b) => (b === Infinity ? (a >= 0 ? a : b) : b === -Infinity ? (a <= 0 ? a : b) : a - Math.floor(a / b) * b), line, descs)
      case "//": return arith(left, right, (a, b) => Math.floor(a / b), line, descs)
      case "^": return arith(left, right, (a, b) => a ** b, line, descs)
      case "..":
        return (f) => {
          const a = left(f)
          const b = right(f)
          if ((typeof a === "string" || typeof a === "number") && (typeof b === "string" || typeof b === "number"))
            return (typeof a === "number" ? formatNumber(a) : a) + (typeof b === "number" ? formatNumber(b) : b)
          const [da, db] = descs()
          const bad = typeof a === "string" || typeof a === "number" ? [b, db] : [a, da]
          throw new LuaError(`attempt to concatenate a ${typeName(bad[0] as LuaValue)} value${bad[1]}`, line)
        }
      case "==": return (f) => left(f) === right(f)
      case "~=": return (f) => left(f) !== right(f)
      case "<": return compare(left, right, (a, b) => a < b, line)
      case "<=": return compare(left, right, (a, b) => a <= b, line)
      case ">": return compare(left, right, (a, b) => a > b, line)
      case ">=": return compare(left, right, (a, b) => a >= b, line)
    }
    throw new LuaError(`unsupported operator ${e.op}`, line)
  }
}

const EMPTY: LuaValue[] = []

function setCell(cell: Cell, v: LuaValue) {
  if (journal.active && cell.v !== v) {
    const old = cell.v
    journal.entries.push(() => void (cell.v = old))
  }
  cell.v = v
}

function tick(rt: Runtime) {
  if (++rt.steps > rt.maxSteps) {
    rt.steps = 0
    throw new LuaLimitError("program ran too long (step limit exceeded)")
  }
}

export function typeName(v: LuaValue) {
  if (v === undefined) return "nil"
  if (v instanceof LuaTable) return "table"
  if (v instanceof LuaFunction) return "function"
  return typeof v
}

/** " (global 'x')", " (local 'x')", " (field 'y')" for error messages. */
function describe(e: Expr, r: Resolver): string {
  if (e.k === "name") {
    const res = r.names.get(e)
    if (!res) return ""
    return res.kind === "global" ? ` (global '${e.name}')` : res.kind === "local" ? ` (local '${e.name}')` : ` (upvalue '${e.name}')`
  }
  if (e.k === "index" && e.key.k === "string") return ` (field '${e.key.value}')`
  if (e.k === "method") return ` (method '${e.name}')`
  return ""
}

export function index(rt: Runtime, o: LuaValue, k: LuaValue, line: number, desc: string): LuaValue {
  if (o instanceof LuaTable) {
    if (o.unavailable) throw new LuaError(`the '${o.unavailable}' library is not available in widgets`, line)
    return o.get(k)
  }
  if (typeof o === "string") return rt.stringMeta.get(k)
  throw new LuaError(`attempt to index a ${typeName(o)} value${desc}`, line)
}

export function call(rt: Runtime, fn: LuaValue, args: LuaValue[], line: number, desc: string): LuaValue[] {
  if (!(fn instanceof LuaFunction)) throw new LuaError(`attempt to call a ${typeName(fn)} value${desc}`, line)
  try {
    return fn.call(args)
  } catch (error) {
    if (error instanceof LuaError) throw error.withLine(line)
    if (error instanceof RangeError) throw new LuaLimitError("stack overflow", line)
    throw error
  }
}

function arith(left: Ev, right: Ev, op: (a: number, b: number) => number, line: number, descs: () => string[]): Ev {
  return (f) => {
    const a = left(f)
    const b = right(f)
    if (typeof a === "number" && typeof b === "number") return op(a, b)
    const x = toNumber(a)
    const y = toNumber(b)
    if (x !== undefined && y !== undefined) return op(x, y)
    const [da, db] = descs()
    const [bad, desc] = x === undefined ? [a, da] : [b, db]
    throw new LuaError(`attempt to perform arithmetic on a ${typeName(bad)} value${desc}`, line)
  }
}

function compare(left: Ev, right: Ev, op: (a: number | string, b: number | string) => boolean, line: number): Ev {
  return (f) => {
    const a = left(f)
    const b = right(f)
    if ((typeof a === "number" && typeof b === "number") || (typeof a === "string" && typeof b === "string")) return op(a, b)
    const ta = typeName(a)
    const tb = typeName(b)
    throw new LuaError(ta === tb ? `attempt to compare two ${ta} values` : `attempt to compare ${ta} with ${tb}`, line)
  }
}

function forNumber(v: LuaValue, what: string, line: number): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? toNumber(v) : undefined
  if (n === undefined) throw new LuaError(`'for' ${what} value must be a number`, line)
  return n
}

function runForIn(
  rt: Runtime,
  iter: LuaValue,
  state: LuaValue,
  initial: LuaValue,
  f: Frame,
  sets: ((f: Frame, v: LuaValue) => void)[],
  body: Ex,
  line: number,
): Signal {
  let control = initial
  for (;;) {
    tick(rt)
    const results = call(rt, iter, [state, control], line, " (for iterator)")
    const first = results[0]
    if (first === undefined) return undefined
    control = first
    for (let i = 0; i < sets.length; i++) sets[i](f, results[i])
    const signal = body(f)
    if (signal === BREAK) return undefined
    if (signal !== undefined) return signal
  }
}

export { tostring, Cell }
