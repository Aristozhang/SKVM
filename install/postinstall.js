#!/usr/bin/env node
// npm postinstall hook: download the matching skvm binary from GitHub Releases.
//
// Runs in two contexts and must not break either:
//   1. Real install (`npm i -g @ipads-skvm/skvm`): download binary into bin/
//   2. Dev repo (`bun install` or `npm install` at the source tree): no-op
//
// Detection: dev repo has src/index.ts next to package.json; installed package does not.
//
// Opt out: SKVM_SKIP_POSTINSTALL=1 or SKVM_SKIP_OPENCODE=1 (the latter skips only
// the bundled opencode step, not the skvm binary — but this is the entry point for
// both, so both env vars gate this script).
//
// Windows is now supported — skips opencode bundling by default,
// using the system-installed opencode on PATH instead.

import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { createWriteStream, existsSync, mkdirSync, readFileSync, chmodSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import https from "node:https"
import os from "node:os"

const here = path.dirname(fileURLToPath(import.meta.url))
const pkgRoot = path.resolve(here, "..")

// ---------------- dev-repo guard ----------------
if (existsSync(path.join(pkgRoot, "src", "index.ts"))) {
  console.log("skvm postinstall: dev repo detected (src/index.ts present), skipping binary download")
  process.exit(0)
}

// ---------------- opt-out ----------------
if (process.env.SKVM_SKIP_POSTINSTALL === "1") {
  console.log("skvm postinstall: SKVM_SKIP_POSTINSTALL=1, skipping")
  process.exit(0)
}

// ---------------- platform detection ----------------
const TARGETS = {
  "darwin-arm64": "darwin-arm64",
  "darwin-x64": "darwin-x64",
  "linux-x64": "linux-x64",
  "linux-arm64": "linux-arm64",
  "win32-x64": "windows-x64",
}

const platform = process.platform
const arch = process.arch === "x64" ? "x64" : process.arch === "arm64" ? "arm64" : process.arch
const targetKey = `${platform}-${arch}`
const target = TARGETS[targetKey]

if (!target) {
  console.error(
    `skvm postinstall: unsupported platform ${targetKey}. ` +
      `Supported: ${Object.keys(TARGETS).join(", ")}. ` +
      `If you want to run skvm here, install from source: https://github.com/SJTU-IPADS/SkVM`,
  )
  process.exit(1)
}

// ---------------- release host + version ----------------
const host = JSON.parse(readFileSync(path.join(pkgRoot, "install", "release-host.json"), "utf8"))
const pkg = JSON.parse(readFileSync(path.join(pkgRoot, "package.json"), "utf8"))
const version = pkg.version
const owner = host.owner
const repo = host.repo

// ---------------- download sources (auto-fallback) ----------------
// Tried in order. On any network error / timeout / stall, we silently roll
// over to the next source — no env var or user action required. This is how
// mainland-China users get the install to succeed when github.com is flaky.
//
// Optional override (advanced): SKVM_DOWNLOAD_BASE=github|mirror|<custom-url>
const sources = resolveSources(host)

function resolveSources(host) {
  const override = process.env.SKVM_DOWNLOAD_BASE
  if (!override) return host.sources
  if (override === "github") return host.sources.filter((s) => s.name === "github")
  if (override === "mirror" || override === "cn")
    return host.sources.filter((s) => s.name !== "github")
  if (/^https?:\/\//.test(override)) {
    const base = override.replace(/\/+$/, "")
    return [{ name: "custom", releases: `${base}/gh`, api: `${base}/gh-api` }]
  }
  return host.sources
}

// ---------------- download ----------------
const binDir = path.join(pkgRoot, "bin")
mkdirSync(binDir, { recursive: true })
const tmpDir = path.join(os.tmpdir(), `skvm-postinstall-${process.pid}`)
mkdirSync(tmpDir, { recursive: true })

const tarballName = `skvm-v${version}-${target}.tar.gz`
const tarballRel = `/${owner}/${repo}/releases/download/v${version}/${tarballName}`
const isZip = tarballName.endsWith(".zip")
const tmpTarball = path.join(tmpDir, tarballName)
const isWin = process.platform === "win32"

// Timeouts (important for CN ↔ GitHub): short connect so we fall back fast,
// longer idle so slow but working mirrors still complete.
const CONNECT_TIMEOUT_MS = 8_000
const IDLE_TIMEOUT_MS = 30_000

function fetchToFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { headers: { "user-agent": "skvm-postinstall" }, timeout: CONNECT_TIMEOUT_MS },
      (res) => {
        req.setTimeout(0)
        if (res.statusCode === 301 || res.statusCode === 302) {
          res.resume()
          resolve(fetchToFile(res.headers.location, destPath))
          return
        }
        if (res.statusCode !== 200) {
          res.resume()
          reject(new Error(`GET ${url} → ${res.statusCode}`))
          return
        }
        res.setTimeout(IDLE_TIMEOUT_MS, () => {
          req.destroy(new Error(`idle timeout: ${url}`))
        })
        const file = createWriteStream(destPath)
        res.pipe(file)
        file.on("finish", () => file.close(() => resolve()))
        file.on("error", reject)
      },
    )
    req.on("timeout", () => {
      req.destroy(new Error(`connect timeout (${CONNECT_TIMEOUT_MS}ms): ${url}`))
    })
    req.on("error", reject)
  })
}

