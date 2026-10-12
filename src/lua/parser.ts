import type { Expr, FunctionBody, Stat, TableItem } from "./ast"
import { LuaSyntaxError, tokenize, type Token } from "./lexer"

/** Parses a Lua chunk. The chunk is the body of a vararg function named "main chunk". */
export function parse(source: string): FunctionBody {
  const p = new Parser(tokenize(source))
  const body = p.block()
  if (p.cur.kind !== "eof") p.fail(`'<eof>' expected near ${p.near}`)
  return { params: [], vararg: true, body, name: "main chunk", line: 1 }
}

// Binary operator precedence: [left, right]. Right-associative operators bind tighter on the right side.
const BINARY: Record<string, [number, number]> = {
  or: [1, 1], and: [2, 2],
  "<": [3, 3], ">": [3, 3], "<=": [3, 3], ">=": [3, 3], "~=": [3, 3], "==": [3, 3],
  "|": [4, 4], "~": [5, 5], "&": [6, 6], "<<": [7, 7], ">>": [7, 7],
  "..": [9, 8], "+": [10, 10], "-": [10, 10],
  "*": [11, 11], "/": [11, 11], "//": [11, 11], "%": [11, 11],
  "^": [14, 13],
}
const UNARY_PRIORITY = 12
const BITWISE = new Set(["|", "~", "&", "<<", ">>"])

class Parser {
  i = 0
  constructor(readonly tokens: Token[]) {}

  get cur() {
    return this.tokens[this.i]
  }

  /** How Lua names the current token in messages: `'x'`, or `<eof>` unquoted. */
  get near() {
    return this.cur.kind === "eof" ? "<eof>" : `'${this.cur.value}'`
  }

  fail(message: string): never {
    throw new LuaSyntaxError(message, this.cur.line, this.cur.kind === "eof")
  }

  check(value: string) {
    const t = this.cur
    return (t.kind === "op" || t.kind === "keyword") && t.value === value
  }

  accept(value: string) {
    if (!this.check(value)) return false
    this.i++
    return true
  }

  expect(value: string, opener?: { what: string; line: number }) {
    if (this.accept(value)) return
    const near = this.near
    if (opener && opener.line !== this.cur.line) this.fail(`'${value}' expected (to close '${opener.what}' at line ${opener.line}) near ${near}`)
    this.fail(`'${value}' expected near ${near}`)
  }

  name(): string {
    const t = this.cur
    if (t.kind !== "name") this.fail(`<name> expected near ${this.near}`)
    this.i++
    return t.value
  }

  blockEnds() {
    const t = this.cur
    return t.kind === "eof" || (t.kind === "keyword" && ["end", "else", "elseif", "until"].includes(t.value))
  }

  block(): Stat[] {
    const out: Stat[] = []
    while (!this.blockEnds()) {
      if (this.check("return")) {
        out.push(this.returnStat())
        break
      }
      const stat = this.statement()
      if (stat) out.push(stat)
    }
    return out
  }

  returnStat(): Stat {
    const line = this.cur.line
    this.i++
    const values = this.blockEnds() || this.check(";") ? [] : this.exprList()
    this.accept(";")
    if (!this.blockEnds()) this.fail(`'<eof>' expected near ${this.near}`)
    return { k: "return", values, line }
  }

