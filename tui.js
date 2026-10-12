// @bun
// src/lua/value.ts
class Journal {
  entries = [];
  active = false;
  epoch = 0;
}
var journal = new Journal;

class LuaTable {
  arr = [];
  hash = new Map;
  unavailable;
  born = journal.epoch;
  get(key) {
    if (typeof key === "number") {
      const i = key - 1;
      if (i >= 0 && i < this.arr.length && Number.isInteger(key))
        return this.arr[i];
    }
    return this.hash.get(key);
  }
  set(key, value) {
    if (key === undefined)
      throw new LuaError("table index is nil");
    if (typeof key === "number" && Number.isNaN(key))
      throw new LuaError("table index is NaN");
    if (journal.active && this.born !== journal.epoch) {
      const old = this.get(key);
      if (old !== value)
        journal.entries.push(() => this.rawSet(key, old));
    }
    this.rawSet(key, value);
  }
  rawSet(key, value) {
    if (typeof key === "number" && Number.isInteger(key) && key >= 1) {
      const i = key - 1;
      const n = this.arr.length;
      if (i < n) {
        this.arr[i] = value;
        if (value === undefined && i === n - 1) {
          while (this.arr.length && this.arr[this.arr.length - 1] === undefined)
            this.arr.pop();
        }
        return;
      }
      if (i === n && value !== undefined) {
        this.arr.push(value);
        this.hash.delete(key);
        let next = key + 1;
        while (this.hash.has(next)) {
          this.arr.push(this.hash.get(next));
          this.hash.delete(next);
          next++;
        }
        return;
      }
    }
    if (value === undefined)
      this.hash.delete(key);
    else
      this.hash.set(key, value);
  }
  length() {
    return this.arr.length;
  }
  next(key) {
    let start = 0;
    if (key !== undefined) {
      if (typeof key === "number" && Number.isInteger(key) && key >= 1 && key <= this.arr.length)
        start = key;
      else {
        const keys = [...this.hash.keys()];
        const at = keys.indexOf(key);
        if (at === -1)
          throw new LuaError("invalid key to 'next'");
        for (let j = at + 1;j < keys.length; j++) {
          const v = this.hash.get(keys[j]);
          if (v !== undefined)
            return [keys[j], v];
        }
        return;
      }
    }
    for (let j = start;j < this.arr.length; j++)
      if (this.arr[j] !== undefined)
        return [j + 1, this.arr[j]];
    for (const [k, v] of this.hash)
      if (v !== undefined)
        return [k, v];
    return;
  }
  static from(values, fields) {
    const t = new LuaTable;
    values.forEach((v, i) => t.rawSet(i + 1, v));
    if (fields)
      for (const [k, v] of Object.entries(fields))
        t.rawSet(k, v);
    return t;
  }
}

class LuaFunction {
  name;
  call;
  constructor(name, call) {
    this.name = name;
    this.call = call;
  }
}

class LuaError extends Error {
  value;
  traceLine;
  constructor(value, line) {
    const text = typeof value === "string" ? value : tostring(value);
    super(line !== undefined ? `line ${line}: ${text}` : text);
    this.value = line !== undefined && typeof value === "string" ? `line ${line}: ${value}` : value;
    this.traceLine = line;
  }
  withLine(line) {
    if (this.traceLine !== undefined || typeof this.value !== "string")
      return this;
    return new this.constructor(this.value, line);
  }
}

class LuaLimitError extends LuaError {
}
function type(v) {
  if (v === undefined)
    return "nil";
  if (typeof v === "boolean")
    return "boolean";
  if (typeof v === "number")
    return "number";
  if (typeof v === "string")
    return "string";
  if (v instanceof LuaTable)
    return "table";
  return "function";
}
var ids = new WeakMap;
var nextId = 1;
var addressOf = (o) => {
  let id = ids.get(o);
  if (id === undefined)
    ids.set(o, id = nextId++);
  return "0x" + id.toString(16).padStart(8, "0");
};
function tostring(v) {
  if (v === undefined)
    return "nil";
  if (v === true)
    return "true";
  if (v === false)
    return "false";
  if (typeof v === "number")
    return formatNumber(v);
  if (typeof v === "string")
    return v;
  if (v instanceof LuaTable)
    return "table: " + addressOf(v);
  return (v.name.startsWith("builtin") ? "builtin: " : "function: ") + addressOf(v);
}
function formatNumber(n) {
  if (Number.isNaN(n))
    return n > 0 || Object.is(n, NaN) ? "nan" : "-nan";
  if (n === Infinity)
    return "inf";
  if (n === -Infinity)
    return "-inf";
  if (Number.isInteger(n) && Math.abs(n) < 1000000000000000)
    return String(n);
  return formatG(n, 14, false);
}
function formatG(n, precision, alt, upper = false) {
  if (!Number.isFinite(n))
    return Number.isNaN(n) ? "nan" : n > 0 ? "inf" : "-inf";
  const p = precision === 0 ? 1 : precision;
  if (n === 0)
    return alt ? 0 .toFixed(p - 1) : Object.is(n, -0) ? "-0" : "0";
  const exp = Math.floor(Math.log10(Math.abs(Number(n.toExponential(p - 1)))));
  let out;
  if (exp < -4 || exp >= p) {
    out = n.toExponential(p - 1);
    if (!alt)
      out = out.replace(/\.?0+e/, "e");
    out = out.replace(/e([+-])(\d)$/, "e$10$2");
  } else {
    out = n.toFixed(Math.max(0, p - 1 - exp));
    if (!alt && out.includes("."))
      out = out.replace(/\.?0+$/, "");
  }
  return upper ? out.toUpperCase() : out;
}
function truthy(v) {
  return v !== undefined && v !== false;
}
function toNumber(v) {
  if (typeof v === "number")
    return v;
  if (typeof v === "string")
    return stringToNumber(v);
  return;
}
function stringToNumber(s) {
  const t = s.trim();
  if (t === "")
    return;
  const hex = /^([+-])?0[xX]([0-9a-fA-F]+)(?:\.([0-9a-fA-F]*))?(?:[pP]([+-]?\d+))?$/.exec(t);
  if (hex) {
    let value = parseInt(hex[2], 16);
    const frac = hex[3] ?? "";
    for (let k = 0;k < frac.length; k++)
      value += parseInt(frac[k], 16) / 16 ** (k + 1);
    if (hex[4])
      value *= 2 ** Number(hex[4]);
    return hex[1] === "-" ? -value : value;
  }
  if (/^[+-]?(inf|nan|infinity)$/i.test(t))
    return;
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t))
    return;
  return Number(t);
}

// src/lua/compiler.ts
class Cell {
  v;
  constructor(v) {
    this.v = v;
  }
}

class Return {
  values;
  constructor(values) {
    this.values = values;
  }
}
var BREAK = Symbol("break");

class Resolver {
  names = new Map;
  decls = new Map;
  fns = new Map;
  fn;
  function(body, parent) {
    const state = { parent, blocks: [new Map], slots: 0, upvalues: [], vararg: body.vararg };
    this.fns.set(body, state);
    const outer = this.fn;
    this.fn = state;
    this.decls.set(body, body.params.map((p) => this.declare(p)));
    this.block(body.body, false);
    this.fn = outer;
  }
  declare(name) {
    const local = { name, slot: this.fn.slots++, captured: false };
    this.fn.blocks[this.fn.blocks.length - 1].set(name, local);
    return local;
  }
  resolve(name, fn = this.fn) {
    for (let i = fn.blocks.length - 1;i >= 0; i--) {
      const local = fn.blocks[i].get(name);
      if (local)
        return { kind: "local", local };
    }
    const existing = fn.upvalues.findIndex((u) => u.name === name);
    if (existing !== -1)
      return { kind: "up", index: existing };
    if (!fn.parent)
      return { kind: "global", name };
    const outer = this.resolve(name, fn.parent);
    if (outer.kind === "global")
      return outer;
    if (outer.kind === "local")
      outer.local.captured = true;
    fn.upvalues.push(outer.kind === "local" ? { name, fromLocal: outer.local } : { name, fromUp: outer.index });
    return { kind: "up", index: fn.upvalues.length - 1 };
  }
  block(stats, scoped = true, extra) {
    if (scoped)
      this.fn.blocks.push(new Map);
    stats.forEach((s) => this.stat(s));
    extra?.();
    if (scoped)
      this.fn.blocks.pop();
  }
  stat(s) {
    switch (s.k) {
      case "local":
        s.values.forEach((e) => this.expr(e));
        this.decls.set(s, s.names.map((n) => this.declare(n)));
        return;
      case "localfunction":
        this.decls.set(s, [this.declare(s.name)]);
        this.function(s.fn, this.fn);
        return;
      case "assign":
        s.targets.forEach((e) => this.expr(e));
        s.values.forEach((e) => this.expr(e));
        return;
      case "call":
        return this.expr(s.call);
      case "do":
        return this.block(s.body);
      case "while":
        this.expr(s.cond);
        return this.block(s.body);
      case "repeat":
        return this.block(s.body, true, () => this.expr(s.cond));
      case "if":
        s.clauses.forEach((c) => {
          this.expr(c.cond);
          this.block(c.body);
        });
        if (s.orelse)
          this.block(s.orelse);
        return;
      case "fornum":
        this.expr(s.start);
        this.expr(s.stop);
        if (s.step)
          this.expr(s.step);
        this.fn.blocks.push(new Map);
        this.decls.set(s, [this.declare(s.name)]);
        this.block(s.body);
        this.fn.blocks.pop();
        return;
      case "forin":
        s.exprs.forEach((e) => this.expr(e));
        this.fn.blocks.push(new Map);
        this.decls.set(s, s.names.map((n) => this.declare(n)));
        this.block(s.body);
        this.fn.blocks.pop();
        return;
      case "function":
        this.expr(s.target);
        return this.function(s.fn, this.fn);
      case "return":
        return s.values.forEach((e) => this.expr(e));
      case "break":
        return;
    }
  }
  expr(e) {
    switch (e.k) {
      case "name":
        this.names.set(e, this.resolve(e.name));
        return;
      case "vararg":
        if (!this.fn.vararg)
          throw new LuaError("cannot use '...' outside a vararg function", e.line);
        return;
      case "function":
        return this.function(e.fn, this.fn);
      case "index":
        this.expr(e.obj);
        return this.expr(e.key);
      case "call":
        this.expr(e.fn);
        return e.args.forEach((a) => this.expr(a));
      case "method":
        this.expr(e.obj);
        return e.args.forEach((a) => this.expr(a));
      case "binop":
      case "and":
      case "or":
        this.expr(e.left);
        return this.expr(e.right);
      case "unop":
        return this.expr(e.expr);
      case "paren":
        return this.expr(e.expr);
      case "table":
        return e.items.forEach((item) => {
          if (item.k === "keyed")
            this.expr(item.key);
          this.expr(item.value);
        });
    }
  }
}
function compile(chunk, rt) {
  const resolver = new Resolver;
  resolver.function(chunk);
  const c = new Compiler(resolver, rt);
  const make = c.function(chunk);
  return make({ regs: [], ups: [], va: [] });
}

