import { LuaError, type LuaValue } from "../value"

/** Lua pattern matching, ported from lstrlib.c. Operates on characters of a JS string. */

const CAP_UNFINISHED = -1
const CAP_POSITION = -2
const SPECIALS = /[\^$*+?.()[\]%-]/
const MAX_CAPTURES = 32

class MatchState {
  level = 0
  capture: { init: number; len: number }[] = []
  matchdepth = 0

  constructor(
    readonly src: string,
    readonly pat: string,
  ) {}

  classEnd(p: number): number {
    const pat = this.pat
    const c = pat[p++]
    if (c === "%") {
      if (p >= pat.length) throw new LuaError("malformed pattern (ends with '%')")
      return p + 1
    }
    if (c === "[") {
      if (pat[p] === "^") p++
      do {
        if (p >= pat.length) throw new LuaError("malformed pattern (missing ']')")
        const cc = pat[p++]
        if (cc === "%") p++
      } while (pat[p] !== "]")
      return p + 1
    }
    return p
  }

  singleMatch(s: number, p: number, ep: number): boolean {
    if (s >= this.src.length) return false
    const c = this.src[s]
    const pc = this.pat[p]
    if (pc === ".") return true
    if (pc === "%") return matchClass(c, this.pat[p + 1])
    if (pc === "[") return this.matchBracket(c, p, ep - 1)
    return pc === c
  }

  matchBracket(c: string, p: number, ec: number): boolean {
    const pat = this.pat
    let sig = true
    if (pat[p + 1] === "^") {
      sig = false
      p++
    }
    while (++p < ec) {
      if (pat[p] === "%") {
        p++
        if (matchClass(c, pat[p])) return sig
      } else if (pat[p + 1] === "-" && p + 2 < ec) {
        p += 2
        if (pat[p - 2] <= c && c <= pat[p]) return sig
      } else if (pat[p] === c) return sig
    }
    return !sig
  }

  doMatch(s: number, p: number): number {
    if (++this.matchdepth > 200) throw new LuaError("pattern too complex")
    try {
      const pat = this.pat
      const src = this.src
      for (;;) {
        if (p === pat.length) return s
        const pc = pat[p]
        if (pc === "(") {
          return pat[p + 1] === ")" ? this.startCapture(s, p + 2, CAP_POSITION) : this.startCapture(s, p + 1, CAP_UNFINISHED)
        }
        if (pc === ")") return this.endCapture(s, p + 1)
        if (pc === "$" && p + 1 === pat.length) return s === src.length ? s : -1
        if (pc === "%" && pat[p + 1] === "b") {
          s = this.matchBalance(s, p + 2)
          if (s === -1) return -1
          p += 4
          continue
        }
        if (pc === "%" && pat[p + 1] === "f") {
          p += 2
          if (pat[p] !== "[") throw new LuaError("missing '[' after '%f' in pattern")
          const ep = this.classEnd(p)
          const prev = s === 0 ? "\0" : src[s - 1]
          const cur = s < src.length ? src[s] : "\0"
          if (!this.matchBracket(prev, p, ep - 1) && this.matchBracket(cur, p, ep - 1)) {
            p = ep
            continue
          }
          return -1
        }
        if (pc === "%" && /[0-9]/.test(pat[p + 1] ?? "")) {
          s = this.matchCapture(s, Number(pat[p + 1]))
          if (s === -1) return -1
          p += 2
          continue
        }
        const ep = this.classEnd(p)
        const epc = pat[ep]
        if (!this.singleMatch(s, p, ep)) {
          if (epc === "*" || epc === "?" || epc === "-") {
            p = ep + 1
            continue
          }
          return -1
        }
        if (epc === "?") {
          const res = this.doMatch(s + 1, ep + 1)
          if (res !== -1) return res
          p = ep + 1
          continue
        }
        if (epc === "+") return this.maxExpand(s + 1, p, ep)
        if (epc === "*") return this.maxExpand(s, p, ep)
        if (epc === "-") return this.minExpand(s, p, ep)
        s++
        p = ep
      }
    } finally {
      this.matchdepth--
    }
  }

  maxExpand(s: number, p: number, ep: number) {
    let i = 0
    while (this.singleMatch(s + i, p, ep)) i++
    while (i >= 0) {
      const res = this.doMatch(s + i, ep + 1)
      if (res !== -1) return res
      i--
    }
    return -1
  }

  minExpand(s: number, p: number, ep: number) {
    for (;;) {
      const res = this.doMatch(s, ep + 1)
      if (res !== -1) return res
      if (this.singleMatch(s, p, ep)) s++
      else return -1
    }
  }

  startCapture(s: number, p: number, what: number) {
    if (this.level >= MAX_CAPTURES) throw new LuaError("too many captures")
    this.capture[this.level] = { init: s, len: what }
    this.level++
    const res = this.doMatch(s, p)
    if (res === -1) this.level--
    return res
  }

  endCapture(s: number, p: number) {
    const l = this.captureToClose()
    this.capture[l].len = s - this.capture[l].init
    const res = this.doMatch(s, p)
    if (res === -1) this.capture[l].len = CAP_UNFINISHED
    return res
  }

