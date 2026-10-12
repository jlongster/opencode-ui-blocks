import { homedir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const MAX_BYTES = 16 * 1024 * 1024
const TIMEOUT_MS = 15_000
const MAX_CACHED = 32
const cache = new Map<string, Promise<Uint8Array>>()

/**
 * Loads an image named by a widget: an http(s) URL, a file:// URL, or a path relative to
 * `directory`. Results are cached because markdown rebuilds a block on every streamed delta and
 * when it scrolls back into view; failures are not, so a fixed file or network can be retried.
 */
export function loadImage(src: string, directory: string) {
  const key = /^https?:/i.test(src) ? src : resolvePath(src, directory)
  const cached = cache.get(key)
  if (cached) {
    cache.delete(key)
    cache.set(key, cached)
    return cached
  }
  const loading = (/^https?:/i.test(src) ? download(key) : readFile(key)).catch((error) => {
    cache.delete(key)
    throw error
  })
  cache.set(key, loading)
  if (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value!)
  return loading
}

function resolvePath(src: string, directory: string) {
  if (/^file:/i.test(src)) return fileURLToPath(src)
  if (src === "~" || src.startsWith("~/")) return path.join(homedir(), src.slice(1))
  return path.resolve(directory, src)
}

async function readFile(file: string) {
  const handle = Bun.file(file)
  if (!(await handle.exists())) throw new Error(`file not found: ${file}`)
  if (handle.size > MAX_BYTES) throw new Error(`file is larger than ${MAX_BYTES / 1024 / 1024} MB`)
  return handle.bytes()
}

async function download(url: string) {
  const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  if (Number(response.headers.get("content-length")) > MAX_BYTES)
    throw new Error(`image is larger than ${MAX_BYTES / 1024 / 1024} MB`)
  const chunks: Uint8Array[] = []
  let size = 0
  // Content-Length can be missing or wrong, so enforce the limit while reading.
  for await (const chunk of response.body ?? []) {
    size += chunk.byteLength
    if (size > MAX_BYTES) throw new Error(`image is larger than ${MAX_BYTES / 1024 / 1024} MB`)
    chunks.push(chunk)
  }
  return Bun.concatArrayBuffers(chunks, Infinity, true)
}
