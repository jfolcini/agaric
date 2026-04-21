#!/usr/bin/env node
// Prepare external binaries for Tauri's bundler.
//
// Tauri's `bundle.externalBin` entries require platform-specific files named
// `<path>-<target-triple>{.ext}` to exist at *every* cargo build time — the
// Tauri build-script (tauri-build's `build.rs`) validates the path on every
// `cargo build` over this package, including `cargo clippy`, `cargo test`,
// and `cargo build --bin agaric-mcp` itself. That creates a chicken-and-egg
// problem: we cannot build the stub binary without the stub binary already
// being present at the externalBin location.
//
// The workaround (documented in Tauri's sidecar guide) is to create an
// empty *placeholder* at the expected path first, run the cargo build, and
// then overwrite the placeholder with the real compiled binary.
//
// Modes:
//
//   node scripts/prepare-external-bins.mjs --placeholder-only
//     Create an empty file at binaries/agaric-mcp-<triple>{.ext} and exit.
//     Cheap. Use before steps that invoke cargo (clippy, test, deny,
//     machete) so tauri-build's validation passes without actually
//     compiling the stub.
//
//   node scripts/prepare-external-bins.mjs
//     Build the release binary (if not already built) and overwrite the
//     placeholder with it. Use as Tauri's `beforeBuildCommand` so the real
//     binary is in place by the time the bundler packages the app, and as
//     a CI smoke check that the stub still compiles on every run.

import { execSync, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SRC_TAURI = join(REPO_ROOT, 'src-tauri')
const BINARIES_DIR = join(SRC_TAURI, 'binaries')

function detectTargetTriple() {
  if (process.env.TAURI_TARGET_TRIPLE) return process.env.TAURI_TARGET_TRIPLE
  if (process.env.CARGO_BUILD_TARGET) return process.env.CARGO_BUILD_TARGET
  const out = execSync('rustc -vV', { encoding: 'utf8' })
  const line = out.split('\n').find((l) => l.startsWith('host:'))
  if (!line) throw new Error(`prepare-external-bins: could not parse rustc host from:\n${out}`)
  return line.split(':')[1].trim()
}

function buildMcp() {
  const result = spawnSync('cargo', ['build', '--bin', 'agaric-mcp', '--release', '--locked'], {
    cwd: SRC_TAURI,
    stdio: 'inherit',
  })
  if (result.status !== 0) {
    throw new Error(
      `prepare-external-bins: cargo build --bin agaric-mcp failed (exit ${result.status})`,
    )
  }
}

function ensurePlaceholder(dstBinary) {
  mkdirSync(BINARIES_DIR, { recursive: true })
  if (!existsSync(dstBinary)) {
    writeFileSync(dstBinary, Buffer.alloc(0))
    console.log(`prepare-external-bins: created placeholder ${dstBinary}`)
  }
}

function main() {
  const placeholderOnly = process.argv.includes('--placeholder-only')

  const triple = detectTargetTriple()
  const isWin = triple.includes('windows')
  const ext = isWin ? '.exe' : ''

  const srcBinary = join(SRC_TAURI, 'target', 'release', `agaric-mcp${ext}`)
  const dstBinary = join(BINARIES_DIR, `agaric-mcp-${triple}${ext}`)

  // Always make sure a file exists at the externalBin path. Without this,
  // tauri-build's `build.rs` fails any invocation of cargo (clippy, test,
  // build) with "resource path ... doesn't exist".
  ensurePlaceholder(dstBinary)

  if (placeholderOnly) {
    console.log('prepare-external-bins: --placeholder-only, skipping build + copy')
    return
  }

  // Build agaric-mcp for release (the placeholder makes this pass). Cargo's
  // own incremental cache short-circuits when nothing has changed.
  buildMcp()

  if (!existsSync(srcBinary)) {
    throw new Error(`prepare-external-bins: expected ${srcBinary} after build, but it is missing`)
  }

  // Overwrite the placeholder with the freshly-built binary. When Tauri
  // bundles the app later, the externalBin path now points at the real
  // executable.
  copyFileSync(srcBinary, dstBinary)

  const size = statSync(dstBinary).size
  console.log(`prepare-external-bins: installed agaric-mcp (${size} bytes) → ${dstBinary}`)
}

try {
  main()
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
}