class Compiler {
  r;
  rt;
  constructor(r, rt) {
    this.r = r;
    this.rt = rt;
  }
  function(body) {
    const state = this.r.fns.get(body);
    const params = this.r.decls.get(body);
    const run = this.block(body.body);
    const rt = this.rt;
    const nparams = params.length;
    const ups = state.upvalues;
    const name = body.name;
    return (outer) => {
      const cells = ups.map((u) => u.fromLocal ? outer.regs[u.fromLocal.slot] : outer.ups[u.fromUp]);
      return new LuaFunction(name, (args) => {
        if (++rt.depth > rt.maxDepth) {
          rt.depth = 0;
          throw new LuaLimitError("stack overflow (too many nested calls)");
        }
        tick(rt);
        const regs = new Array(state.slots);
        for (let i = 0;i < nparams; i++) {
          const local = params[i];
          regs[local.slot] = local.captured ? new Cell(args[i]) : args[i];
        }
        const f = { regs, ups: cells, va: state.vararg ? args.slice(nparams) : EMPTY };
        try {
          const signal = run(f);
          return signal instanceof Return ? signal.values : EMPTY;
        } finally {
          rt.depth--;
        }
      });
    };
  }
  block(stats) {
    const compiled = stats.map((s) => this.stat(s));
    if (compiled.length === 0)
      return () => {
        return;
      };
    if (compiled.length === 1)
      return compiled[0];
    return (f) => {
      for (let i = 0;i < compiled.length; i++) {
        const signal = compiled[i](f);
        if (signal !== undefined)
          return signal;
      }
      return;
    };
  }
  declare(local) {
    const slot = local.slot;
    return local.captured ? (f, v) => void (f.regs[slot] = new Cell(v)) : (f, v) => void (f.regs[slot] = v);
  }
  stat(s) {
    const rt = this.rt;
    switch (s.k) {
      case "local": {
        const locals = this.r.decls.get(s).map((l) => this.declare(l));
        if (s.values.length === 0)
          return (f) => void locals.forEach((d) => d(f, undefined));
        if (locals.length === 1 && s.values.length === 1) {
          const value = this.expr(s.values[0]);
          const d = locals[0];
          return (f) => void d(f, value(f));
        }
        const values = this.exprList(s.values);
        return (f) => {
          const vs = values(f);
          for (let i = 0;i < locals.length; i++)
            locals[i](f, vs[i]);
          return;
        };
      }
      case "localfunction": {
        const local = this.r.decls.get(s)[0];
        const make = this.function(s.fn);
        const slot = local.slot;
        if (!local.captured)
          return (f) => void (f.regs[slot] = make(f));
        return (f) => {
          const cell = new Cell(undefined);
          f.regs[slot] = cell;
          cell.v = make(f);
          return;
        };
      }
      case "assign": {
        if (s.targets.length === 1 && s.values.length === 1) {
          const set = this.target(s.targets[0]);
          const value = this.expr(s.values[0]);
          return (f) => {
            const assign = set(f);
            assign(value(f));
            return;
          };
        }
        const setters = s.targets.map((t) => this.target(t));
        const values = this.exprList(s.values);
        return (f) => {
          const assigns = setters.map((set) => set(f));
          const vs = values(f);
          for (let i = 0;i < assigns.length; i++)
            assigns[i](vs[i]);
          return;
        };
      }
      case "call": {
        const call = this.multi(s.call);
        return (f) => void call(f);
      }
      case "do":
        return this.block(s.body);
      case "while": {
        const cond = this.expr(s.cond);
        const body = this.block(s.body);
        return (f) => {
          while (truthy(cond(f))) {
            tick(rt);
            const signal = body(f);
            if (signal === BREAK)
              break;
            if (signal !== undefined)
              return signal;
          }
          return;
        };
      }
      case "repeat": {
        const body = this.block(s.body);
        const cond = this.expr(s.cond);
        return (f) => {
          for (;; ) {
            tick(rt);
            const signal = body(f);
            if (signal === BREAK)
              break;
            if (signal !== undefined)
              return signal;
            if (truthy(cond(f)))
              break;
          }
          return;
        };
      }
      case "if": {
        const clauses = s.clauses.map((c) => ({ cond: this.expr(c.cond), body: this.block(c.body) }));
        const orelse = s.orelse ? this.block(s.orelse) : undefined;
        return (f) => {
          for (const clause of clauses)
            if (truthy(clause.cond(f)))
              return clause.body(f);
          return orelse?.(f);
        };
      }
      case "fornum": {
        const start = this.expr(s.start);
        const stop = this.expr(s.stop);
        const step = s.step ? this.expr(s.step) : () => 1;
        const set = this.declare(this.r.decls.get(s)[0]);
        const body = this.block(s.body);
        const line = s.line;
        return (f) => {
          const a = forNumber(start(f), "initial", line);
          const b = forNumber(stop(f), "limit", line);
          const d = forNumber(step(f), "step", line);
          if (d === 0)
            throw new LuaError("'for' step is zero", line);
          for (let i = a;d > 0 ? i <= b : i >= b; i += d) {
            tick(rt);
            set(f, i);
            const signal = body(f);
            if (signal === BREAK)
              break;
            if (signal !== undefined)
              return signal;
          }
          return;
        };
      }
      case "forin": {
        const exprs = this.exprList(s.exprs);
        const sets = this.r.decls.get(s).map((l) => this.declare(l));
        const body = this.block(s.body);
        const line = s.line;
        return (f) => {
          const values = exprs(f);
          return runForIn(rt, values[0], values[1], values[2], f, sets, body, line);
        };
      }
      case "function": {
        const set = this.target(s.target);
        const make = this.function(s.fn);
        return (f) => {
          set(f)(make(f));
          return;
        };
      }
      case "return": {
        if (s.values.length === 1 && (s.values[0].k === "call" || s.values[0].k === "method")) {
          const values = this.multi(s.values[0]);
          return (f) => new Return(values(f));
        }
        const values = this.exprList(s.values);
        return (f) => new Return(values(f));
      }
      case "break":
        return () => BREAK;
    }
  }
  target(e) {
    if (e.k === "name") {
      const res = this.r.names.get(e);
      if (res.kind === "local") {
        const slot = res.local.slot;
        if (!res.local.captured)
          return (f) => (v) => void (f.regs[slot] = v);
        return (f) => (v) => setCell(f.regs[slot], v);
      }
      if (res.kind === "up") {
        const index = res.index;
        return (f) => (v) => setCell(f.ups[index], v);
      }
      const globals = this.rt.globals;
      const name = res.name;
      return () => (v) => globals.set(name, v);
    }
    if (e.k === "index") {
      const obj = this.expr(e.obj);
      const key = this.expr(e.key);
      const line = e.line;
      const desc = describe(e.obj, this.r);
      return (f) => {
        const o = obj(f);
        const k = key(f);
        return (v) => {
          if (!(o instanceof LuaTable))
            throw new LuaError(`attempt to index a ${typeName(o)} value${desc}`, line);
          try {
            o.set(k, v);
          } catch (error) {
            throw error instanceof LuaError ? error.withLine(line) : error;
          }
        };
      };
    }
    throw new LuaError("cannot assign to this expression", e.line);
  }
  exprList(exprs) {
    if (exprs.length === 0)
      return () => EMPTY;
    const last = exprs[exprs.length - 1];
    const lastMulti = last.k === "call" || last.k === "method" || last.k === "vararg";
    const singles = (lastMulti ? exprs.slice(0, -1) : exprs).map((e) => this.expr(e));
    if (!lastMulti) {
      if (singles.length === 1) {
        const only = singles[0];
        return (f) => [only(f)];
      }
      return (f) => singles.map((s) => s(f));
    }
    const tail = this.multi(last);
    if (singles.length === 0)
      return tail;
    return (f) => {
      const head = singles.map((s) => s(f));
      return head.concat(tail(f));
    };
  }
  multi(e) {
    const rt = this.rt;
    if (e.k === "vararg")
      return (f) => f.va;
    if (e.k === "call") {
      const fn = this.expr(e.fn);
      const args = this.exprList(e.args);
      const line = e.line;
      const desc = describe(e.fn, this.r);
      return (f) => call(rt, fn(f), args(f), line, desc);
    }
    if (e.k === "method") {
      const obj = this.expr(e.obj);
      const args = this.exprList(e.args);
      const name = e.name;
      const line = e.line;
      const desc = describe(e.obj, this.r);
      return (f) => {
        const o = obj(f);
        const method = index(rt, o, name, line, desc);
        const a = args(f);
        return call(rt, method, [o, ...a], line, ` (method '${name}')`);
      };
    }
    const single = this.expr(e);
    return (f) => [single(f)];
  }
  expr(e) {
    const rt = this.rt;
    switch (e.k) {
      case "nil":
        return () => {
          return;
        };
      case "true":
        return () => true;
      case "false":
        return () => false;
      case "number": {
        const v = e.value;
        return () => v;
      }
      case "string": {
        const v = e.value;
        return () => v;
      }
      case "vararg":
        return (f) => f.va[0];
      case "paren":
        return this.expr(e.expr);
      case "function":
        return this.function(e.fn);
      case "name": {
        const res = this.r.names.get(e);
        if (res.kind === "local") {
          const slot = res.local.slot;
          return res.local.captured ? (f) => f.regs[slot].v : (f) => f.regs[slot];
        }
        if (res.kind === "up") {
          const index = res.index;
          return (f) => f.ups[index].v;
        }
        const globals = rt.globals;
        const name = res.name;
        return () => globals.get(name);
      }
      case "index": {
        const obj = this.expr(e.obj);
        const key = this.expr(e.key);
        const line = e.line;
        const desc = describe(e.obj, this.r);
        return (f) => index(rt, obj(f), key(f), line, desc);
      }
      case "call":
      case "method": {
        const m = this.multi(e);
        return (f) => m(f)[0];
      }
      case "and": {
        const left = this.expr(e.left);
        const right = this.expr(e.right);
        return (f) => {
          const l = left(f);
          return truthy(l) ? right(f) : l;
        };
      }
      case "or": {
        const left = this.expr(e.left);
        const right = this.expr(e.right);
        return (f) => {
          const l = left(f);
          return truthy(l) ? l : right(f);
        };
      }
      case "unop":
        return this.unop(e.op, this.expr(e.expr), e.line, describe(e.expr, this.r));
      case "binop":
        return this.binop(e);
      case "table": {
        const items = e.items.map((item, i) => {
          const isLast = i === e.items.length - 1;
          if (item.k === "pos" && isLast && (item.value.k === "call" || item.value.k === "method" || item.value.k === "vararg"))
            return { k: "spread", value: this.multi(item.value) };
          if (item.k === "pos")
            return { k: "pos", value: this.expr(item.value) };
          if (item.k === "named")
            return { k: "keyed", key: () => item.name, value: this.expr(item.value) };
          return { k: "keyed", key: this.expr(item.key), value: this.expr(item.value) };
        });
        const line = e.line;
        return (f) => {
          const t = new LuaTable;
          let n = 1;
          for (const item of items) {
            if (item.k === "pos")
              t.rawSet(n++, item.value(f));
            else if (item.k === "spread")
              for (const v of item.value(f))
                t.rawSet(n++, v);
            else {
              const k = item.key(f);
              if (k === undefined)
                throw new LuaError("table index is nil", line);
              t.rawSet(k, item.value(f));
            }
          }
          return t;
        };
      }
    }
  }
  unop(op, operand, line, desc) {
    if (op === "not")
      return (f) => !truthy(operand(f));
    if (op === "-")
      return (f) => {
        const v = operand(f);
        if (typeof v === "number")
          return -v;
        const n = toNumber(v);
        if (n === undefined)
          throw new LuaError(`attempt to perform arithmetic on a ${typeName(v)} value${desc}`, line);
        return -n;
      };
    return (f) => {
      const v = operand(f);
      if (typeof v === "string")
        return v.length;
      if (v instanceof LuaTable)
        return v.length();
      throw new LuaError(`attempt to get length of a ${typeName(v)} value${desc}`, line);
    };
  }
  binop(e) {
    const left = this.expr(e.left);
    const right = this.expr(e.right);
    const line = e.line;
    const r = this.r;
    const descs = () => [describe(e.left, r), describe(e.right, r)];
    switch (e.op) {
      case "+":
        return arith(left, right, (a, b) => a + b, line, descs);
      case "-":
        return arith(left, right, (a, b) => a - b, line, descs);
      case "*":
        return arith(left, right, (a, b) => a * b, line, descs);
      case "/":
        return arith(left, right, (a, b) => a / b, line, descs);
      case "%":
        return arith(left, right, (a, b) => b === Infinity ? a >= 0 ? a : b : b === -Infinity ? a <= 0 ? a : b : a - Math.floor(a / b) * b, line, descs);
      case "//":
        return arith(left, right, (a, b) => Math.floor(a / b), line, descs);
      case "^":
        return arith(left, right, (a, b) => a ** b, line, descs);
      case "..":
        return (f) => {
          const a = left(f);
          const b = right(f);
          if ((typeof a === "string" || typeof a === "number") && (typeof b === "string" || typeof b === "number"))
            return (typeof a === "number" ? formatNumber(a) : a) + (typeof b === "number" ? formatNumber(b) : b);
          const [da, db] = descs();
          const bad = typeof a === "string" || typeof a === "number" ? [b, db] : [a, da];
          throw new LuaError(`attempt to concatenate a ${typeName(bad[0])} value${bad[1]}`, line);
        };
      case "==":
        return (f) => left(f) === right(f);
      case "~=":
        return (f) => left(f) !== right(f);
      case "<":
        return compare(left, right, (a, b) => a < b, line);
      case "<=":
        return compare(left, right, (a, b) => a <= b, line);
      case ">":
        return compare(left, right, (a, b) => a > b, line);
      case ">=":
        return compare(left, right, (a, b) => a >= b, line);
    }
    throw new LuaError(`unsupported operator ${e.op}`, line);
  }
}
var EMPTY = [];
function setCell(cell, v) {
  if (journal.active && cell.v !== v) {
    const old = cell.v;
    journal.entries.push(() => void (cell.v = old));
  }
  cell.v = v;
}
function tick(rt) {
  if (++rt.steps > rt.maxSteps) {
    rt.steps = 0;
    throw new LuaLimitError("program ran too long (step limit exceeded)");
  }
}
function typeName(v) {
  if (v === undefined)
    return "nil";
  if (v instanceof LuaTable)
    return "table";
  if (v instanceof LuaFunction)
    return "function";
  return typeof v;
}
function describe(e, r) {
  if (e.k === "name") {
    const res = r.names.get(e);
    if (!res)
      return "";
    return res.kind === "global" ? ` (global '${e.name}')` : res.kind === "local" ? ` (local '${e.name}')` : ` (upvalue '${e.name}')`;
  }
  if (e.k === "index" && e.key.k === "string")
    return ` (field '${e.key.value}')`;
  if (e.k === "method")
    return ` (method '${e.name}')`;
  return "";
}
function index(rt, o, k, line, desc) {
  if (o instanceof LuaTable) {
    if (o.unavailable)
      throw new LuaError(`the '${o.unavailable}' library is not available in widgets`, line);
    return o.get(k);
  }
  if (typeof o === "string")
    return rt.stringMeta.get(k);
  throw new LuaError(`attempt to index a ${typeName(o)} value${desc}`, line);
}
function call(rt, fn, args, line, desc) {
  if (!(fn instanceof LuaFunction))
    throw new LuaError(`attempt to call a ${typeName(fn)} value${desc}`, line);
  try {
    return fn.call(args);
  } catch (error) {
    if (error instanceof LuaError)
      throw error.withLine(line);
    if (error instanceof RangeError)
      throw new LuaLimitError("stack overflow", line);
    throw error;
  }
}
function arith(left, right, op, line, descs) {
  return (f) => {
    const a = left(f);
    const b = right(f);
    if (typeof a === "number" && typeof b === "number")
      return op(a, b);
    const x = toNumber(a);
    const y = toNumber(b);
    if (x !== undefined && y !== undefined)
      return op(x, y);
    const [da, db] = descs();
    const [bad, desc] = x === undefined ? [a, da] : [b, db];
    throw new LuaError(`attempt to perform arithmetic on a ${typeName(bad)} value${desc}`, line);
  };
}
function compare(left, right, op, line) {
  return (f) => {
    const a = left(f);
    const b = right(f);
    if (typeof a === "number" && typeof b === "number" || typeof a === "string" && typeof b === "string")
      return op(a, b);
    const ta = typeName(a);
    const tb = typeName(b);
    throw new LuaError(ta === tb ? `attempt to compare two ${ta} values` : `attempt to compare ${ta} with ${tb}`, line);
  };
}
function forNumber(v, what, line) {
  const n = typeof v === "number" ? v : typeof v === "string" ? toNumber(v) : undefined;
  if (n === undefined)
    throw new LuaError(`'for' ${what} value must be a number`, line);
  return n;
}
function runForIn(rt, iter, state, initial, f, sets, body, line) {
  let control = initial;
  for (;; ) {
    tick(rt);
    const results = call(rt, iter, [state, control], line, " (for iterator)");
    const first = results[0];
    if (first === undefined)
      return;
    control = first;
    for (let i = 0;i < sets.length; i++)
      sets[i](f, results[i]);
    const signal = body(f);
    if (signal === BREAK)
      return;
    if (signal !== undefined)
      return signal;
  }
}