  statement(): Stat | undefined {
    const t = this.cur
    const line = t.line
    if (this.accept(";")) return undefined
    if (t.kind === "keyword") {
      switch (t.value) {
        case "if": return this.ifStat()
        case "while": {
          this.i++
          const cond = this.expr()
          this.expect("do")
          const body = this.block()
          this.expect("end", { what: "while", line })
          return { k: "while", cond, body, line }
        }
        case "do": {
          this.i++
          const body = this.block()
          this.expect("end", { what: "do", line })
          return { k: "do", body, line }
        }
        case "for": return this.forStat()
        case "repeat": {
          this.i++
          const body = this.block()
          this.expect("until", { what: "repeat", line })
          return { k: "repeat", body, cond: this.expr(), line }
        }
        case "function": {
          this.i++
          let target: Expr = { k: "name", name: this.name(), line }
          let fullName = (target as { name: string }).name
          while (this.check(".")) {
            this.i++
            const key = this.name()
            fullName += "." + key
            target = { k: "index", obj: target, key: { k: "string", value: key, line }, line }
          }
          let method = false
          if (this.accept(":")) {
            const key = this.name()
            fullName += ":" + key
            target = { k: "index", obj: target, key: { k: "string", value: key, line }, line }
            method = true
          }
          return { k: "function", target, fn: this.functionBody(fullName, line, method), line }
        }
        case "local": {
          this.i++
          if (this.accept("function")) {
            const name = this.name()
            return { k: "localfunction", name, fn: this.functionBody(name, line, false), line }
          }
          const names = [this.attribName()]
          while (this.accept(",")) names.push(this.attribName())
          const values = this.accept("=") ? this.exprList() : []
          return { k: "local", names, values, line }
        }
        case "return": return this.returnStat()
        case "break": this.i++; return { k: "break", line }
        case "goto": this.fail("goto is not supported")
      }
    }
    if (this.check("::")) this.fail("labels (::name::) are not supported")

    const first = this.suffixedExpr()
    if (this.check("=") || this.check(",")) {
      const targets = [first]
      while (this.accept(",")) targets.push(this.suffixedExpr())
      targets.forEach((target) => {
        if (target.k !== "name" && target.k !== "index") this.fail("syntax error near '='")
      })
      this.expect("=")
      return { k: "assign", targets, values: this.exprList(), line }
    }
    if (first.k !== "call" && first.k !== "method") this.fail(`syntax error near ${this.near}`)
    return { k: "call", call: first, line }
  }

  attribName() {
    const name = this.name()
    if (this.check("<")) this.fail("variable attributes (<const>, <close>) are not supported")
    return name
  }

  ifStat(): Stat {
    const line = this.cur.line
    this.i++
    const clauses: { cond: Expr; body: Stat[] }[] = []
    const cond = this.expr()
    this.expect("then")
    clauses.push({ cond, body: this.block() })
    let orelse: Stat[] | undefined
    for (;;) {
      if (this.accept("elseif")) {
        const c = this.expr()
        this.expect("then")
        clauses.push({ cond: c, body: this.block() })
        continue
      }
      if (this.accept("else")) orelse = this.block()
      this.expect("end", { what: "if", line })
      return { k: "if", clauses, orelse, line }
    }
  }

  forStat(): Stat {
    const line = this.cur.line
    this.i++
    const first = this.name()
    if (this.accept("=")) {
      const start = this.expr()
      this.expect(",")
      const stop = this.expr()
      const step = this.accept(",") ? this.expr() : undefined
      this.expect("do")
      const body = this.block()
      this.expect("end", { what: "for", line })
      return { k: "fornum", name: first, start, stop, step, body, line }
    }
    const names = [first]
    while (this.accept(",")) names.push(this.name())
    this.expect("in")
    const exprs = this.exprList()
    this.expect("do")
    const body = this.block()
    this.expect("end", { what: "for", line })
    return { k: "forin", names, exprs, body, line }
  }

  functionBody(name: string, line: number, method: boolean): FunctionBody {
    this.expect("(")
    const params = method ? ["self"] : []
    let vararg = false
    if (!this.check(")")) {
      for (;;) {
        if (this.accept("...")) { vararg = true; break }
        params.push(this.name())
        if (!this.accept(",")) break
      }
    }
    this.expect(")")
    const body = this.block()
    this.expect("end", { what: "function", line })
    return { params, vararg, body, name, line }
  }

  exprList(): Expr[] {
    const out = [this.expr()]
    while (this.accept(",")) out.push(this.expr())
    return out
  }