  captureToClose() {
    for (let l = this.level - 1; l >= 0; l--) if (this.capture[l].len === CAP_UNFINISHED) return l
    throw new LuaError("invalid pattern capture")
  }

  matchBalance(s: number, p: number) {
    if (p + 1 >= this.pat.length) throw new LuaError("missing arguments to '%b'")
    const src = this.src
    if (s >= src.length || src[s] !== this.pat[p]) return -1
    const b = this.pat[p]
    const e = this.pat[p + 1]
    let cont = 1
    while (++s < src.length) {
      if (src[s] === e) {
        if (--cont === 0) return s + 1
      } else if (src[s] === b) cont++
    }
    return -1
  }

  matchCapture(s: number, digit: number) {
    const l = digit - 1
    if (l < 0 || l >= this.level || this.capture[l].len === CAP_UNFINISHED) throw new LuaError(`invalid capture index %${digit}`)
    const { init, len } = this.capture[l]
    const text = this.src.slice(init, init + len)
    if (this.src.length - s >= len && this.src.slice(s, s + len) === text) return s + len
    return -1
  }

  getCapture(i: number, s: number, e: number): LuaValue {
    if (i >= this.level) {
      if (i === 0) return this.src.slice(s, e)
      throw new LuaError(`invalid capture index %${i + 1}`)
    }
    const { init, len } = this.capture[i]
    if (len === CAP_UNFINISHED) throw new LuaError("unfinished capture")
    if (len === CAP_POSITION) return init + 1
    return this.src.slice(init, init + len)
  }

  /** The captures of a match (or the whole match when there are none). */
  captures(s: number, e: number, wholeIfNone: boolean): LuaValue[] {
    const n = this.level === 0 && wholeIfNone ? 1 : this.level
    return Array.from({ length: n }, (_, i) => this.getCapture(i, s, e))
  }
}

function matchClass(c: string, cl: string): boolean {
  const code = c.charCodeAt(0)
  let res: boolean
  switch (cl.toLowerCase()) {
    case "a": res = /[A-Za-z]/.test(c); break
    case "c": res = code < 32 || code === 127; break
    case "d": res = code >= 48 && code <= 57; break
    case "g": res = code > 32 && code < 127; break
    case "l": res = code >= 97 && code <= 122; break
    case "p": res = /[!-/:-@[-`{-~]/.test(c); break
    case "s": res = c === " " || (code >= 9 && code <= 13); break
    case "u": res = code >= 65 && code <= 90; break
    case "w": res = /[A-Za-z0-9]/.test(c); break
    case "x": res = /[0-9A-Fa-f]/.test(c); break
    default: return cl === c
  }
  return cl >= "A" && cl <= "Z" ? !res : res
}

function startIndex(len: number, init: number | undefined) {
  if (init === undefined) return 0
  if (init > 0) return init - 1
  if (init === 0) return 0
  return Math.max(0, len + init)
}

export function find(s: string, pat: string, init: number | undefined, plain: boolean, isFind: boolean): LuaValue[] {
  let start = startIndex(s.length, init)
  if (start > s.length) return [undefined]
  if (isFind && (plain || !SPECIALS.test(pat))) {
    const at = s.indexOf(pat, start)
    return at === -1 ? [undefined] : [at + 1, at + pat.length]
  }
  const anchor = pat[0] === "^"
  const p0 = anchor ? 1 : 0
  do {
    const ms = new MatchState(s, pat)
    const e = ms.doMatch(start, p0)
    if (e !== -1) {
      if (isFind) return [start + 1, e, ...ms.captures(start, e, false)]
      return ms.captures(start, e, true)
    }
    start++
  } while (start <= s.length && !anchor)
  return [undefined]
}

export function gmatch(s: string, pat: string): () => LuaValue[] {
  let pos = 0
  let lastMatch = -1
  return () => {
    for (; pos <= s.length; pos++) {
      const ms = new MatchState(s, pat)
      const e = ms.doMatch(pos, 0)
      if (e !== -1 && e !== lastMatch) {
        const start = pos
        // As in Lua 5.4: the next search starts at e, and lastMatch stops an empty match repeating.
        pos = lastMatch = e
        return ms.captures(start, e, true)
      }
    }
    return [undefined]
  }
}

export function gsub(
  s: string,
  pat: string,
  repl: (whole: string, captures: LuaValue[]) => string | undefined,
  max: number | undefined,
): [string, number] {
  const anchor = pat[0] === "^"
  const p0 = anchor ? 1 : 0
  let out = ""
  let pos = 0
  let count = 0
  let lastMatch = -1
  while (max === undefined || count < max) {
    const ms = new MatchState(s, pat)
    const e = ms.doMatch(pos, p0)
    if (e !== -1 && e !== lastMatch) {
      count++
      const whole = s.slice(pos, e)
      const replaced = repl(whole, ms.captures(pos, e, true))
      out += replaced ?? whole
      pos = lastMatch = e
    } else if (pos < s.length) out += s[pos++]
    else break
    if (anchor) break
  }
  return [out + s.slice(pos), count]
}