// src/lua/lib/format.ts
function format(fmt, args) {
  let out = "";
  let argi = 0;
  for (let i = 0;i < fmt.length; i++) {
    const c = fmt[i];
    if (c !== "%") {
      out += c;
      continue;
    }
    if (fmt[i + 1] === "%") {
      out += "%";
      i++;
      continue;
    }
    const m = /^([-+ #0]*)(\d*)(?:\.(\d*))?([a-zA-Z])/.exec(fmt.slice(i + 1));
    if (!m)
      throw new LuaError(`invalid conversion '%${fmt.slice(i + 1, i + 3)}' to 'format'`);
    const [whole, flags, widthText, precisionText, conv] = m;
    i += whole.length;
    const argn = ++argi;
    if (argn > args.length && conv !== "%")
      throw new LuaError(`bad argument #${argn + 1} to 'format' (no value)`);
    const arg = args[argn - 1];
    const width = widthText ? Number(widthText) : 0;
    const precision = precisionText === undefined ? undefined : Number(precisionText || "0");
    const left = flags.includes("-");
    const zero = flags.includes("0") && !left;
    const plus = flags.includes("+");
    const space = flags.includes(" ");
    const alt = flags.includes("#");
    const num = () => {
      if (typeof arg === "number")
        return arg;
      const n = typeof arg === "string" ? Number(arg.trim()) : NaN;
      if (typeof arg !== "string" || Number.isNaN(n))
        throw new LuaError(`bad argument #${argn + 1} to 'format' (number expected, got ${arg === undefined ? "no value" : type(arg)})`);
      return n;
    };
    const signed = (body, negative) => (negative ? "-" : plus ? "+" : space ? " " : "") + body;
    const pad = (text, numeric) => {
      if (text.length >= width)
        return text;
      if (left)
        return text + " ".repeat(width - text.length);
      if (zero && numeric) {
        const sign = /^[+\- ]/.test(text) ? text[0] : "";
        const rest = sign ? text.slice(1) : text;
        const prefix = /^0[xX]/.test(rest) ? rest.slice(0, 2) : "";
        return sign + prefix + "0".repeat(width - text.length) + rest.slice(prefix.length);
      }
      return " ".repeat(width - text.length) + text;
    };
    switch (conv) {
      case "d":
      case "i": {
        const n = Math.trunc(num());
        let body = Math.abs(n).toString();
        if (precision !== undefined)
          body = body.padStart(precision, "0");
        out += pad(signed(body, n < 0), precision === undefined);
        break;
      }
      case "u": {
        const n = Math.trunc(num());
        out += pad(String(n < 0 ? n + 2 ** 64 : n), true);
        break;
      }
      case "c":
        out += pad(String.fromCharCode(Math.trunc(num())), false);
        break;
      case "x":
      case "X":
      case "o": {
        const n = Math.trunc(num());
        let body = (n < 0 ? BigInt.asUintN(64, BigInt(n)) : BigInt(n)).toString(conv === "o" ? 8 : 16);
        if (precision !== undefined)
          body = body.padStart(precision, "0");
        if (alt && n !== 0)
          body = (conv === "o" ? "0" : "0x") + body;
        if (conv === "X")
          body = body.toUpperCase();
        out += pad(body, precision === undefined);
        break;
      }
      case "e":
      case "E": {
        const n = num();
        let body = Number.isFinite(n) ? Math.abs(n).toExponential(precision ?? 6).replace(/e([+-])(\d)$/, "e$10$2") : nonFinite(n);
        if (conv === "E")
          body = body.toUpperCase();
        out += pad(signed(body, n < 0 || Object.is(n, -0)), Number.isFinite(n));
        break;
      }
      case "f":
      case "F": {
        const n = num();
        let body = Number.isFinite(n) ? Math.abs(n).toFixed(precision ?? 6) : nonFinite(n);
        if (alt && precision === 0)
          body += ".";
        if (conv === "F")
          body = body.toUpperCase();
        out += pad(signed(body, n < 0 || Object.is(n, -0)), Number.isFinite(n));
        break;
      }
      case "g":
      case "G": {
        const n = num();
        const body = Number.isFinite(n) ? formatG(Math.abs(n), precision ?? 6, alt, conv === "G") : nonFinite(n);
        out += pad(signed(body, n < 0), Number.isFinite(n));
        break;
      }
      case "q":
        out += quote(arg);
        break;
      case "s": {
        let text = tostring(arg);
        if (precision !== undefined)
          text = text.slice(0, precision);
        out += pad(text, false);
        break;
      }
      case "a":
      case "A":
        throw new LuaError("'%a' is not supported in format");
      default:
        throw new LuaError(`invalid conversion '%${conv}' to 'format'`);
    }
  }
  return out;
}
function nonFinite(n) {
  return Number.isNaN(n) ? "nan" : "inf";
}
function quote(v) {
  if (typeof v === "string") {
    let out = '"';
    for (let i = 0;i < v.length; i++) {
      const c = v[i];
      const code = c.charCodeAt(0);
      if (c === '"' || c === "\\")
        out += "\\" + c;
      else if (c === `
`)
        out += "\\n";
      else if (c === "\r")
        out += "\\r";
      else if (c === "\x00")
        out += /[0-9]/.test(v[i + 1] ?? "") ? "\\000" : "\\0";
      else if (code < 32 || code === 127)
        out += "\\" + code;
      else
        out += c;
    }
    return out + '"';
  }
  if (typeof v === "number")
    return Number.isInteger(v) ? formatNumber(v) : v === Infinity ? "1e9999" : v === -Infinity ? "-1e9999" : Number.isNaN(v) ? "(0/0)" : formatG(v, 17, false);
  if (v === undefined || typeof v === "boolean")
    return tostring(v);
  throw new LuaError("bad argument to 'format' (value has no literal form)");
}

// src/lua/lib/pattern.ts
var CAP_UNFINISHED = -1;
var CAP_POSITION = -2;
var SPECIALS = /[\^$*+?.()[\]%-]/;
var MAX_CAPTURES = 32;

class MatchState {
  src;
  pat;
  level = 0;
  capture = [];
  matchdepth = 0;
  constructor(src, pat) {
    this.src = src;
    this.pat = pat;
  }
  classEnd(p) {
    const pat = this.pat;
    const c = pat[p++];
    if (c === "%") {
      if (p >= pat.length)
        throw new LuaError("malformed pattern (ends with '%')");
      return p + 1;
    }
    if (c === "[") {
      if (pat[p] === "^")
        p++;
      do {
        if (p >= pat.length)
          throw new LuaError("malformed pattern (missing ']')");
        const cc = pat[p++];
        if (cc === "%")
          p++;
      } while (pat[p] !== "]");
      return p + 1;
    }
    return p;
  }
  singleMatch(s, p, ep) {
    if (s >= this.src.length)
      return false;
    const c = this.src[s];
    const pc = this.pat[p];
    if (pc === ".")
      return true;
    if (pc === "%")
      return matchClass(c, this.pat[p + 1]);
    if (pc === "[")
      return this.matchBracket(c, p, ep - 1);
    return pc === c;
  }
  matchBracket(c, p, ec) {
    const pat = this.pat;
    let sig = true;
    if (pat[p + 1] === "^") {
      sig = false;
      p++;
    }
    while (++p < ec) {
      if (pat[p] === "%") {
        p++;
        if (matchClass(c, pat[p]))
          return sig;
      } else if (pat[p + 1] === "-" && p + 2 < ec) {
        p += 2;
        if (pat[p - 2] <= c && c <= pat[p])
          return sig;
      } else if (pat[p] === c)
        return sig;
    }
    return !sig;
  }
  doMatch(s, p) {
    if (++this.matchdepth > 200)
      throw new LuaError("pattern too complex");
    try {
      const pat = this.pat;
      const src = this.src;
      for (;; ) {
        if (p === pat.length)
          return s;
        const pc = pat[p];
        if (pc === "(") {
          return pat[p + 1] === ")" ? this.startCapture(s, p + 2, CAP_POSITION) : this.startCapture(s, p + 1, CAP_UNFINISHED);
        }
        if (pc === ")")
          return this.endCapture(s, p + 1);
        if (pc === "$" && p + 1 === pat.length)
          return s === src.length ? s : -1;
        if (pc === "%" && pat[p + 1] === "b") {
          s = this.matchBalance(s, p + 2);
          if (s === -1)
            return -1;
          p += 4;
          continue;
        }
        if (pc === "%" && pat[p + 1] === "f") {
          p += 2;
          if (pat[p] !== "[")
            throw new LuaError("missing '[' after '%f' in pattern");
          const ep = this.classEnd(p);
          const prev = s === 0 ? "\x00" : src[s - 1];
          const cur = s < src.length ? src[s] : "\x00";
          if (!this.matchBracket(prev, p, ep - 1) && this.matchBracket(cur, p, ep - 1)) {
            p = ep;
            continue;
          }
          return -1;
        }
        if (pc === "%" && /[0-9]/.test(pat[p + 1] ?? "")) {
          s = this.matchCapture(s, Number(pat[p + 1]));
          if (s === -1)
            return -1;
          p += 2;
          continue;
        }
        const ep = this.classEnd(p);
        const epc = pat[ep];
        if (!this.singleMatch(s, p, ep)) {
          if (epc === "*" || epc === "?" || epc === "-") {
            p = ep + 1;
            continue;
          }
          return -1;
        }
        if (epc === "?") {
          const res = this.doMatch(s + 1, ep + 1);
          if (res !== -1)
            return res;
          p = ep + 1;
          continue;
        }
        if (epc === "+")
          return this.maxExpand(s + 1, p, ep);
        if (epc === "*")
          return this.maxExpand(s, p, ep);
        if (epc === "-")
          return this.minExpand(s, p, ep);
        s++;
        p = ep;
      }
    } finally {
      this.matchdepth--;
    }
  }
  maxExpand(s, p, ep) {
    let i = 0;
    while (this.singleMatch(s + i, p, ep))
      i++;
    while (i >= 0) {
      const res = this.doMatch(s + i, ep + 1);
      if (res !== -1)
        return res;
      i--;
    }
    return -1;
  }
  minExpand(s, p, ep) {
    for (;; ) {
      const res = this.doMatch(s, ep + 1);
      if (res !== -1)
        return res;
      if (this.singleMatch(s, p, ep))
        s++;
      else
        return -1;
    }
  }
  startCapture(s, p, what) {
    if (this.level >= MAX_CAPTURES)
      throw new LuaError("too many captures");
    this.capture[this.level] = { init: s, len: what };
    this.level++;
    const res = this.doMatch(s, p);
    if (res === -1)
      this.level--;
    return res;
  }
  endCapture(s, p) {
    const l = this.captureToClose();
    this.capture[l].len = s - this.capture[l].init;
    const res = this.doMatch(s, p);
    if (res === -1)
      this.capture[l].len = CAP_UNFINISHED;
    return res;
  }
  captureToClose() {
    for (let l = this.level - 1;l >= 0; l--)
      if (this.capture[l].len === CAP_UNFINISHED)
        return l;
    throw new LuaError("invalid pattern capture");
  }
  matchBalance(s, p) {
    if (p + 1 >= this.pat.length)
      throw new LuaError("missing arguments to '%b'");
    const src = this.src;
    if (s >= src.length || src[s] !== this.pat[p])
      return -1;
    const b = this.pat[p];
    const e = this.pat[p + 1];
    let cont = 1;
    while (++s < src.length) {
      if (src[s] === e) {
        if (--cont === 0)
          return s + 1;
      } else if (src[s] === b)
        cont++;
    }
    return -1;
  }
  matchCapture(s, digit) {
    const l = digit - 1;
    if (l < 0 || l >= this.level || this.capture[l].len === CAP_UNFINISHED)
      throw new LuaError(`invalid capture index %${digit}`);
    const { init, len } = this.capture[l];
    const text = this.src.slice(init, init + len);
    if (this.src.length - s >= len && this.src.slice(s, s + len) === text)
      return s + len;
    return -1;
  }
  getCapture(i, s, e) {
    if (i >= this.level) {
      if (i === 0)
        return this.src.slice(s, e);
      throw new LuaError(`invalid capture index %${i + 1}`);
    }
    const { init, len } = this.capture[i];
    if (len === CAP_UNFINISHED)
      throw new LuaError("unfinished capture");
    if (len === CAP_POSITION)
      return init + 1;
    return this.src.slice(init, init + len);
  }
  captures(s, e, wholeIfNone) {
    const n = this.level === 0 && wholeIfNone ? 1 : this.level;
    return Array.from({ length: n }, (_, i) => this.getCapture(i, s, e));
  }
}
function matchClass(c, cl) {
  const code = c.charCodeAt(0);
  let res;
  switch (cl.toLowerCase()) {
    case "a":
      res = /[A-Za-z]/.test(c);
      break;
    case "c":
      res = code < 32 || code === 127;
      break;
    case "d":
      res = code >= 48 && code <= 57;
      break;
    case "g":
      res = code > 32 && code < 127;
      break;
    case "l":
      res = code >= 97 && code <= 122;
      break;
    case "p":
      res = /[!-/:-@[-`{-~]/.test(c);
      break;
    case "s":
      res = c === " " || code >= 9 && code <= 13;
      break;
    case "u":
      res = code >= 65 && code <= 90;
      break;
    case "w":
      res = /[A-Za-z0-9]/.test(c);
      break;
    case "x":
      res = /[0-9A-Fa-f]/.test(c);
      break;
    default:
      return cl === c;
  }
  return cl >= "A" && cl <= "Z" ? !res : res;
}
function startIndex(len, init) {
  if (init === undefined)
    return 0;
  if (init > 0)
    return init - 1;
  if (init === 0)
    return 0;
  return Math.max(0, len + init);
}
function find(s, pat, init, plain, isFind) {
  let start = startIndex(s.length, init);
  if (start > s.length)
    return [undefined];
  if (isFind && (plain || !SPECIALS.test(pat))) {
    const at = s.indexOf(pat, start);
    return at === -1 ? [undefined] : [at + 1, at + pat.length];
  }
  const anchor = pat[0] === "^";
  const p0 = anchor ? 1 : 0;
  do {
    const ms = new MatchState(s, pat);
    const e = ms.doMatch(start, p0);
    if (e !== -1) {
      if (isFind)
        return [start + 1, e, ...ms.captures(start, e, false)];
      return ms.captures(start, e, true);
    }
    start++;
  } while (start <= s.length && !anchor);
  return [undefined];
}
function gmatch(s, pat) {
  let pos = 0;
  let lastMatch = -1;
  return () => {
    for (;pos <= s.length; pos++) {
      const ms = new MatchState(s, pat);
      const e = ms.doMatch(pos, 0);
      if (e !== -1 && e !== lastMatch) {
        const start = pos;
        pos = lastMatch = e;
        return ms.captures(start, e, true);
      }
    }
    return [undefined];
  };
}
function gsub(s, pat, repl, max) {
  const anchor = pat[0] === "^";
  const p0 = anchor ? 1 : 0;
  let out = "";
  let pos = 0;
  let count = 0;
  let lastMatch = -1;
  while (max === undefined || count < max) {
    const ms = new MatchState(s, pat);
    const e = ms.doMatch(pos, p0);
    if (e !== -1 && e !== lastMatch) {
      count++;
      const whole = s.slice(pos, e);
      const replaced = repl(whole, ms.captures(pos, e, true));
      out += replaced ?? whole;
      pos = lastMatch = e;
    } else if (pos < s.length)
      out += s[pos++];
    else
      break;
    if (anchor)
      break;
  }
  return [out + s.slice(pos), count];
}

// src/lua/lib/stdlib.ts
var fn = (name, f) => new LuaFunction(`builtin ${name}`, (args) => {
  const r = f(...args);
  return Array.isArray(r) ? r : [r];
});
function argError(n, name, message) {
  throw new LuaError(`bad argument #${n} to '${name}' (${message})`);
}
function checkTable(v, n, name) {
  if (v instanceof LuaTable)
    return v;
  argError(n, name, `table expected, got ${v === undefined ? "no value" : type(v)}`);
}
function checkNumber(v, n, name) {
  if (typeof v === "number")
    return v;
  const parsed = typeof v === "string" ? stringToNumber(v) : undefined;
  if (parsed !== undefined)
    return parsed;
  argError(n, name, `number expected, got ${v === undefined ? "no value" : type(v)}`);
}
function optNumber(v, n, name, fallback) {
  return v === undefined ? fallback : checkNumber(v, n, name);
}
function checkString(v, n, name) {
  if (typeof v === "string")
    return v;
  if (typeof v === "number")
    return tostring(v);
  argError(n, name, `string expected, got ${v === undefined ? "no value" : type(v)}`);
}
function checkFunction(v, n, name) {
  if (v instanceof LuaFunction)
    return v;
  argError(n, name, `function expected, got ${v === undefined ? "no value" : type(v)}`);
}
function unsupported(name, hint) {
  return fn(name, () => {
    throw new LuaError(`${name} is not supported in widgets (${hint})`);
  });
}
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = a + 1831565813 >>> 0;
    let t = a;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function installStdlib(rt, options = {}) {
  const G = rt.globals;
  const set = (name, f) => G.rawSet(name, fn(name, f));
  set("print", (...args) => {
    options.print?.(args.map(tostring).join("\t"));
    return [];
  });
  set("type", (...args) => {
    if (args.length === 0)
      argError(1, "type", "value expected");
    return type(args[0]);
  });
  set("tostring", (v) => tostring(v));
  set("tonumber", (v, base) => {
    if (base === undefined) {
      if (typeof v === "number")
        return v;
      return typeof v === "string" ? stringToNumber(v) : undefined;
    }
    const b = checkNumber(base, 2, "tonumber");
    if (b < 2 || b > 36)
      argError(2, "tonumber", "base out of range");
    const s = checkString(v, 1, "tonumber").trim().toLowerCase();
    const digits = "0123456789abcdefghijklmnopqrstuvwxyz".slice(0, b);
    const neg = s.startsWith("-");
    const body = neg ? s.slice(1) : s;
    if (!body || [...body].some((c) => !digits.includes(c)))
      return;
    const n = [...body].reduce((acc, c) => acc * b + digits.indexOf(c), 0);
    return neg ? -n : n;
  });
  set("ipairs", (t) => {
    const table = checkTable(t, 1, "ipairs");
    const iter = fn("ipairs_iterator", (_, i) => {
      const next = i + 1;
      const v = table.get(next);
      return v === undefined ? [undefined] : [next, v];
    });
    return [iter, table, 0];
  });
  set("pairs", (t) => {
    const table = checkTable(t, 1, "pairs");
    let i = 0;
    let keys;
    const iter = fn("pairs_iterator", () => {
      while (i < table.arr.length) {
        const v = table.arr[i++];
        if (v !== undefined)
          return [i, v];
      }
      keys ??= table.hash.keys();
      for (;; ) {
        const next = keys.next();
        if (next.done)
          return [undefined];
        const v = table.hash.get(next.value);
        if (v !== undefined)
          return [next.value, v];
      }
    });
    return [iter, table, undefined];
  });
  set("next", (t, k) => checkTable(t, 1, "next").next(k) ?? [undefined]);
  set("select", (n, ...rest) => {
    if (n === "#")
      return rest.length;
    const i = Math.trunc(checkNumber(n, 1, "select"));
    if (i < 0) {
      if (-i > rest.length)
        argError(1, "select", "index out of range");
      return rest.slice(rest.length + i);
    }
    if (i === 0)
      argError(1, "select", "index out of range");
    return rest.slice(i - 1);
  });
  set("error", (message, level) => {
    if (typeof message === "string" && level !== 0)
      throw new LuaError(message);
    const error = new LuaError(message);
    error.traceLine = -1;
    throw error;
  });
  set("assert", (v, message, ...rest) => {
    if (truthy(v))
      return [v, message, ...rest];
    if (message === undefined)
      throw new LuaError("assertion failed!");
    const error = new LuaError(message);
    error.traceLine = -1;
    throw error;
  });
  set("pcall", (f, ...args) => {
    try {
      return [true, ...call(rt, f, args, 0, "")];
    } catch (error) {
      if (error instanceof LuaLimitError)
        throw error;
      if (error instanceof LuaError)
        return [false, error.value];
      throw error;
    }
  });
  set("unpack", (t, i, j) => unpack(t, i, j, "unpack"));
  set("rawget", (t, k) => checkTable(t, 1, "rawget").get(k));
  set("rawset", (t, k, v) => {
    checkTable(t, 1, "rawset").set(k, v);
    return t;
  });
  set("rawequal", (a, b) => a === b);
  set("rawlen", (v) => v instanceof LuaTable ? v.length() : typeof v === "string" ? v.length : argError(1, "rawlen", "table or string expected"));
  for (const name of ["setmetatable", "getmetatable"])
    G.rawSet(name, unsupported(name, "metatables are not available"));
  for (const name of ["load", "loadstring", "dofile", "loadfile", "require"])
    G.rawSet(name, unsupported(name, "widgets are a single program"));
  G.rawSet("collectgarbage", fn("collectgarbage", () => 0));
  G.rawSet("_G", G);
  G.rawSet("_VERSION", "Lua 5.1");
  const string = new LuaTable;
  const sset = (name, f) => string.rawSet(name, fn(name, f));
  sset("len", (s) => checkString(s, 1, "len").length);
  sset("sub", (s, i, j) => {
    const str = checkString(s, 1, "sub");
    const n = str.length;
    let a = optNumber(i, 2, "sub", 1);
    let b = optNumber(j, 3, "sub", -1);
    if (a < 0)
      a = Math.max(n + a + 1, 1);
    else if (a === 0)
      a = 1;
    if (b < 0)
      b = n + b + 1;
    else if (b > n)
      b = n;
    return a > b ? "" : str.slice(a - 1, b);
  });
  sset("upper", (s) => checkString(s, 1, "upper").toUpperCase());
  sset("lower", (s) => checkString(s, 1, "lower").toLowerCase());
  sset("rep", (s, n, sep) => {
    const str = checkString(s, 1, "rep");
    const count = Math.trunc(checkNumber(n, 2, "rep"));
    if (count <= 0)
      return "";
    if ((str.length + (typeof sep === "string" ? sep.length : 0)) * count > 1e6)
      throw new LuaLimitError("resulting string too large");
    return sep === undefined ? str.repeat(count) : Array(count).fill(str).join(checkString(sep, 3, "rep"));
  });
  sset("reverse", (s) => [...checkString(s, 1, "reverse")].reverse().join(""));
  sset("byte", (s, i, j) => {
    const str = checkString(s, 1, "byte");
    const a = optNumber(i, 2, "byte", 1);
    const b = optNumber(j, 3, "byte", a);
    const from = a < 0 ? str.length + a + 1 : a;
    const to = b < 0 ? str.length + b + 1 : b;
    const out = [];
    for (let k = Math.max(from, 1);k <= Math.min(to, str.length); k++)
      out.push(str.charCodeAt(k - 1));
    return out;
  });
  sset("char", (...codes) => codes.map((c, k) => String.fromCharCode(checkNumber(c, k + 1, "char"))).join(""));
  sset("format", (f, ...args) => format(checkString(f, 1, "format"), args));
  sset("find", (s, p, init, plain) => find(checkString(s, 1, "find"), checkString(p, 2, "find"), init === undefined ? undefined : checkNumber(init, 3, "find"), truthy(plain), true));
  sset("match", (s, p, init) => find(checkString(s, 1, "match"), checkString(p, 2, "match"), init === undefined ? undefined : checkNumber(init, 3, "match"), false, false));
  sset("gmatch", (s, p) => {
    const next = gmatch(checkString(s, 1, "gmatch"), checkString(p, 2, "gmatch"));
    return fn("gmatch_iterator", () => next());
  });
  sset("gsub", (s, p, r, n) => {
    const str = checkString(s, 1, "gsub");
    const pat = checkString(p, 2, "gsub");
    const max = n === undefined ? undefined : Math.trunc(checkNumber(n, 4, "gsub"));
    const replace = (whole, captures) => {
      let value;
      if (typeof r === "string" || typeof r === "number") {
        const template = tostring(r);
        return template.replace(/%([\s\S])/g, (_, d) => {
          if (d === "%")
            return "%";
          if (d === "0")
            return whole;
          if (/[1-9]/.test(d)) {
            const cap = captures[Number(d) - 1];
            if (cap === undefined && Number(d) !== 1)
              throw new LuaError(`invalid capture index %${d} in replacement string`);
            return tostring(cap ?? whole);
          }
          throw new LuaError("invalid use of '%' in replacement string");
        });
      }
      if (r instanceof LuaTable)
        value = r.get(captures[0]);
      else if (r instanceof LuaFunction)
        value = call(rt, r, captures, 0, "")[0];
      else
        argError(3, "gsub", `string/function/table expected, got ${type(r)}`);
      if (value === undefined || value === false)
        return;
      if (typeof value !== "string" && typeof value !== "number")
        throw new LuaError(`invalid replacement value (a ${type(value)})`);
      return tostring(value);
    };
    return gsub(str, pat, replace, max);
  });
  G.rawSet("string", string);
  rt.stringMeta = string;
  const table = new LuaTable;
  const tset = (name, f) => table.rawSet(name, fn(name, f));
  tset("insert", (t, ...rest) => {
    const tbl = checkTable(t, 1, "insert");
    const n = tbl.length();
    if (rest.length === 1) {
      tbl.set(n + 1, rest[0]);
      return [];
    }
    if (rest.length !== 2)
      throw new LuaError("wrong number of arguments to 'insert'");
    const [a, b] = rest;
    const pos = Math.trunc(checkNumber(a, 2, "insert"));
    if (pos < 1 || pos > n + 1)
      argError(2, "insert", "position out of bounds");
    for (let k = n;k >= pos; k--)
      tbl.set(k + 1, tbl.get(k));
    tbl.set(pos, b);
    return [];
  });
  tset("remove", (t, p) => {
    const tbl = checkTable(t, 1, "remove");
    const n = tbl.length();
    if (p === undefined) {
      if (n === 0)
        return [undefined];
      const v = tbl.get(n);
      tbl.set(n, undefined);
      return v;
    }
    const pos = Math.trunc(checkNumber(p, 2, "remove"));
    if (n === 0 && (pos === 0 || pos === n))
      return tbl.get(pos);
    if (pos < 1 || pos > n + 1)
      argError(2, "remove", "position out of bounds");
    const v = tbl.get(pos);
    for (let k = pos;k < n; k++)
      tbl.set(k, tbl.get(k + 1));
    if (pos <= n)
      tbl.set(n, undefined);
    return v;
  });
  tset("concat", (t, sep, i, j) => {
    const tbl = checkTable(t, 1, "concat");
    const s = sep === undefined ? "" : checkString(sep, 2, "concat");
    const a = optNumber(i, 3, "concat", 1);
    const b = optNumber(j, 4, "concat", tbl.length());
    const parts = [];
    for (let k = a;k <= b; k++) {
      const v = tbl.get(k);
      if (typeof v !== "string" && typeof v !== "number")
        throw new LuaError(`invalid value (at index ${k}) in table for 'concat'`);
      parts.push(tostring(v));
    }
    return parts.join(s);
  });
  tset("sort", (t, comp) => {
    const tbl = checkTable(t, 1, "sort");
    const n = tbl.length();
    const values = tbl.arr.slice(0, n);
    const less = comp === undefined ? (a, b) => {
      if (typeof a === "number" && typeof b === "number" || typeof a === "string" && typeof b === "string")
        return a < b;
      throw new LuaError(`attempt to compare ${type(a)} with ${type(b)}`);
    } : (a, b) => truthy(call(rt, checkFunction(comp, 2, "sort"), [a, b], 0, "")[0]);
    values.sort((a, b) => less(a, b) ? -1 : less(b, a) ? 1 : 0);
    values.forEach((v, k) => tbl.set(k + 1, v));
    return [];
  });
  tset("unpack", (t, i, j) => unpack(t, i, j, "unpack"));
  tset("pack", (...args) => {
    const t = LuaTable.from(args);
    t.rawSet("n", args.length);
    return t;
  });
  G.rawSet("table", table);
  const math = new LuaTable;
  const random = rng(options.seed ?? 24301);
  let rand = random;
  const mset = (name, f) => math.rawSet(name, fn(name, f));
  const unary = (name, f) => mset(name, (x) => f(checkNumber(x, 1, name)));
  unary("abs", Math.abs);
  unary("ceil", Math.ceil);
  unary("floor", Math.floor);
  unary("sqrt", Math.sqrt);
  unary("sin", Math.sin);
  unary("cos", Math.cos);
  unary("tan", Math.tan);
  unary("asin", Math.asin);
  unary("acos", Math.acos);
  unary("exp", Math.exp);
  unary("deg", (x) => x * 180 / Math.PI);
  unary("rad", (x) => x * Math.PI / 180);
  mset("atan", (y, x) => Math.atan2(checkNumber(y, 1, "atan"), optNumber(x, 2, "atan", 1)));
  mset("log", (x, base) => {
    const v = checkNumber(x, 1, "log");
    if (base === undefined)
      return Math.log(v);
    const b = checkNumber(base, 2, "log");
    return b === 2 ? Math.log2(v) : b === 10 ? Math.log10(v) : Math.log(v) / Math.log(b);
  });
  mset("max", (...xs) => {
    if (!xs.length)
      argError(1, "max", "number expected, got no value");
    return xs.map((x, k) => checkNumber(x, k + 1, "max")).reduce((a, b) => b > a ? b : a);
  });
  mset("min", (...xs) => {
    if (!xs.length)
      argError(1, "min", "number expected, got no value");
    return xs.map((x, k) => checkNumber(x, k + 1, "min")).reduce((a, b) => b < a ? b : a);
  });
  mset("fmod", (a, b) => {
    const x = checkNumber(a, 1, "fmod");
    const y = checkNumber(b, 2, "fmod");
    if (y === 0 && Number.isInteger(x))
      argError(2, "fmod", "zero");
    return x % y;
  });
  mset("modf", (x) => {
    const v = checkNumber(x, 1, "modf");
    const int = v >= 0 ? Math.floor(v) : Math.ceil(v);
    return [int, Number.isFinite(v) ? v - int : 0];
  });
  mset("tointeger", (x) => typeof x === "number" && Number.isInteger(x) ? x : undefined);
  mset("type", (x) => typeof x !== "number" ? undefined : Number.isInteger(x) ? "integer" : "float");
  mset("ult", (a, b) => BigInt.asUintN(64, BigInt(checkNumber(a, 1, "ult"))) < BigInt.asUintN(64, BigInt(checkNumber(b, 2, "ult"))));
  mset("random", (m, n) => {
    const r = rand();
    if (m === undefined)
      return r;
    const lo = n === undefined ? 1 : Math.trunc(checkNumber(m, 1, "random"));
    const hi = n === undefined ? Math.trunc(checkNumber(m, 1, "random")) : Math.trunc(checkNumber(n, 2, "random"));
    if (lo > hi)
      argError(n === undefined ? 1 : 2, "random", "interval is empty");
    return lo + Math.floor(r * (hi - lo + 1));
  });
  mset("randomseed", (s) => {
    rand = rng(s === undefined ? 24301 : Math.trunc(checkNumber(s, 1, "randomseed")));
    return [];
  });
  math.rawSet("pi", Math.PI);
  math.rawSet("huge", Infinity);
  math.rawSet("maxinteger", Number.MAX_SAFE_INTEGER);
  math.rawSet("mininteger", Number.MIN_SAFE_INTEGER);
  G.rawSet("math", math);
  for (const lib of ["io", "os", "debug", "coroutine", "utf8", "package"]) {
    const stub = new LuaTable;
    stub.unavailable = lib;
    G.rawSet(lib, stub);
  }
}
function unpack(t, i, j, name) {
  const tbl = checkTable(t, 1, name);
  const a = optNumber(i, 2, name, 1);
  const b = optNumber(j, 3, name, tbl.length());
  if (b - a >= 1e4)
    throw new LuaLimitError("too many results to unpack");
  const out = [];
  for (let k = a;k <= b; k++)
    out.push(tbl.get(k));
  return out;
}

// src/lua/lexer.ts
class LuaSyntaxError extends Error {
  line;
  incomplete;
  constructor(message, line, incomplete = false) {
    super(`line ${line}: ${message}`);
    this.line = line;
    this.incomplete = incomplete;
  }
}
var KEYWORDS = new Set([
  "and",
  "break",
  "do",
  "else",
  "elseif",
  "end",
  "false",
  "for",
  "function",
  "goto",
  "if",
  "in",
  "local",
  "nil",
  "not",
  "or",
  "repeat",
  "return",
  "then",
  "true",
  "until",
  "while"
]);
var OPS = ["...", "..", "==", "~=", "<=", ">=", "//", "::", "<<", ">>", "+", "-", "*", "/", "%", "^", "#", "&", "~", "|", "<", ">", "=", "(", ")", "{", "}", "[", "]", ";", ":", ",", "."];
function tokenize(source) {
  const tokens = [];
  let i = 0;
  let line = 1;
  const n = source.length;
  const fail = (message, incomplete = false) => {
    throw new LuaSyntaxError(message, line, incomplete);
  };
  const longOpen = (at) => {
    if (source[at] !== "[")
      return -1;
    let j = at + 1;
    while (source[j] === "=")
      j++;
    return source[j] === "[" ? j - at - 1 : -1;
  };
  const readLong = (at, level) => {
    const close = "]" + "=".repeat(level) + "]";
    const bodyStart = at + level + 2;
    const end = source.indexOf(close, bodyStart);
    if (end === -1)
      fail("unfinished long string or comment", true);
    let body = source.slice(bodyStart, end);
    if (body.startsWith(`\r
`))
      body = body.slice(2);
    else if (body.startsWith(`
`) || body.startsWith("\r"))
      body = body.slice(1);
    line += (source.slice(at, end + close.length).match(/\n/g) ?? []).length;
    return { body, next: end + close.length };
  };
  while (i < n) {
    const c = source[i];
    if (c === `
`) {
      line++;
      i++;
      continue;
    }
    if (c === " " || c === "\t" || c === "\r" || c === "\f" || c === "\v") {
      i++;
      continue;
    }
    if (c === "-" && source[i + 1] === "-") {
      const level = longOpen(i + 2);
      if (level >= 0) {
        i = readLong(i + 2, level).next;
        continue;
      }
      while (i < n && source[i] !== `
`)
        i++;
      continue;
    }
    const start = i;
    const startLine = line;
    if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_]/.test(source[j]))
        j++;
      const word = source.slice(i, j);
      tokens.push({ kind: KEYWORDS.has(word) ? "keyword" : "name", value: word, line: startLine, start, end: j });
      i = j;
      continue;
    }
    if (/[0-9]/.test(c) || c === "." && /[0-9]/.test(source[i + 1] ?? "")) {
      const m = /^0[xX]([0-9a-fA-F]*)(\.[0-9a-fA-F]*)?([pP][+-]?[0-9]+)?|^[0-9]*\.?[0-9]*([eE][+-]?[0-9]+)?/.exec(source.slice(i));
      const text = m[0];
      let j = i + text.length;
      if (/[A-Za-z_]/.test(source[j] ?? "")) {
        while (j < n && /[A-Za-z0-9_.]/.test(source[j]))
          j++;
        fail(`malformed number near '${source.slice(i, j)}'`);
      }
      tokens.push({ kind: "number", value: text, literal: parseNumber(text) ?? fail(`malformed number near '${text}'`), line: startLine, start, end: j });
      i = j;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      let out = "";
      for (;; ) {
        if (j >= n)
          fail("unfinished string", true);
        const ch = source[j];
        if (ch === c) {
          j++;
          break;
        }
        if (ch === `
`)
          fail("unfinished string");
        if (ch !== "\\") {
          out += ch;
          j++;
          continue;
        }
        const e = source[j + 1];
        if (e === undefined)
          fail("unfinished string", true);
        const simple = { n: `
`, t: "\t", r: "\r", a: "\x07", b: "\b", f: "\f", v: "\v", "\\": "\\", '"': '"', "'": "'", "\n": `
` };
        if (e in simple) {
          if (e === `
`)
            line++;
          out += simple[e];
          j += 2;
        } else if (e === "x") {
          const hex = source.slice(j + 2, j + 4);
          if (!/^[0-9a-fA-F]{2}$/.test(hex))
            fail("hexadecimal digit expected");
          out += String.fromCharCode(parseInt(hex, 16));
          j += 4;
        } else if (e === "z") {
          j += 2;
          while (j < n && /\s/.test(source[j])) {
            if (source[j] === `
`)
              line++;
            j++;
          }
        } else if (e === "u") {
          const m = /^\{([0-9a-fA-F]+)\}/.exec(source.slice(j + 2));
          if (!m)
            fail("missing '{' or '}' in \\u{xxxx}");
          out += String.fromCodePoint(parseInt(m[1], 16));
          j += 2 + m[0].length;
        } else if (/[0-9]/.test(e)) {
          const digits = /^[0-9]{1,3}/.exec(source.slice(j + 1))[0];
          const code = Number(digits);
          if (code > 255)
            fail("decimal escape too large");
          out += String.fromCharCode(code);
          j += 1 + digits.length;
        } else
          fail(`invalid escape sequence '\\${e}'`);
      }
      tokens.push({ kind: "string", value: source.slice(i, j), literal: out, line: startLine, start, end: j });
      i = j;
      continue;
    }
    const level = longOpen(i);
    if (level >= 0) {
      const long = readLong(i, level);
      tokens.push({ kind: "string", value: source.slice(i, long.next), literal: long.body, line: startLine, start, end: long.next });
      i = long.next;
      continue;
    }
    const op = OPS.find((o) => source.startsWith(o, i));
    if (!op)
      fail(`unexpected symbol near '${c}'`);
    tokens.push({ kind: "op", value: op, line: startLine, start, end: i + op.length });
    i += op.length;
  }
  tokens.push({ kind: "eof", value: "<eof>", line, start: n, end: n });
  return tokens;
}
function parseNumber(text) {
  const t = text.trim();
  const hex = /^([+-])?0[xX]([0-9a-fA-F]*)(?:\.([0-9a-fA-F]*))?(?:[pP]([+-]?[0-9]+))?$/.exec(t);
  if (hex) {
    const [, sign, int = "", frac = "", exp] = hex;
    if (!int && !frac)
      return;
    let value = int ? parseInt(int, 16) : 0;
    for (let k = 0;k < frac.length; k++)
      value += parseInt(frac[k], 16) / 16 ** (k + 1);
    if (exp)
      value *= 2 ** Number(exp);
    return sign === "-" ? -value : value;
  }
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t))
    return;
  return Number(t);
}

