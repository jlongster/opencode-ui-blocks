export type Expr =
  | { k: "nil"; line: number }
  | { k: "true"; line: number }
  | { k: "false"; line: number }
  | { k: "number"; value: number; line: number }
  | { k: "string"; value: string; line: number }
  | { k: "vararg"; line: number }
  | { k: "function"; fn: FunctionBody; line: number }
  | { k: "name"; name: string; line: number }
  | { k: "index"; obj: Expr; key: Expr; line: number }
  | { k: "call"; fn: Expr; args: Expr[]; line: number }
  | { k: "method"; obj: Expr; name: string; args: Expr[]; line: number }
  | { k: "binop"; op: string; left: Expr; right: Expr; line: number }
  | { k: "and" | "or"; left: Expr; right: Expr; line: number }
  | { k: "unop"; op: string; expr: Expr; line: number }
  | { k: "table"; items: TableItem[]; line: number }
  | { k: "paren"; expr: Expr; line: number }

export type TableItem =
  | { k: "pos"; value: Expr }
  | { k: "named"; name: string; value: Expr }
  | { k: "keyed"; key: Expr; value: Expr }

export type FunctionBody = {
  params: string[]
  vararg: boolean
  body: Stat[]
  name: string
  line: number
  /** Filled in by the resolver. */
  scope?: unknown
}

export type Stat =
  | { k: "local"; names: string[]; values: Expr[]; line: number }
  | { k: "assign"; targets: Expr[]; values: Expr[]; line: number }
  | { k: "call"; call: Expr; line: number }
  | { k: "do"; body: Stat[]; line: number }
  | { k: "while"; cond: Expr; body: Stat[]; line: number }
  | { k: "repeat"; body: Stat[]; cond: Expr; line: number }
  | { k: "if"; clauses: { cond: Expr; body: Stat[] }[]; orelse?: Stat[]; line: number }
  | { k: "fornum"; name: string; start: Expr; stop: Expr; step?: Expr; body: Stat[]; line: number }
  | { k: "forin"; names: string[]; exprs: Expr[]; body: Stat[]; line: number }
  | { k: "function"; target: Expr; fn: FunctionBody; line: number }
  | { k: "localfunction"; name: string; fn: FunctionBody; line: number }
  | { k: "return"; values: Expr[]; line: number }
  | { k: "break"; line: number }