function fetchText(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { headers: { "user-agent": "skvm-postinstall" }, timeout: CONNECT_TIMEOUT_MS },
      (res) => {
        req.setTimeout(0)
        if (res.statusCode === 301 || res.statusCode === 302) {
          res.resume()
          resolve(fetchText(res.headers.location))
          return
        }
        if (res.statusCode !== 200) {
          res.resume()
          reject(new Error(`GET ${url} → ${res.statusCode}`))
          return
        }
        res.setTimeout(IDLE_TIMEOUT_MS, () => {
          req.destroy(new Error(`idle timeout: ${url}`))
        })
        let body = ""
        res.on("data", (chunk) => (body += chunk))
        res.on("end", () => resolve(body))
      },
    )
    req.on("timeout", () => {
      req.destroy(new Error(`connect timeout (${CONNECT_TIMEOUT_MS}ms): ${url}`))
    })
    req.on("error", reject)
  })
}

// Walk the sources list; first success wins. `kind` is "releases" or "api".
// `relPath` must start with "/". When `destPath` is provided, body is streamed
// there; otherwise the text body is returned.
async function fetchWithFallback(kind, relPath, destPath = null) {
  let lastErr
  for (const src of sources) {
    const base = src[kind]
    if (!base) continue
    const url = base + relPath
    try {
      console.log(`skvm postinstall: fetching ${url}`)
      if (destPath) {
        await fetchToFile(url, destPath)
        return
      }
      return await fetchText(url)
    } catch (err) {
      lastErr = err
      console.warn(`  [${src.name}] ${err.message}; trying next source…`)
    }
  }
  throw lastErr || new Error(`all sources failed for ${relPath}`)
}

console.log(`skvm postinstall: downloading ${tarballName}…`)
try {
  await fetchWithFallback("releases", tarballRel, tmpTarball)

  let expectedSum = null
  try {
    const sumBody = await fetchWithFallback("releases", `${tarballRel}.sha256`)
    expectedSum = sumBody.trim().split(/\s+/)[0] || null
  } catch (err) {
    console.warn(`skvm postinstall: no checksum available (${err.message}); skipping verification`)
  }
  const actualSum = createHash("sha256").update(readFileSync(tmpTarball)).digest("hex")
  if (expectedSum && expectedSum !== actualSum) {
    throw new Error(`sha256 mismatch: expected ${expectedSum}, got ${actualSum}`)
  }

  // Extract the archive. On Windows, if tar is not available, fall back to
  // expanding .zip via PowerShell (Expand-Archive is built-in since Win10).
  let extractRes
  if (isZip) {
    extractRes = spawnSync("powershell", [
      "-NoProfile", "-Command",
      `Expand-Archive -Path "${tmpTarball}" -DestinationPath "${pkgRoot}" -Force`,
    ], { stdio: "inherit" })
    if (extractRes.status !== 0) {
      // Fallback: try tar (some Windows systems have it)
      extractRes = spawnSync("tar", ["-xzf", tmpTarball, "-C", pkgRoot], { stdio: "inherit" })
    }
  } else {
    extractRes = spawnSync("tar", ["-xzf", tmpTarball, "-C", pkgRoot], { stdio: "inherit" })
  }
  if (extractRes.status !== 0) throw new Error(`extraction failed (exit ${extractRes.status})`)

  const binaryPath = path.join(binDir, isWin ? "skvm.exe" : "skvm")
  if (!existsSync(binaryPath)) {
    throw new Error(`binary not found at ${binaryPath} after extraction`)
  }
  if (!isWin) chmodSync(binaryPath, 0o755)

  console.log(`skvm postinstall: installed skvm v${version} for ${target}`)
} catch (err) {
  console.error(`skvm postinstall: ${err.message}`)
  const hosts = sources.map((s) => s.name).join(", ")
  console.error(
    `All download sources failed (${hosts}). If you are behind a proxy or air-gapped, ` +
      `re-run with SKVM_SKIP_POSTINSTALL=1 and install the binary manually from ` +
      `https://github.com/${owner}/${repo}/releases`,
  )
  process.exit(1)
}

// -------- opencode bundling (plan §1.8) --------
// Keep this in sync with install/install.sh — same version, same URL pattern.
// On Windows, skip by default — users should install opencode globally and
// rely on the system-PATH resolution in src/adapters/opencode.ts.
const skipOpencode = isWin || process.env.SKVM_SKIP_OPENCODE === "1"
if (!skipOpencode) {
  try {
    await installOpencode()
  } catch (err) {
    console.warn(
      `skvm postinstall: opencode bundling failed (${err.message}); ` +
        `jit-optimize will require a global opencode or adapters.opencode config`,
    )
  }
}