// src/lua/parser.ts
function parse(source) {
  const p = new Parser(tokenize(source));
  const body = p.block();
  if (p.cur.kind !== "eof")
    p.fail(`'<eof>' expected near ${p.near}`);
  return { params: [], vararg: true, body, name: "main chunk", line: 1 };
}
var BINARY = {
  or: [1, 1],
  and: [2, 2],
  "<": [3, 3],
  ">": [3, 3],
  "<=": [3, 3],
  ">=": [3, 3],
  "~=": [3, 3],
  "==": [3, 3],
  "|": [4, 4],
  "~": [5, 5],
  "&": [6, 6],
  "<<": [7, 7],
  ">>": [7, 7],
  "..": [9, 8],
  "+": [10, 10],
  "-": [10, 10],
  "*": [11, 11],
  "/": [11, 11],
  "//": [11, 11],
  "%": [11, 11],
  "^": [14, 13]
};
var UNARY_PRIORITY = 12;
var BITWISE = new Set(["|", "~", "&", "<<", ">>"]);

class Parser {
  tokens;
  i = 0;
  constructor(tokens) {
    this.tokens = tokens;
  }
  get cur() {
    return this.tokens[this.i];
  }
  get near() {
    return this.cur.kind === "eof" ? "<eof>" : `'${this.cur.value}'`;
  }
  fail(message) {
    throw new LuaSyntaxError(message, this.cur.line, this.cur.kind === "eof");
  }
  check(value) {
    const t = this.cur;
    return (t.kind === "op" || t.kind === "keyword") && t.value === value;
  }
  accept(value) {
    if (!this.check(value))
      return false;
    this.i++;
    return true;
  }
  expect(value, opener) {
    if (this.accept(value))
      return;
    const near = this.near;
    if (opener && opener.line !== this.cur.line)
      this.fail(`'${value}' expected (to close '${opener.what}' at line ${opener.line}) near ${near}`);
    this.fail(`'${value}' expected near ${near}`);
  }
  name() {
    const t = this.cur;
    if (t.kind !== "name")
      this.fail(`<name> expected near ${this.near}`);
    this.i++;
    return t.value;
  }
  blockEnds() {
    const t = this.cur;
    return t.kind === "eof" || t.kind === "keyword" && ["end", "else", "elseif", "until"].includes(t.value);
  }
  block() {
    const out = [];
    while (!this.blockEnds()) {
      if (this.check("return")) {
        out.push(this.returnStat());
        break;
      }
      const stat = this.statement();
      if (stat)
        out.push(stat);
    }
    return out;
  }
  returnStat() {
    const line = this.cur.line;
    this.i++;
    const values = this.blockEnds() || this.check(";") ? [] : this.exprList();
    this.accept(";");
    if (!this.blockEnds())
      this.fail(`'<eof>' expected near ${this.near}`);
    return { k: "return", values, line };
  }
  statement() {
    const t = this.cur;
    const line = t.line;
    if (this.accept(";"))
      return;
    if (t.kind === "keyword") {
      switch (t.value) {
        case "if":
          return this.ifStat();
        case "while": {
          this.i++;
          const cond = this.expr();
          this.expect("do");
          const body = this.block();
          this.expect("end", { what: "while", line });
          return { k: "while", cond, body, line };
        }
        case "do": {
          this.i++;
          const body = this.block();
          this.expect("end", { what: "do", line });
          return { k: "do", body, line };
        }
        case "for":
          return this.forStat();
        case "repeat": {
          this.i++;
          const body = this.block();
          this.expect("until", { what: "repeat", line });
          return { k: "repeat", body, cond: this.expr(), line };
        }
        case "function": {
          this.i++;
          let target = { k: "name", name: this.name(), line };
          let fullName = target.name;
          while (this.check(".")) {
            this.i++;
            const key = this.name();
            fullName += "." + key;
            target = { k: "index", obj: target, key: { k: "string", value: key, line }, line };
          }
          let method = false;
          if (this.accept(":")) {
            const key = this.name();
            fullName += ":" + key;
            target = { k: "index", obj: target, key: { k: "string", value: key, line }, line };
            method = true;
          }
          return { k: "function", target, fn: this.functionBody(fullName, line, method), line };
        }
        case "local": {
          this.i++;
          if (this.accept("function")) {
            const name = this.name();
            return { k: "localfunction", name, fn: this.functionBody(name, line, false), line };
          }
          const names = [this.attribName()];
          while (this.accept(","))
            names.push(this.attribName());
          const values = this.accept("=") ? this.exprList() : [];
          return { k: "local", names, values, line };
        }
        case "return":
          return this.returnStat();
        case "break":
          this.i++;
          return { k: "break", line };
        case "goto":
          this.fail("goto is not supported");
      }
    }
    if (this.check("::"))
      this.fail("labels (::name::) are not supported");
    const first = this.suffixedExpr();
    if (this.check("=") || this.check(",")) {
      const targets = [first];
      while (this.accept(","))
        targets.push(this.suffixedExpr());
      targets.forEach((target) => {
        if (target.k !== "name" && target.k !== "index")
          this.fail("syntax error near '='");
      });
      this.expect("=");
      return { k: "assign", targets, values: this.exprList(), line };
    }
    if (first.k !== "call" && first.k !== "method")
      this.fail(`syntax error near ${this.near}`);
    return { k: "call", call: first, line };
  }
  attribName() {
    const name = this.name();
    if (this.check("<"))
      this.fail("variable attributes (<const>, <close>) are not supported");
    return name;
  }
  ifStat() {
    const line = this.cur.line;
    this.i++;
    const clauses = [];
    const cond = this.expr();
    this.expect("then");
    clauses.push({ cond, body: this.block() });
    let orelse;
    for (;; ) {
      if (this.accept("elseif")) {
        const c = this.expr();
        this.expect("then");
        clauses.push({ cond: c, body: this.block() });
        continue;
      }
      if (this.accept("else"))
        orelse = this.block();
      this.expect("end", { what: "if", line });
      return { k: "if", clauses, orelse, line };
    }
  }
  forStat() {
    const line = this.cur.line;
    this.i++;
    const first = this.name();
    if (this.accept("=")) {
      const start = this.expr();
      this.expect(",");
      const stop = this.expr();
      const step = this.accept(",") ? this.expr() : undefined;
      this.expect("do");
      const body = this.block();
      this.expect("end", { what: "for", line });
      return { k: "fornum", name: first, start, stop, step, body, line };
    }
    const names = [first];
    while (this.accept(","))
      names.push(this.name());
    this.expect("in");
    const exprs = this.exprList();
    this.expect("do");
    const body = this.block();
    this.expect("end", { what: "for", line });
    return { k: "forin", names, exprs, body, line };
  }
  functionBody(name, line, method) {
    this.expect("(");
    const params = method ? ["self"] : [];
    let vararg = false;
    if (!this.check(")")) {
      for (;; ) {
        if (this.accept("...")) {
          vararg = true;
          break;
        }
        params.push(this.name());
        if (!this.accept(","))
          break;
      }
    }
    this.expect(")");
    const body = this.block();
    this.expect("end", { what: "function", line });
    return { params, vararg, body, name, line };
  }
  exprList() {
    const out = [this.expr()];
    while (this.accept(","))
      out.push(this.expr());
    return out;
  }
  expr(limit = 0) {
    const t = this.cur;
    let left;
    if (t.kind === "keyword" && t.value === "not" || t.kind === "op" && (t.value === "-" || t.value === "#" || t.value === "~")) {
      if (t.value === "~")
        this.fail("bitwise operators are not supported");
      this.i++;
      left = { k: "unop", op: t.value, expr: this.expr(UNARY_PRIORITY), line: t.line };
    } else
      left = this.simpleExpr();
    for (;; ) {
      const op = this.cur;
      const prec = op.kind === "op" || op.kind === "keyword" ? BINARY[op.value] : undefined;
      if (!prec || prec[0] <= limit)
        return left;
      if (BITWISE.has(op.value))
        this.fail("bitwise operators are not supported");
      this.i++;
      const right = this.expr(prec[1]);
      left = op.value === "and" || op.value === "or" ? { k: op.value, left, right, line: op.line } : { k: "binop", op: op.value, left, right, line: op.line };
    }
  }
  simpleExpr() {
    const t = this.cur;
    const line = t.line;
    if (t.kind === "number") {
      this.i++;
      return { k: "number", value: t.literal, line };
    }
    if (t.kind === "string") {
      this.i++;
      return { k: "string", value: t.literal, line };
    }
    if (t.kind === "keyword") {
      if (t.value === "nil") {
        this.i++;
        return { k: "nil", line };
      }
      if (t.value === "true") {
        this.i++;
        return { k: "true", line };
      }
      if (t.value === "false") {
        this.i++;
        return { k: "false", line };
      }
      if (t.value === "function") {
        this.i++;
        return { k: "function", fn: this.functionBody("anonymous", line, false), line };
      }
    }
    if (t.kind === "op" && t.value === "...") {
      this.i++;
      return { k: "vararg", line };
    }
    if (t.kind === "op" && t.value === "{")
      return this.table();
    return this.suffixedExpr();
  }
  primaryExpr() {
    const t = this.cur;
    if (t.kind === "name") {
      this.i++;
      return { k: "name", name: t.value, line: t.line };
    }
    if (this.accept("(")) {
      const expr = this.expr();
      this.expect(")", { what: "(", line: t.line });
      return { k: "paren", expr, line: t.line };
    }
    this.fail(`unexpected symbol near ${this.near}`);
  }
  suffixedExpr() {
    let e = this.primaryExpr();
    for (;; ) {
      const t = this.cur;
      const line = t.line;
      if (this.accept("."))
        e = { k: "index", obj: e, key: { k: "string", value: this.name(), line }, line };
      else if (this.check("[")) {
        this.i++;
        const key = this.expr();
        this.expect("]");
        e = { k: "index", obj: e, key, line };
      } else if (this.accept(":")) {
        const name = this.name();
        e = { k: "method", obj: e, name, args: this.callArgs(), line };
      } else if (this.check("(") || this.check("{") || t.kind === "string")
        e = { k: "call", fn: e, args: this.callArgs(), line };
      else
        return e;
    }
  }
  callArgs() {
    const t = this.cur;
    if (t.kind === "string") {
      this.i++;
      return [{ k: "string", value: t.literal, line: t.line }];
    }
    if (this.check("{"))
      return [this.table()];
    this.expect("(");
    if (this.accept(")"))
      return [];
    const args = this.exprList();
    this.expect(")", { what: "(", line: t.line });
    return args;
  }
  table() {
    const line = this.cur.line;
    this.expect("{");
    const items = [];
    while (!this.check("}")) {
      if (this.check("[")) {
        this.i++;
        const key = this.expr();
        this.expect("]");
        this.expect("=");
        items.push({ k: "keyed", key, value: this.expr() });
      } else if (this.cur.kind === "name" && this.tokens[this.i + 1]?.value === "=" && this.tokens[this.i + 1]?.kind === "op") {
        const name = this.name();
        this.i++;
        items.push({ k: "named", name, value: this.expr() });
      } else
        items.push({ k: "pos", value: this.expr() });
      if (!this.accept(",") && !this.accept(";"))
        break;
    }
    this.expect("}", { what: "{", line });
    return { k: "table", items, line };
  }
}

