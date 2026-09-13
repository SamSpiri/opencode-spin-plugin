#!/usr/bin/env node
/**
 * Install spin.js plugin + spin-lead, spin-ceo, spin-worker, spin-rnd and
 * spin-ops skills into opencode's default directories so they're auto-discovered
 * (no opencode.json plugin entry needed).
 *
 * Run via: npm run install:opencode
 *
 * ponytail: single installer, no bundler, no shell. Relies on opencode's
 * auto-discovery for ~/.config/opencode/plugins/*.js and skills/<name>/SKILL.md.
 */
import { mkdir, copyFile, writeFile, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { homedir } from "node:os"

const OC_DIR = join(homedir(), ".config/opencode")
const PLUGIN_DIR = join(OC_DIR, "plugins")
// Skill directories replaced by the spin-lead/spin-ceo rename, plus the older knr skill.
const LEGACY_SKILLS = ["knr", "spin", "ceo"]
async function installSkill(name) {
  const dir = join(OC_DIR, `skills/${name}`)
  await mkdir(dir, { recursive: true })
  const docs = await readFile(`skills/${name}/SKILL.md`, "utf8")
  await writeFile(join(dir, "SKILL.md"), docs)
  console.log(`skill   -> ${join(dir, "SKILL.md")}`)
}

async function main() {
  // 1. plugin -> auto-discovered by opencode at startup
  await mkdir(PLUGIN_DIR, { recursive: true })
  await copyFile("dist/index.js", join(PLUGIN_DIR, "spin.js"))
  console.log(`plugin  -> ${join(PLUGIN_DIR, "spin.js")}`)

  // 2. skills (frontmatter + docs body, single source of truth = docs file)
  for (const name of ["spin-lead", "spin-ceo", "spin-worker", "spin-rnd", "spin-ops"]) {
    await installSkill(name)
  }

  // 3. plugin deps into global package.json (opencode runs bun install at startup)
  const pkgPath = join(OC_DIR, "package.json")
  const pkg = JSON.parse(await readFile(pkgPath, "utf8"))
  pkg.dependencies = pkg.dependencies || {}
  let depsChanged = false
  for (const [dep, ver] of [["gray-matter", "^4.0.3"], ["@opencode-ai/sdk", "^0.15.18"]]) {
    if (!pkg.dependencies[dep]) {
      pkg.dependencies[dep] = ver
      depsChanged = true
    }
  }
  if (depsChanged) {
    await writeFile(pkgPath, JSON.stringify(pkg, null, 2) + "\n")
    console.log(`deps    -> added gray-matter + @opencode-ai/sdk to ${pkgPath}`)
  } else {
    console.log("deps    -> already present")
  }

  // 4. remove stale explicit plugin entry so the plugin isn't loaded twice
  //    (two instances = split in-memory state = broken worker dispatch)
  const cfgPath = join(OC_DIR, "opencode.json")
  const cfg = JSON.parse(await readFile(cfgPath, "utf8"))
  if (Array.isArray(cfg.plugin) && cfg.plugin.length) {
    const before = cfg.plugin.length
    cfg.plugin = cfg.plugin.filter((p) => {
      const s = typeof p === "string" ? p : JSON.stringify(p)
      return !/kanrisha|knr\.js/.test(s)
    })
    if (cfg.plugin.length === 0) delete cfg.plugin
    if ((cfg.plugin?.length ?? 0) !== before) {
      await writeFile(cfgPath, JSON.stringify(cfg, null, 2) + "\n")
      console.log(`config  -> removed stale plugin entry from ${cfgPath}`)
    } else {
      console.log("config  -> no matching plugin entry to remove")
    }
  } else {
    console.log("config  -> no plugin entry to remove")
  }

  // 5. delete stale plugin files + old skill dir so nothing loads twice
  //    (two instances = split in-memory state = broken worker dispatch)
  for (const stale of ["kanrisha.js", "knr.js"]) {
    try {
      await rm(join(PLUGIN_DIR, stale))
      console.log(`stale   -> removed ${join(PLUGIN_DIR, stale)}`)
    } catch (e) {
      if (e.code !== "ENOENT") throw e
    }
  }
  // Remove renamed legacy skills so old and new copies do not load side by side.
  for (const name of LEGACY_SKILLS) {
    try {
      await rm(join(OC_DIR, `skills/${name}`), { recursive: true, force: true })
      console.log(`stale   -> removed ${join(OC_DIR, `skills/${name}`)}`)
    } catch (e) {
      if (e.code !== "ENOENT") throw e
    }
  }

  console.log("\ndone. restart opencode to load plugin + skill from default dirs.")
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
