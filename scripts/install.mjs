#!/usr/bin/env node
/**
 * Install spin.js plugin + spin-lead skill into opencode's default
 * directories so they're auto-discovered (no opencode.json plugin entry needed).
 *
 * Run via: npm run install:opencode
 *
 * ponytail: single installer, no bundler, no shell. Relies on opencode's
 * auto-discovery for ~/.config/opencode/plugins/*.js and skills/<name>/SKILL.md.
 */
import { mkdir, copyFile, writeFile, readFile, rm, cp } from "node:fs/promises"
import { join } from "node:path"
import { homedir } from "node:os"

const OC_DIR = join(homedir(), ".config/opencode")
const PLUGIN_DIR = join(OC_DIR, "plugins")
// Deleted spin skills plus older renames; must not load side by side with spin-lead.
const STALE_SKILLS = [
  "spin-head",
  "spin-worker",
  "spin-rnd",
  "spin-ops",
  "knr",
  "spin",
  "ceo",
  "spin-ceo",
]

async function main() {
  // 1. plugin -> auto-discovered by opencode at startup
  await mkdir(PLUGIN_DIR, { recursive: true })
  await copyFile("dist/index.js", join(PLUGIN_DIR, "spin.js"))
  console.log(`plugin  -> ${join(PLUGIN_DIR, "spin.js")}`)

  // 2. lead skill only (single source of truth = repo file)
  const leadDir = join(OC_DIR, "skills/spin-lead")
  await mkdir(leadDir, { recursive: true })
  await copyFile("skills/spin-lead/SKILL.md", join(leadDir, "SKILL.md"))
  console.log(`skill   -> ${join(leadDir, "SKILL.md")}`)

  // 3. plugin deps into global package.json (opencode runs bun install at startup)
  const pkgPath = join(OC_DIR, "package.json")
  const pkg = JSON.parse(await readFile(pkgPath, "utf8"))
  pkg.dependencies = pkg.dependencies || {}
  let depsChanged = false
  for (const [dep, ver] of [
    ["gray-matter", "^4.0.3"],
    ["@opencode/plugin", "^2.0.19"],
  ]) {
    if (!pkg.dependencies[dep]) {
      pkg.dependencies[dep] = ver
      depsChanged = true
    }
  }
  if (depsChanged) {
    await writeFile(pkgPath, JSON.stringify(pkg, null, 2) + "\n")
    console.log(`deps    -> updated ${pkgPath}`)
  } else {
    console.log("deps    -> already present")
  }

  // 4. point config at the spin.js file: drop the stale directory-copy entry
  //    so the plugin isn't loaded twice (two instances = split in-memory
  //    state = broken worker dispatch)
  const cfgPath = join(OC_DIR, "opencode.json")
  const cfg = JSON.parse(await readFile(cfgPath, "utf8"))
  if (Array.isArray(cfg.plugins) && cfg.plugins.length) {
    const before = cfg.plugins.length
    cfg.plugins = cfg.plugins.filter((p) => {
      const s = typeof p === "string" ? p : JSON.stringify(p)
      return !/opencode-spin-v2/.test(s)
    })
    if (cfg.plugins.length !== before) {
      await cp(cfgPath, `${cfgPath}.bak.install`)
      await writeFile(cfgPath, JSON.stringify(cfg, null, 2) + "\n")
      console.log(`config  -> removed opencode-spin-v2 entry (backup: ${cfgPath}.bak.install)`)
    } else {
      console.log("config  -> no opencode-spin-v2 entry to remove")
    }
  } else {
    console.log("config  -> no plugins entry to clean")
  }

  // 5. delete stale plugin files + deleted skill dirs so nothing loads twice
  for (const stale of ["kanrisha.js", "knr.js"]) {
    try {
      await rm(join(PLUGIN_DIR, stale))
      console.log(`stale   -> removed ${join(PLUGIN_DIR, stale)}`)
    } catch (e) {
      if (e.code !== "ENOENT") throw e
    }
  }
  for (const name of STALE_SKILLS) {
    try {
      await rm(join(OC_DIR, `skills/${name}`), { recursive: true, force: true })
      console.log(`stale   -> removed ${join(OC_DIR, `skills/${name}`)}`)
    } catch (e) {
      if (e.code !== "ENOENT") throw e
    }
  }

  console.log("\ndone. restart opencode to load plugin + skill from default dirs.")
}

async function dropDirectoryCopy() {
  // The V2 directory-copy install is superseded by spin.js above; keeping it
  // referenced or not, the dir rots behind the repo. Preserve any .tmp state,
  // then remove it so exactly one plugin instance can load.
  const dir = join(PLUGIN_DIR, "opencode-spin-v2")
  try {
    await cp(join(dir, ".tmp"), "/tmp/opencode/opencode-spin-v2-tmp", {
      recursive: true,
    })
    console.log("backup  -> .tmp state to /tmp/opencode/opencode-spin-v2-tmp")
  } catch (e) {
    if (e.code !== "ENOENT") throw e
  }
  try {
    await rm(dir, { recursive: true, force: true })
    console.log(`dropped -> ${dir}`)
  } catch (e) {
    if (e.code !== "ENOENT") throw e
  }
}

main()
  .then(dropDirectoryCopy)
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