  expr(limit = 0): Expr {
    const t = this.cur
    let left: Expr
    if ((t.kind === "keyword" && t.value === "not") || (t.kind === "op" && (t.value === "-" || t.value === "#" || t.value === "~"))) {
      if (t.value === "~") this.fail("bitwise operators are not supported")
      this.i++
      left = { k: "unop", op: t.value, expr: this.expr(UNARY_PRIORITY), line: t.line }
    } else left = this.simpleExpr()
    for (;;) {
      const op = this.cur
      const prec = (op.kind === "op" || op.kind === "keyword") ? BINARY[op.value] : undefined
      if (!prec || prec[0] <= limit) return left
      if (BITWISE.has(op.value)) this.fail("bitwise operators are not supported")
      this.i++
      const right = this.expr(prec[1])
      left = op.value === "and" || op.value === "or"
        ? { k: op.value, left, right, line: op.line }
        : { k: "binop", op: op.value, left, right, line: op.line }
    }
  }

  simpleExpr(): Expr {
    const t = this.cur
    const line = t.line
    if (t.kind === "number") { this.i++; return { k: "number", value: t.literal as number, line } }
    if (t.kind === "string") { this.i++; return { k: "string", value: t.literal as string, line } }
    if (t.kind === "keyword") {
      if (t.value === "nil") { this.i++; return { k: "nil", line } }
      if (t.value === "true") { this.i++; return { k: "true", line } }
      if (t.value === "false") { this.i++; return { k: "false", line } }
      if (t.value === "function") { this.i++; return { k: "function", fn: this.functionBody("anonymous", line, false), line } }
    }
    if (t.kind === "op" && t.value === "...") { this.i++; return { k: "vararg", line } }
    if (t.kind === "op" && t.value === "{") return this.table()
    return this.suffixedExpr()
  }

  primaryExpr(): Expr {
    const t = this.cur
    if (t.kind === "name") { this.i++; return { k: "name", name: t.value, line: t.line } }
    if (this.accept("(")) {
      const expr = this.expr()
      this.expect(")", { what: "(", line: t.line })
      return { k: "paren", expr, line: t.line }
    }
    this.fail(`unexpected symbol near ${this.near}`)
  }

  suffixedExpr(): Expr {
    let e = this.primaryExpr()
    for (;;) {
      const t = this.cur
      const line = t.line
      if (this.accept(".")) e = { k: "index", obj: e, key: { k: "string", value: this.name(), line }, line }
      else if (this.check("[")) {
        this.i++
        const key = this.expr()
        this.expect("]")
        e = { k: "index", obj: e, key, line }
      } else if (this.accept(":")) {
        const name = this.name()
        e = { k: "method", obj: e, name, args: this.callArgs(), line }
      } else if (this.check("(") || this.check("{") || t.kind === "string") e = { k: "call", fn: e, args: this.callArgs(), line }
      else return e
    }
  }

  callArgs(): Expr[] {
    const t = this.cur
    if (t.kind === "string") { this.i++; return [{ k: "string", value: t.literal as string, line: t.line }] }
    if (this.check("{")) return [this.table()]
    this.expect("(")
    if (this.accept(")")) return []
    const args = this.exprList()
    this.expect(")", { what: "(", line: t.line })
    return args
  }

  table(): Expr {
    const line = this.cur.line
    this.expect("{")
    const items: TableItem[] = []
    while (!this.check("}")) {
      if (this.check("[")) {
        this.i++
        const key = this.expr()
        this.expect("]")
        this.expect("=")
        items.push({ k: "keyed", key, value: this.expr() })
      } else if (this.cur.kind === "name" && this.tokens[this.i + 1]?.value === "=" && this.tokens[this.i + 1]?.kind === "op") {
        const name = this.name()
        this.i++
        items.push({ k: "named", name, value: this.expr() })
      } else items.push({ k: "pos", value: this.expr() })
      if (!this.accept(",") && !this.accept(";")) break
    }
    this.expect("}", { what: "{", line })
    return { k: "table", items, line }
  }
}