async function installOpencode() {
  const oc = JSON.parse(readFileSync(path.join(pkgRoot, "install", "opencode-version.json"), "utf8"))
  const ocVersion = oc.version
  const ocTag = ocVersion.startsWith("v") ? ocVersion : `v${ocVersion}`
  const ocOwner = oc.owner || "anomalyco"
  const ocRepo = oc.repo || "opencode"
  const assetDef = oc.assets?.[target]
  if (!assetDef) {
    throw new Error(`no bundled opencode asset defined for target ${target}`)
  }
  const ocAssetName = assetDef.name
  const ocFormat = assetDef.format
  const ocRel = `/${ocOwner}/${ocRepo}/releases/download/${ocTag}/${ocAssetName}`
  const vendorRoot = path.join(pkgRoot, "vendor", "opencode")
  const versionDir = path.join(vendorRoot, ocTag)
  const profileRoot = path.join(vendorRoot, "profile")
  const binPath = path.join(versionDir, "bin", "opencode")

  const { mkdtempSync, readdirSync, renameSync, rmSync, symlinkSync, unlinkSync, lstatSync } =
    await import("node:fs")

  if (existsSync(binPath)) {
    console.log(`skvm postinstall: bundled opencode ${ocTag} already present`)
  } else {
    console.log(`skvm postinstall: downloading bundled opencode ${ocTag}`)
    mkdirSync(versionDir, { recursive: true })
    const ocTmp = path.join(tmpDir, ocAssetName)
    await fetchWithFallback("releases", ocRel, ocTmp)

    const expected = oc.sha256?.[target]
    if (expected) {
      const actual = createHash("sha256").update(readFileSync(ocTmp)).digest("hex")
      if (expected !== actual) {
        throw new Error(`opencode sha256 mismatch: expected ${expected}, got ${actual}`)
      }
    }

    // Extract to a staging dir, then relocate the flat `opencode` binary into
    // bin/opencode. Mirrors install.sh's fallback (Codex review P3) so both
    // paths accept the same upstream tarball layouts.
    const stage = mkdtempSync(path.join(tmpDir, "opencode-extract-"))
    let extractRes
    if (ocFormat === "zip") {
      extractRes = spawnSync("unzip", ["-q", ocTmp, "-d", stage], { stdio: "inherit" })
    } else if (ocFormat === "tar.gz") {
      extractRes = spawnSync("tar", ["-xzf", ocTmp, "-C", stage], { stdio: "inherit" })
    } else {
      throw new Error(`unknown opencode archive format: ${ocFormat}`)
    }
    if (extractRes.status !== 0) {
      // Fallback for zip on Windows without unzip: try tar (supports zip too)
      if (isWin && ocFormat === "zip") {
        extractRes = spawnSync("tar", ["-xf", ocTmp, "-C", stage], { stdio: "inherit" })
      }
    }
    if (extractRes.status !== 0) {
      throw new Error(`opencode extraction failed (exit ${extractRes.status})`)
    }

    // Locate the extracted `opencode` binary: prefer <stage>/opencode, else
    // search recursively. On Windows the binary is `opencode.exe`.
    const ocBinaryName = isWin ? "opencode.exe" : "opencode"
    const candidate = path.join(stage, ocBinaryName)
    let found = existsSync(candidate) ? candidate : null
    if (!found) {
      const walk = (dir) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const p = path.join(dir, entry.name)
          if (entry.isDirectory()) {
            const hit = walk(p)
            if (hit) return hit
          } else if (entry.isFile() && (entry.name === "opencode" || entry.name === "opencode.exe")) {
            return p
          }
        }
        return null
      }
      found = walk(stage)
    }
    if (!found) {
      throw new Error("opencode binary not found in extracted archive")
    }

    mkdirSync(path.join(versionDir, "bin"), { recursive: true })
    renameSync(found, binPath)
    if (!isWin) chmodSync(binPath, 0o755)
    rmSync(stage, { recursive: true, force: true })
  }

  // Update the "current" symlink used by src/adapters/opencode.ts resolver.
  // On Windows, use a junction or just skip (opencode bundling is optional).
  const currentLink = path.join(vendorRoot, "current")
  try { if (lstatSync(currentLink)) unlinkSync(currentLink) } catch {}
  if (!isWin) {
    symlinkSync(ocTag, currentLink, "dir")
  }

  // Create isolated profile dirs (preserve contents on upgrades)
  for (const sub of ["config", "data", "state", "cache", "plugins", "skills"]) {
    mkdirSync(path.join(profileRoot, sub), { recursive: true })
  }

  console.log(`skvm postinstall: bundled opencode ready at ${binPath}`)
  console.log(`  Profile root (isolated from global opencode): ${profileRoot}`)
}