// src/lua/index.ts
class LuaState {
  rt;
  writes = 0;
  constructor(options = {}) {
    this.rt = {
      globals: new LuaTable,
      stringMeta: new LuaTable,
      steps: 0,
      maxSteps: options.maxSteps ?? 2000000,
      depth: 0,
      maxDepth: options.maxDepth ?? 200
    };
    installStdlib(this.rt, { print: options.print, seed: options.seed });
  }
  get globals() {
    return this.rt.globals;
  }
  define(name, f) {
    this.rt.globals.rawSet(name, new LuaFunction(`builtin ${name}`, (args) => {
      const r = f(args);
      return Array.isArray(r) ? r : [r];
    }));
  }
  load(source) {
    return compile(parse(source), this.rt);
  }
  run(source) {
    return this.call(this.load(source), []);
  }
  call(fn, args) {
    this.rt.steps = 0;
    this.rt.depth = 0;
    return call(this.rt, fn, args, 0, "");
  }
  transaction(body) {
    if (journal.active)
      return body();
    journal.active = true;
    journal.entries = [];
    journal.epoch++;
    try {
      const result = body();
      this.writes = journal.entries.length;
      journal.entries = [];
      return result;
    } catch (error) {
      for (let i = journal.entries.length - 1;i >= 0; i--)
        journal.entries[i]();
      journal.entries = [];
      throw error;
    } finally {
      journal.active = false;
    }
  }
}
// src/fence.ts
var MAX_WIDTH = 200;
var MAX_HEIGHT = 60;
function parseFence(info) {
  const words = /^ui(?:\s+lua)?(?=\s|$)/.exec(info.trim());
  if (!words)
    return;
  const settings = Object.fromEntries([...info.trim().slice(words[0].length).matchAll(/([a-zA-Z]+)=("([^"]*)"|'([^']*)'|(\S+))/g)].map((match) => [
    match[1],
    match[3] ?? match[4] ?? match[5]
  ]));
  const size = /size=\s*(auto|\d+)\s*[xX\u00D7]\s*(auto|\d+)/.exec(info);
  return {
    width: !size || size[1] === "auto" ? "auto" : clamp(Number(size[1]), 10, MAX_WIDTH),
    height: !size || size[2] === "auto" ? "auto" : clamp(Number(size[2]), 1, MAX_HEIGHT),
    title: settings.title || undefined
  };
}
function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
// src/stream.ts
var MAX_BACKOFF = 12;
function closePrefix(source, final = false) {
  if (parses(source))
    return source;
  if (final)
    return;
  const lines = source.split(`
`);
  const complete = source.endsWith(`
`) ? lines.length : lines.length - 1;
  for (let count = complete;count >= Math.max(0, complete - MAX_BACKOFF); count--) {
    const prefix = lines.slice(0, count).join(`
`);
    const closers = closersFor(prefix);
    if (closers === undefined)
      continue;
    const candidate = closers ? `${prefix}
${closers}` : prefix;
    if (parses(candidate))
      return candidate;
  }
  return;
}
function parses(source) {
  try {
    parse(source);
    return true;
  } catch {
    return false;
  }
}
var OPENERS = {
  function: "end",
  if: "end",
  do: "end",
  repeat: "until true",
  "(": ")",
  "{": "}",
  "[": "]"
};
function closersFor(source) {
  const tokens = (() => {
    try {
      return tokenize(source);
    } catch {
      return;
    }
  })();
  if (!tokens)
    return;
  const stack = [];
  for (const token of tokens) {
    if (token.kind !== "keyword" && token.kind !== "op")
      continue;
    const closer = OPENERS[token.value];
    if (closer) {
      stack.push(closer);
      continue;
    }
    if (token.value === "end" || token.value === "until" || token.value === ")" || token.value === "}" || token.value === "]") {
      if (stack.length === 0)
        return;
      stack.pop();
    }
  }
  return stack.reverse().join(`
`);
}
// src/widget.ts
var MAX_VIEW_NODES = 2000;
var MAX_TEXT = 1e4;
var MAX_LOG = 50;
var MAX_DELAY = 60000;
var MAX_PASSES = 3;

