import { describe, expect, test } from "bun:test"
import { LuaError, LuaLimitError, LuaState, LuaSyntaxError } from "../../src/lua"

/** Runs a chunk and returns everything it printed, one line per print. */
function run(source: string) {
  const out: string[] = []
  new LuaState({ print: (text) => out.push(text) }).run(source)
  return out.join("\n")
}

function error(source: string) {
  try {
    run(source)
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
  return "no error"
}

describe("values and operators", () => {
  test.each([
    ["print(1 + 2, 7 / 2, 7 // 2, 7 % 3, -7 % 3, 2 ^ 10)", "3\t3.5\t3\t1\t2\t1024"],
    ["print(10 / 3)", "3.3333333333333"],
    ["print(0.1 + 0.2, 1e20, 1/0, -1/0)", "0.3\t1e+20\tinf\t-inf"],
    ['print("10" + 1, "3" * "4", 10 .. 20)', "11\t12\t1020"],
    ['print(1 == 1.0, "a" < "b", 2 <= 1, nil == false)', "true\ttrue\tfalse\tfalse"],
    ["print(nil and 1, false or 2, 1 and 2, nil or false)", "nil\t2\t2\tfalse"],
    ["print(not nil, not 0, #\"hello\", #{1, 2, 3})", "true\tfalse\t5\t3"],
    ["print(2 ^ 3 ^ 2, -2 ^ 2, 1 .. 2 .. 3)", "512\t-4\t123"],
    ["print(0x10, 0xff, 1e2, .5)", "16\t255\t100\t0.5"],
  ])("%s", (source, expected) => expect(run(source)).toBe(expected))
})

describe("strings", () => {
  test.each([
    [`print("a\\tb", 'it\\'s', [[long
string]])`, "a\tb\tit's\tlong\nstring"],
    ['print(("hello"):upper(), string.len("abc"), ("x"):rep(3, ","))', "HELLO\t3\tx,x,x"],
    ['print(("hello world"):sub(1, 5), ("hello"):sub(-3), ("hello"):sub(2))', "hello\tllo\tello"],
    ['print(string.format("%5.2f|%-5d|%05d|%x|%s|%q", 3.14159, 42, 7, 255, "hi", "a\\nb"))', ' 3.14|42   |00007|ff|hi|"a\\nb"'],
    ['print(string.format("%d items, %.1fs, %g", 3, 1.26, 0.0001))', "3 items, 1.3s, 0.0001"],
    ['print(("✓ done"):len(), ("→"):rep(2))', "6\t→→"],
  ])("%s", (source, expected) => expect(run(source)).toBe(expected))
})

describe("patterns", () => {
  test.each([
    ['print(string.find("hello world", "wor"))', "7\t9"],
    ['print(string.find("hello", "l+"))', "3\t4"],
    ['print(string.match("key=value", "(%w+)=(%w+)"))', "key\tvalue"],
    ['print(string.match("  trim  ", "^%s*(.-)%s*$"))', "trim"],
    ['print(string.gsub("hello world", "o", "0"))', "hell0 w0rld\t2"],
    ['print(string.gsub("abc", "%w", "%0%0"))', "aabbcc\t3"],
    ['print((string.gsub("$name is $age", "%$(%w+)", {name = "Ann", age = 7})))', "Ann is 7"],
    ['print((string.gsub("a,b,,c", ",", ";", 2)))', "a;b;,c"],
    ['local t = {} for w in string.gmatch("one two  three", "%a+") do t[#t+1] = w end print(table.concat(t, "|"))', "one|two|three"],
    ['for k, v in string.gmatch("a=1, b=2", "(%w+)=(%w+)") do print(k, v) end', "a\t1\nb\t2"],
    ['print(string.match("f(a(b)c)", "%b()"))', "(a(b)c)"],
    ['print(string.find("THE (quick) fox", "%f[%a]%a+", 5))', "6\t10"],
    ['print(string.match("hello", "()ll()"))', "3\t5"],
    ['print(("a.b"):find(".", 1, true), ("x+y"):find("+", 1, true))', "2\t2\t2"],
  ])("%s", (source, expected) => expect(run(source)).toBe(expected))
})

describe("tables", () => {
  test.each([
    ["local t = {10, 20, 30, x = 1} print(#t, t[2], t.x, t.missing)", "3\t20\t1\tnil"],
    ["local t = {} t[1] = 'a' t[2] = 'b' t[3] = 'c' t[3] = nil print(#t)", "2"],
    ["local t = {} table.insert(t, 'a') table.insert(t, 1, 'b') table.insert(t, 'c') print(table.concat(t, ','))", "b,a,c"],
    ["local t = {1, 2, 3, 4} print(table.remove(t), table.remove(t, 1), table.concat(t, ','))", "4\t1\t2,3"],
    ["local t = {5, 2, 8, 1} table.sort(t) print(table.concat(t, ' '))", "1 2 5 8"],
    ["local t = {5, 2, 8} table.sort(t, function(a, b) return a > b end) print(table.concat(t, ' '))", "8 5 2"],
    ["local t = {a = 1, b = 2, c = 3} local keys = {} for k in pairs(t) do keys[#keys + 1] = k end print(table.concat(keys))", "abc"],
    ["for i, v in ipairs({'x', 'y', nil, 'z'}) do print(i, v) end", "1\tx\n2\ty"],
    ["print(select('#', 1, nil, 3), select(2, 'a', 'b', 'c'))", "3\tb\tc"],
    ["print(unpack({1, 2, 3}))", "1\t2\t3"],
    ["local t = {f = function(self, x) return self.v + x end, v = 10} print(t:f(5))", "15"],
    ["local p = {} function p.add(a, b) return a + b end function p:twice(x) return x * 2 end print(p.add(1, 2), p:twice(4))", "3\t8"],
  ])("%s", (source, expected) => expect(run(source)).toBe(expected))
})

describe("functions and scope", () => {
  test.each([
    ["local function fib(n) if n < 2 then return n end return fib(n - 1) + fib(n - 2) end print(fib(20))", "6765"],
    ["local function counter() local n = 0 return function() n = n + 1 return n end end local c = counter() c() c() print(c())", "3"],
    ["local fns = {} for i = 1, 3 do fns[i] = function() return i end end print(fns[1](), fns[2](), fns[3]())", "1\t2\t3"],
    ["local fns = {} local i = 1 while i <= 3 do local j = i fns[i] = function() return j end i = i + 1 end print(fns[1](), fns[3]())", "1\t3"],
    ["local function f(...) return select('#', ...), ... end print(f(1, 2, 3))", "3\t1\t2\t3"],
    ["local function f() return 1, 2 end local a, b, c = f() print(a, b, c) print((f()))", "1\t2\tnil\n1"],
    ["local t = {(function() return 1, 2 end)()} print(#t)", "2"],
    ["local a, b = 1, 2 a, b = b, a print(a, b)", "2\t1"],
    ["x = 5 local function f() x = x + 1 end f() print(x)", "6"],
    ["local x = 1 do local x = 2 end print(x)", "1"],
    ["local s = 0 for i = 10, 1, -3 do s = s + i end print(s)", "22"],
    ["local i = 0 repeat local j = i i = i + 1 until j >= 2 print(i)", "3"],
    ["for i = 1, 5 do if i == 3 then break end print(i) end", "1\n2"],
    ["local n = 0 for k, v in pairs({1, 2, a = 3}) do n = n + v end print(n)", "6"],
    ["print(pcall(function() error('boom') end))", "false\tline 1: boom"],
    ["print(pcall(function() error({code = 7}) end) == false)", "true"],
    ["print(pcall(function() local t = nil return t.x end))", "false\tline 1: attempt to index a nil value (local 't')"],
    ["print(select(2, pcall(error)))", "nil"],
    ["print(math.max(3, 9, 2), math.floor(3.7), math.huge, math.pi > 3)", "9\t3\tinf\ttrue"],
    ["print(tostring(nil), tostring(12), tonumber('0x1f'), tonumber('z', 36), tonumber('abc'))", "nil\t12\t31\t35\tnil"],
  ])("%s", (source, expected) => expect(run(source)).toBe(expected))
})

describe("errors", () => {
  test.each([
    ["local t = nil\nprint(t.x)", "line 2: attempt to index a nil value (local 't')"],
    ["undefinedFn()", "line 1: attempt to call a nil value (global 'undefinedFn')"],
    ["local t = {}\nt.a.b = 1", "line 2: attempt to index a nil value (field 'a')"],
    ["print(1 + nil)", "line 1: attempt to perform arithmetic on a nil value"],
    ["print({} < {})", "line 1: attempt to compare two table values"],
    ["print('a' .. {})", "line 1: attempt to concatenate a table value"],
    ["local x = 1 +", "line 1: unexpected symbol near <eof>"],
    ["if true then print(1)", "line 1: 'end' expected near <eof>"],
    ["goto done", "line 1: goto is not supported"],
    ["setmetatable({}, {})", "line 1: setmetatable is not supported in widgets (metatables are not available)"],
    ["print(os.time())", "line 1: the 'os' library is not available in widgets"],
    ["error('custom', 0)", "custom"],
  ])("%s", (source, expected) => expect(error(source)).toBe(expected))

  test("syntax errors are LuaSyntaxError and flag incomplete input", () => {
    try {
      run("function f()\n  return 1")
    } catch (e) {
      expect(e).toBeInstanceOf(LuaSyntaxError)
      expect((e as LuaSyntaxError).incomplete).toBe(true)
      return
    }
    throw new Error("expected a syntax error")
  })

  test("runaway loops hit the step limit, and pcall cannot swallow it", () => {
    const state = new LuaState({ maxSteps: 10_000 })
    expect(() => state.run("while true do end")).toThrow(LuaLimitError)
    expect(() => state.run("print(pcall(function() while true do end end))")).toThrow(LuaLimitError)
  })

  test("deep recursion is a limit error, not a crash", () => {
    expect(() => new LuaState().run("local function f() return f() + 1 end f()")).toThrow(LuaLimitError)
  })

  test("runtime errors are LuaError", () => {
    expect(() => run("error('x')")).toThrow(LuaError)
  })
})

describe("transactions", () => {
  test("a failing transaction rolls back table and upvalue writes", () => {
    const state = new LuaState()
    state.run(`
      count = 0
      items = {1, 2}
      local hidden = 10
      function bump() count = count + 1; items[#items + 1] = 3; hidden = hidden + 1; error("fail") end
      function peek() return hidden end
    `)
    expect(() => state.transaction(() => state.call(state.globals.get("bump"), []))).toThrow()
    expect(state.globals.get("count")).toBe(0)
    expect(state.run("return #items")[0]).toBe(2)
    expect(state.call(state.globals.get("peek"), [])[0]).toBe(10)
  })

  test("a successful transaction keeps its writes", () => {
    const state = new LuaState()
    state.run("n = 1 function inc() n = n + 1 end")
    state.transaction(() => state.call(state.globals.get("inc"), []))
    expect(state.globals.get("n")).toBe(2)
  })
})
