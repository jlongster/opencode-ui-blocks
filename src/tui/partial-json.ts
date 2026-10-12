/**
 * Reads a string field out of JSON that may still be streaming in, e.g. `{"title":"Sto` gives
 * "Sto". Finds the first `"key":` and decodes the string after it up to its closing quote or the end
 * of the text; a trailing half escape (`\` or `\u12`) is left off until the rest arrives.
 */
export function partialString(json: string, key: string): string | undefined {
  const match = new RegExp(`"${key}"\\s*:\\s*"`).exec(json)
  if (!match) return undefined
  let out = ""
  for (let i = match.index + match[0].length; i < json.length; i++) {
    const c = json[i]
    if (c === '"') return out
    if (c !== "\\") {
      out += c
      continue
    }
    const e = json[i + 1]
    if (e === undefined) return out
    if (e === "u") {
      const hex = json.slice(i + 2, i + 6)
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) return out
      out += String.fromCharCode(parseInt(hex, 16))
      i += 5
      continue
    }
    out += ESCAPES[e] ?? e
    i++
  }
  return out
}

const ESCAPES: Record<string, string> = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", '"': '"', "\\": "\\", "/": "/" }
