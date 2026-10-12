/**
 * Links the host packages from an OpenCode checkout into .dev/node_modules (mapped in tsconfig), so
 * types and tests use the same @opentui/core and @opencode/plugin as the TUI that loads it. They are
 * kept out of node_modules: a plugin-local copy of @opentui/core would shadow the host's at runtime.
 *
 *   OPENCODE_REPO=/path/to/opencode bun script/dev-link.ts
 */
import { lstat, mkdir, rm, symlink } from "node:fs/promises"
import { realpathSync } from "node:fs"
import path from "node:path"

const repo = process.env.OPENCODE_REPO ?? "/root/projects/opencode-tui-genui"
const tui = path.join(repo, "packages/tui/node_modules")
const links = {
  "@opencode/plugin": path.join(repo, "packages/plugin"),
  "@opentui/core": path.join(tui, "@opentui/core"),
  "@opentui/solid": path.join(tui, "@opentui/solid"),
  "solid-js": path.join(tui, "solid-js"),
  "@types/bun": path.join(tui, "@types/bun"),
  "@typescript/native-preview": path.join(repo, "node_modules/@typescript/native-preview"),
}

for (const [name, target] of Object.entries(links)) {
  const at = path.join(import.meta.dir, "..", ".dev", "node_modules", name)
  await mkdir(path.dirname(at), { recursive: true })
  if (await lstat(at).catch(() => undefined)) await rm(at, { recursive: true, force: true })
  await symlink(realpathSync(target), at)
  console.log(`${name} -> ${realpathSync(target)}`)
}