class Widget {
  lua;
  loadError;
  log = [];
  queue = [];
  now;
  build;
  hovered = new Set;
  hoverQueried = false;
  constructor(source, options = {}) {
    this.now = options.now ?? Date.now;
    this.lua = new LuaState({ seed: options.seed, maxSteps: options.maxSteps, print: (text) => this.warn(text) });
    this.install();
    this.loadError = this.attempt(() => this.lua.call(this.lua.load(source), []));
  }
  get hasFrame() {
    return this.lua.globals.get("frame") instanceof LuaFunction;
  }
  render() {
    let result = this.frame(undefined);
    for (let pass = 1;pass < MAX_PASSES && !result.error && this.lua.writes > 0; pass++)
      result = this.frame(undefined);
    return result;
  }
  dispatch(event) {
    const handled = this.frame(event);
    if (handled.error)
      return handled;
    return this.render();
  }
  hover(ids) {
    if (ids.length === this.hovered.size && ids.every((id) => this.hovered.has(id)))
      return;
    this.hovered = new Set(ids);
    if (!this.hoverQueried)
      return;
    return this.render();
  }
  get nextDue() {
    if (this.queue.length === 0)
      return;
    return Math.min(...this.queue.map((q) => q.due));
  }
  runQueued() {
    const now = this.now();
    const due = this.queue.filter((q) => q.due <= now);
    if (due.length === 0)
      return { ran: false };
    this.queue = this.queue.filter((q) => q.due > now);
    const failed = due.map((q) => this.attempt(() => this.lua.call(q.fn, [now - q.queuedAt]))).find((error) => error !== undefined);
    return { ran: true, error: failed };
  }
  frame(event) {
    const frame = this.lua.globals.get("frame");
    if (!(frame instanceof LuaFunction))
      return { view: [], error: "the program must define a global function frame()" };
    const build = new Builder(event);
    this.build = build;
    const error = this.attempt(() => this.lua.call(frame, []));
    this.build = undefined;
    this.hoverQueried = build.hoverQueried;
    const unclosed = build.close();
    if (unclosed && !error)
      this.warn(`${unclosed} was not closed`);
    return { view: build.root.c, error };
  }
  attempt(body) {
    const queue = this.queue;
    try {
      this.lua.transaction(body);
      return;
    } catch (error) {
      this.queue = queue;
      if (error instanceof LuaError)
        return typeof error.value === "string" ? error.value : error.message;
      if (error instanceof LuaSyntaxError)
        return error.message;
      throw error;
    }
  }
  warn(text) {
    this.log = [...this.log.slice(-(MAX_LOG - 1)), text];
  }
  builder(name) {
    if (!this.build)
      throw new LuaError(`${name}() can only be called while frame() runs`);
    return this.build;
  }
  install() {
    const define = (name, f) => this.lua.define(name, f);
    define("text", (args) => {
      const options = args.length > 1 && args[args.length - 1] instanceof LuaTable ? args.pop() : undefined;
      const content = args.map(tostring).join("");
      const build = this.builder("text");
      build.add({
        t: "text",
        p: style(options),
        c: [content.length > MAX_TEXT ? content.slice(0, MAX_TEXT) + "\u2026" : content],
        k: build.id("text", "", options?.get("key"))
      });
      return [];
    });
    define("button", ([label, options]) => {
      const build = this.builder("button");
      const text = tostring(label);
      const opts = options instanceof LuaTable ? options : undefined;
      const disabled = opts?.get("disabled") === true;
      const id = build.id("button", text, opts?.get("key"));
      build.add({ t: "button", p: { onClick: { $h: id }, ...disabled ? { disabled } : {} }, c: [text], k: id });
      return !disabled && build.consume(id) !== undefined;
    });
    define("slider", ([value, min, max, step, options]) => {
      const build = this.builder("slider");
      const lo = num(min, 0, "slider", 2);
      const hi = Math.max(lo, num(max, 100, "slider", 3));
      const inc = num(step, 1, "slider", 4);
      if (inc <= 0)
        throw new LuaError("bad argument #4 to 'slider' (step must be positive)");
      const current = clamp2(num(value, lo, "slider", 1), lo, hi);
      const opts = options instanceof LuaTable ? options : undefined;
      const id = build.id("slider", "", opts?.get("key"));
      const width = opts?.get("width");
      build.add({
        t: "slider",
        p: { value: current, min: lo, max: hi, step: inc, onChange: { $h: id }, ...typeof width === "number" ? { width } : {} },
        c: [],
        k: id
      });
      const event = build.consume(id);
      if (!event)
        return current;
      const raw = Number(event.args?.[0]);
      if (!Number.isFinite(raw))
        return current;
      return clamp2(lo + Math.round((raw - lo) / inc) * inc, lo, hi);
    });
    define("progress", ([value, max, options]) => {
      const opts = options instanceof LuaTable ? options : undefined;
      const width = opts?.get("width");
      const build = this.builder("progress");
      build.add({
        t: "progress",
        p: { value: num(value, 0, "progress", 1), max: num(max, 100, "progress", 2), ...style(opts), ...typeof width === "number" ? { width } : {} },
        c: [],
        k: build.id("progress", "", opts?.get("key"))
      });
      return [];
    });
    define("divider", () => {
      const build = this.builder("divider");
      build.add({ t: "divider", p: {}, c: [], k: build.id("divider", "", undefined) });
      return [];
    });
    for (const kind of ["row", "col"]) {
      define(`begin_${kind}`, ([options]) => {
        const opts = options instanceof LuaTable ? options : undefined;
        const p = {};
        const gap = opts?.get("gap");
        if (typeof gap === "number")
          p.gap = gap;
        if (opts?.get("border") === true)
          p.border = true;
        const build = this.builder(`begin_${kind}`);
        build.open({ t: kind, p, c: [], k: build.id(kind, "", opts?.get("key")) });
        return [];
      });
      define(`end_${kind}`, () => {
        this.builder(`end_${kind}`).end(kind);
        return [];
      });
    }
    define("item_hovered", () => {
      const build = this.builder("item_hovered");
      build.hoverQueried = true;
      return build.lastId !== undefined && this.hovered.has(build.lastId);
    });
    define("next_frame", ([fn, ms]) => {
      if (!(fn instanceof LuaFunction))
        throw new LuaError(`bad argument #1 to 'next_frame' (function expected, got ${fn === undefined ? "no value" : type(fn)})`);
      const delay = clamp2(num(ms, 0, "next_frame", 2), 0, MAX_DELAY);
      if (this.queue.some((q) => q.fn === fn))
        return [];
      const now = this.now();
      this.queue = [...this.queue, { fn, queuedAt: now, due: now + delay }];
      return [];
    });
  }
}

