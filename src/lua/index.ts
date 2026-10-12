import { call, compile, type Runtime } from "./compiler"
import { installStdlib } from "./lib/stdlib"
import { parse } from "./parser"
import { journal, LuaFunction, LuaTable, type LuaValue } from "./value"

export { LuaSyntaxError } from "./lexer"
export { journal, LuaError, LuaFunction, LuaLimitError, LuaTable, tostring, type, type LuaValue } from "./value"

export type LuaOptions = {
  /** Steps (calls + loop iterations) allowed per `run`/`call`. */
  maxSteps?: number
  maxDepth?: number
  /** Where `print` output goes. */
  print?: (text: string) => void
  /** Seed for math.random. */
  seed?: number
}

/** One isolated Lua state: its own globals, standard library and limits. */
export class LuaState {
  readonly rt: Runtime
  /** State changes made by the last successful transaction. */
  writes = 0

  constructor(options: LuaOptions = {}) {
    this.rt = {
      globals: new LuaTable(),
      stringMeta: new LuaTable(),
      steps: 0,
      maxSteps: options.maxSteps ?? 2_000_000,
      depth: 0,
      maxDepth: options.maxDepth ?? 200,
    }
    installStdlib(this.rt, { print: options.print, seed: options.seed })
  }

  get globals() {
    return this.rt.globals
  }

  /** Defines a host function visible to the program. */
  define(name: string, f: (args: LuaValue[]) => LuaValue[] | LuaValue) {
    this.rt.globals.rawSet(
      name,
      new LuaFunction(`builtin ${name}`, (args) => {
        const r = f(args)
        return Array.isArray(r) ? r : [r]
      }),
    )
  }

  /** Parses and compiles a chunk without running it. Throws LuaSyntaxError. */
  load(source: string): LuaFunction {
    return compile(parse(source), this.rt)
  }

  /** Runs a chunk and returns its results. */
  run(source: string): LuaValue[] {
    return this.call(this.load(source), [])
  }

  /** Calls a Lua function with a fresh step budget. */
  call(fn: LuaValue, args: LuaValue[]): LuaValue[] {
    this.rt.steps = 0
    this.rt.depth = 0
    return call(this.rt, fn, args, 0, "")
  }

  /**
   * Runs `body` as a transaction: every table and upvalue write is journaled, and rolled back if
   * `body` throws.
   */
  transaction<T>(body: () => T): T {
    if (journal.active) return body()
    journal.active = true
    journal.entries = []
    journal.epoch++
    try {
      const result = body()
      this.writes = journal.entries.length
      journal.entries = []
      return result
    } catch (error) {
      for (let i = journal.entries.length - 1; i >= 0; i--) journal.entries[i]()
      journal.entries = []
      throw error
    } finally {
      journal.active = false
    }
  }
}