class Builder {
  event;
  root = { t: "root", p: {}, c: [] };
  stack = [this.root];
  nodes = 0;
  seen = new Map;
  consumed = false;
  lastId;
  hoverQueried = false;
  constructor(event) {
    this.event = event;
  }
  add(node) {
    if (++this.nodes > MAX_VIEW_NODES)
      throw new LuaLimitError(`the view has more than ${MAX_VIEW_NODES} nodes`);
    this.stack[this.stack.length - 1].c.push(node);
    this.lastId = node.k;
  }
  open(node) {
    this.add(node);
    this.stack.push(node);
  }
  end(kind) {
    const top = this.stack[this.stack.length - 1];
    if (top.t !== kind)
      throw new LuaError(this.stack.length === 1 ? `end_${kind}() without begin_${kind}()` : `end_${kind}() closes a begin_${top.t}()`);
    this.stack.pop();
    this.lastId = top.k;
  }
  close() {
    const open = this.stack.length > 1 ? `begin_${this.stack[1].t}()` : undefined;
    this.stack = [this.root];
    return open;
  }
  id(kind, label, key) {
    const base = label ? `${kind}:${label}` : kind;
    if (key !== undefined)
      return `${base}@${tostring(key)}`;
    const count = this.seen.get(base) ?? 0;
    this.seen.set(base, count + 1);
    return count === 0 ? base : `${base}#${count}`;
  }
  consume(id) {
    if (this.consumed || this.event?.handler !== id)
      return;
    this.consumed = true;
    return this.event;
  }
}
function style(options) {
  const p = {};
  if (!options)
    return p;
  if (options.get("bold") === true)
    p.bold = true;
  if (options.get("dim") === true)
    p.dim = true;
  const color = options.get("color");
  if (typeof color === "string")
    p.color = color;
  return p;
}
function num(v, fallback, name, n) {
  if (v === undefined)
    return fallback;
  if (typeof v === "number" && !Number.isNaN(v))
    return v;
  throw new LuaError(`bad argument #${n} to '${name}' (number expected, got ${type(v)})`);
}
function clamp2(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}
// src/tui/controller.ts
class UiController {
  source = "";
  final = false;
  view = [];
  error;
  widget;
  viewJson = "[]";
  listeners = new Set;
  timer;
  lastFrame = 0;
  update(source, final) {
    if (source === this.source && final === this.final)
      return;
    this.source = source;
    this.final = final;
    if (final)
      return this.load(source);
    const closed = closePrefix(source);
    if (closed === undefined)
      return;
    this.load(closed);
  }
  get interactive() {
    return this.final;
  }
  get diagnostic() {
    return this.final ? this.error : undefined;
  }
  dispatch(event) {
    if (!this.final || !this.widget)
      return;
    this.show(this.widget.dispatch(event), true);
    this.schedule();
  }
  hover(ids) {
    if (!this.final || !this.widget)
      return;
    const render = this.widget.hover(ids);
    if (render)
      this.show(render, false);
    this.schedule();
  }
  attach(listener) {
    this.listeners.add(listener);
    this.schedule();
    return () => {
      this.listeners.delete(listener);
      this.schedule();
    };
  }
  load(source) {
    this.widget = new Widget(source);
    const render = this.widget.render();
    this.show({ view: render.view, error: this.widget.loadError ?? render.error }, false);
    this.schedule();
  }
  show(render, keepOnError) {
    const error = render.error;
    const view = error && keepOnError ? this.view : render.view;
    const json = JSON.stringify(view);
    if (json === this.viewJson && error === this.error)
      return;
    this.view = view;
    this.viewJson = json;
    this.error = error;
    this.listeners.forEach((listener) => listener());
  }
  schedule() {
    clearTimeout(this.timer);
    this.timer = undefined;
    const due = this.widget?.nextDue;
    if (!this.final || this.listeners.size === 0 || due === undefined)
      return;
    const now = Date.now();
    this.timer = setTimeout(() => this.frame(), Math.max(0, due - now, this.lastFrame + FRAME_MS - now));
  }
  frame() {
    this.timer = undefined;
    const widget = this.widget;
    if (!widget)
      return;
    this.lastFrame = Date.now();
    const queued = widget.runQueued();
    if (queued.error)
      this.show({ view: this.view, error: queued.error }, true);
    else if (queued.ran)
      this.show(widget.render(), false);
    this.schedule();
  }
}
var FRAME_MS = 50;
var MAX_CONTROLLERS = 200;
var controllers = new Map;
function controllerFor(key) {
  const existing = controllers.get(key);
  if (existing) {
    controllers.delete(key);
    controllers.set(key, existing);
    return existing;
  }
  const created = new UiController;
  controllers.set(key, created);
  if (controllers.size > MAX_CONTROLLERS)
    controllers.delete(controllers.keys().next().value);
  return created;
}

// src/tui/renderable.ts
import {
  BoxRenderable,
  TextAttributes,
  TextRenderable
} from "@opentui/core";
class UiBlockRenderable extends BoxRenderable {
  controller;
  palette;
  detach;
  fibers = [];
  ids = new WeakMap;
  hoverSeq = 0;
  constructor(ctx, controller, frame, palette) {
    super(ctx, {
      border: true,
      borderStyle: "rounded",
      title: frame.title ? ` ${frame.title} ` : undefined,
      height: frame.height,
      maxHeight: frame.height === "auto" ? MAX_HEIGHT : undefined,
      width: frame.width === "auto" ? "100%" : frame.width,
      maxWidth: "100%",
      flexDirection: "column",
      paddingLeft: 1,
      paddingRight: 1,
      overflow: "hidden"
    });
    this.controller = controller;
    this.palette = palette;
    this.detach = controller.attach(() => this.update());
    this.onSizeChange = () => this.caption();
    this.onMouseOver = (event) => {
      this.hoverSeq++;
      this.controller.hover(this.idsFrom(event.target));
    };
    this.onMouseOut = () => {
      const seq = this.hoverSeq;
      queueMicrotask(() => {
        if (seq === this.hoverSeq && !this.isDestroyed)
          this.controller.hover([]);
      });
    };
    this.update();
  }
  caption() {
    const diagnostic = this.controller.diagnostic;
    const text = diagnostic ? `\u26A0 ${diagnostic}` : this.controller.interactive ? undefined : "streaming\u2026";
    const room = Math.max(4, (this.width || 40) - 6);
    const fitted = text && text.length > room ? text.slice(0, room - 1) + "\u2026" : text;
    const title = fitted ? ` ${fitted} ` : undefined;
    if (this.bottomTitle !== title)
      this.bottomTitle = title;
  }
  update() {
    if (this.isDestroyed)
      return;
    const interactive = this.controller.interactive;
    const diagnostic = this.controller.diagnostic;
    this.borderColor = diagnostic ? this.palette.error : interactive ? this.palette.border : this.palette.muted;
    this.caption();
    const view = diagnostic ? [...this.controller.view, { t: "text", p: { color: "error" }, c: [diagnostic], k: "__error" }] : this.controller.view;
    this.fibers = this.reconcile(this, this.fibers, view, interactive);
    this.requestRender();
  }
  reconcile(parent, old, nodes, interactive, inRow = false) {
    const unmatched = new Map(old.map((fiber, i) => [identity(fiber.node, i), fiber]));
    const next = nodes.map((node, i) => {
      const id = identity(node, i);
      const fiber = unmatched.get(id);
      if (!fiber || typeOf(fiber.node) !== typeOf(node))
        return this.mount(node, interactive, inRow);
      unmatched.delete(id);
      fiber.inRow = inRow;
      this.patch(fiber, node, interactive);
      return fiber;
    });
    unmatched.forEach((fiber) => fiber.view.destroyRecursively());
    next.forEach((fiber, i) => {
      if (parent.getChildren()[i] !== fiber.view)
        parent.add(fiber.view, i);
    });
    return next;
  }
  mount(node, interactive, inRow) {
    const fiber = {
      node,
      view: this.create(node),
      children: [],
      applied: new Map,
      interactive,
      inRow,
      armed: false,
      dragging: false
    };
    if (typeof node !== "string" && node.k !== undefined)
      this.ids.set(fiber.view, node.k);
    if (typeof node !== "string" && node.t === "button")
      this.listenButton(fiber);
    if (typeof node !== "string" && node.t === "slider")
      this.listenSlider(fiber);
    this.patch(fiber, node, interactive);
    return fiber;
  }
  create(node) {
    if (typeof node === "string" || isLeaf(node.t))
      return new TextRenderable(this.ctx, {
        content: "",
        selectable: typeof node === "string" || !["button", "slider"].includes(node.t)
      });
    return new BoxRenderable(this.ctx, {});
  }
  patch(fiber, node, interactive) {
    fiber.node = node;
    fiber.interactive = interactive;
    const palette = this.palette;
    const set = (key, value, apply) => {
      if (fiber.applied.has(key) && fiber.applied.get(key) === value)
        return;
      fiber.applied.set(key, value);
      apply();
    };
    if (typeof node === "string") {
      const text = fiber.view;
      set("content", node, () => text.content = node);
      set("fg", palette.text, () => text.fg = palette.text);
      set("wrap", "word", () => text.wrapMode = "word");
      return;
    }
    if (!isLeaf(node.t)) {
      const box = fiber.view;
      const row = node.t === "row";
      set("direction", row, () => box.flexDirection = row ? "row" : "column");
      set("align", row, () => box.alignItems = row ? "center" : "stretch");
      set("shrink", 0, () => box.flexShrink = 0);
      const gap = numberOf(node.p.gap, row ? 1 : 0);
      set("gap", gap, () => box.gap = gap);
      const padding = numberOf(node.p.padding, 0);
      set("padding", padding, () => box.padding = padding);
      const border = node.p.border === true;
      set("border", border, () => {
        box.border = border;
        if (!border)
          return;
        box.borderStyle = "rounded";
        box.borderColor = palette.border;
      });
      fiber.children = this.reconcile(box, fiber.children, node.c, interactive, row);
      return;
    }
    const text = fiber.view;
    const leaf = this.leaf(fiber, node);
    set("content", leaf.content, () => text.content = leaf.content);
    set("fg", leaf.fg, () => text.fg = leaf.fg);
    set("attributes", leaf.attributes, () => text.attributes = leaf.attributes);
    set("wrap", leaf.wrap, () => text.wrapMode = leaf.wrap);
    set("width", leaf.width, () => text.width = leaf.width ?? "auto");
    set("height", leaf.height, () => text.height = leaf.height ?? "auto");
    set("shrink", leaf.shrink, () => text.flexShrink = leaf.shrink);
  }
  leaf(fiber, node) {
    const palette = this.palette;
    if (node.t === "button") {
      const enabled = buttonEnabled(fiber, node);
      return {
        content: `[ ${textOf(node.c)} ]`,
        fg: enabled ? palette.accent : palette.muted,
        attributes: TextAttributes.BOLD | (fiber.armed ? TextAttributes.INVERSE : 0),
        wrap: "word",
        shrink: 0
      };
    }
    if (node.t === "slider") {
      const slider = sliderOf(node);
      return {
        content: fiber.dragging ? String(fiber.applied.get("content")) : drawSlider(slider, slider.value),
        fg: fiber.interactive && slider.handler ? palette.accent : palette.muted,
        attributes: 0,
        wrap: "none",
        width: slider.width,
        height: 1,
        shrink: 0
      };
    }
    if (node.t === "progress") {
      const width = numberOf(node.p.width, 20);
      const ratio = Math.min(1, Math.max(0, numberOf(node.p.value, 0) / numberOf(node.p.max, 100)));
      const filled = Math.round(ratio * width);
      return {
        content: "\u2588".repeat(filled) + "\u2591".repeat(width - filled),
        fg: colorOf(node.p.color, palette) ?? palette.accent,
        attributes: 0,
        wrap: "none",
        height: 1,
        shrink: 0
      };
    }
    if (node.t === "divider")
      return { content: "\u2500".repeat(200), fg: palette.border, attributes: 0, wrap: "none", height: 1, shrink: fiber.inRow ? 1 : 0 };
    return {
      content: textOf(node.c),
      fg: colorOf(node.p.color, palette) ?? (node.p.dim ? palette.muted : palette.text),
      attributes: (node.p.bold ? TextAttributes.BOLD : 0) | (node.p.dim ? TextAttributes.DIM : 0),
      wrap: "word",
      shrink: fiber.inRow ? 1 : 0
    };
  }
  listenButton(fiber) {
    const text = fiber.view;
    const repaint = () => this.patch(fiber, fiber.node, fiber.interactive);
    text.onMouseDown = (event) => {
      if (event.button !== 0 || typeof fiber.node === "string" || !buttonEnabled(fiber, fiber.node))
        return;
      event.stopPropagation();
      fiber.armed = true;
      repaint();
    };
    text.onMouseUp = (event) => {
      if (!fiber.armed)
        return;
      fiber.armed = false;
      repaint();
      if (event.button !== 0 || typeof fiber.node === "string" || !buttonEnabled(fiber, fiber.node))
        return;
      event.stopPropagation();
      const handler = handlerOf(fiber.node.p.onClick);
      if (handler)
        this.controller.dispatch({ handler });
    };
  }
  listenSlider(fiber) {
    const text = fiber.view;
    const move = (event, done, dragging = false) => {
      if (event.button !== 0 || typeof fiber.node === "string")
        return;
      const slider = sliderOf(fiber.node);
      if (!fiber.interactive || !slider.handler)
        return;
      event.stopPropagation();
      const ratio = Math.min(1, Math.max(0, (event.x - text.x) / (slider.width - 1)));
      const raw = slider.min + ratio * (slider.max - slider.min);
      const value = Math.min(slider.max, Math.max(slider.min, Math.round(raw / slider.step) * slider.step));
      const content = drawSlider(slider, value);
      fiber.applied.set("content", content);
      text.content = content;
      fiber.dragging = dragging && !done;
      this.controller.dispatch({ handler: slider.handler, args: [value] });
    };
    text.onMouseDown = (event) => move(event, false);
    text.onMouseDrag = (event) => move(event, false, true);
    text.onMouseDragEnd = (event) => move(event, true);
    text.onMouseUp = (event) => move(event, true);
  }
  idsFrom(target) {
    const out = [];
    for (let view = target;view && view !== this; view = view.parent) {
      const id = this.ids.get(view);
      if (id)
        out.push(id);
    }
    return out;
  }
  destroySelf() {
    this.detach();
    super.destroySelf();
  }
}
function identity(node, index) {
  return typeof node !== "string" && node.k !== undefined ? `k:${node.k}` : `#${index}`;
}
function typeOf(node) {
  return typeof node === "string" ? "#text" : node.t;
}
function isLeaf(type) {
  return ["text", "button", "slider", "progress", "divider"].includes(type);
}
function buttonEnabled(fiber, node) {
  return fiber.interactive && handlerOf(node.p.onClick) !== undefined && node.p.disabled !== true;
}
function sliderOf(node) {
  const min = numberOf(node.p.min, 0);
  return {
    min,
    max: Math.max(min + 1, numberOf(node.p.max, 100)),
    step: numberOf(node.p.step, 1),
    width: Math.max(5, numberOf(node.p.width, 24)),
    value: numberOf(node.p.value, min),
    handler: handlerOf(node.p.onChange)
  };
}
function drawSlider(slider, value) {
  const position = Math.round((value - slider.min) / (slider.max - slider.min) * (slider.width - 1));
  return "\u2501".repeat(position) + "\u25CF" + "\u2500".repeat(slider.width - 1 - position);
}
function textOf(children) {
  return children.map((child) => typeof child === "string" ? child : textOf(child.c)).join("");
}
function numberOf(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
function handlerOf(value) {
  if (value && typeof value === "object" && "$h" in value && typeof value.$h === "string")
    return value.$h;
  return;
}
function colorOf(value, palette) {
  if (value === "muted")
    return palette.muted;
  if (value === "accent")
    return palette.accent;
  if (value === "error")
    return palette.error;
  return;
}

// src/tui/block.ts
function createUiBlockRenderer(renderer, palette) {
  return (token) => {
    const frame = parseFence(token.lang ?? "");
    if (!frame)
      return;
    if (!token.raw.includes(`
`))
      return;
    const closed = isClosed(token.raw);
    const controller = controllerFor(closed ? `block:${Bun.hash(token.lang + `
` + token.text)}` : `streaming:${token.lang}`);
    controller.update(token.text, closed);
    return new UiBlockRenderable(renderer, controller, frame, palette());
  };
}
function isClosed(raw) {
  const fence = /^ {0,3}(`{3,}|~{3,})/.exec(raw)?.[1];
  if (!fence)
    return false;
  const lines = raw.trimEnd().split(`
`);
  if (lines.length < 2)
    return false;
  const last = lines[lines.length - 1].trim();
  return last.length >= fence.length && last === fence[0].repeat(last.length);
}

// src/tui/plugin.ts
var plugin_default = {
  id: "opencode-ui-blocks",
  setup(context) {
    context.markdown.registerCodeBlockRenderer("ui", createUiBlockRenderer(context.renderer, () => ({
      text: context.theme.text.base,
      muted: context.theme.text.muted,
      accent: context.theme.text.action.primary.base,
      error: context.theme.text.feedback.error.base,
      border: context.theme.border.base
    })));
  }
};
export {
  plugin_default as default
};
