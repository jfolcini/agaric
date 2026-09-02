#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────
// Vault-isolation guard (#3334).
//
// The WebdriverIO lane (`wdio.conf.ts` + `e2e-tauri/**`) drives the REAL
// Agaric binary against a REAL SQLite vault. Before #3334 the app
// resolved that vault from the `com.agaric.app` bundle identifier alone,
// so a local run wrote into the developer's own notes and a repeat run
// could pass green against the previous run's leftovers.
//
// The fix has two halves, and this guard exists because BOTH are the
// kind of thing a well-meaning refactor deletes without noticing:
//
//   A. One seam. `src-tauri/src/app_paths.rs::resolve_app_data_dir` is
//      the only sanctioned caller of `app.path().app_data_dir()`. A
//      second, direct call site would keep writing to the real vault
//      while the rest of the process ran sandboxed — attachments and
//      logs in the user's home, rows describing them in a temp DB.
//
//   B. One sandbox. `wdio.conf.ts` must create a throwaway directory per
//      run, hand it to the spawned `tauri-driver` via an explicit `env`,
//      mark the run with `AGARIC_E2E_SANDBOX` (which makes the app REFUSE
//      to boot rather than fall back to the real vault), and then VERIFY
//      at runtime that the binary honoured it.
//
// A silent fallback is the specific failure mode being guarded against:
// isolation that degrades to "use the real vault" when its input goes
// missing is worse than no isolation, because it invites trust.
//
// Usage: node scripts/check-vault-isolation.mjs
// Exit:  0 = clean, 1 = at least one violation, 2 = repo layout failure.
// ─────────────────────────────────────────────────────────────────────

import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const RUST_DIR = path.join(ROOT, 'src-tauri', 'src')
const SEAM_FILE = 'src-tauri/src/app_paths.rs'
const WDIO_CONF = 'wdio.conf.ts'

// ─── A. the Rust seam ────────────────────────────────────────────────

/**
 * Strip `//` line comments and `/* *\/` block comments so a documented or
 * commented-out call is not a violation. Rust string literals are not
 * parsed: the pattern we look for is a method-call chain, which never
 * appears inside a literal in this codebase, and a false positive here
 * fails loudly rather than silently.
 *
 * LINE COUNT IS PRESERVED. Violations are located by counting newlines in
 * the STRIPPED source, so a block comment must be replaced by something of
 * the same height, not by a single space — otherwise every violation below
 * a multi-line comment is reported at a line it does not occupy, and the
 * developer goes looking at innocent code. A guard that names the wrong
 * line is the same species of unreliable report this whole change exists to
 * remove. Each non-newline character becomes a space; newlines survive.
 */
export function stripRustComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

/**
 * Find direct `…path().app_data_dir()` chains. Matched across newlines
 * because rustfmt splits the chain over three lines. Anchored on
 * `path()` so the materializer's own `app_data_dir()` accessor (a
 * different receiver, already fed from the seam) is not caught.
 */
const DIRECT_RESOLVE = /\bpath\s*\(\s*\)\s*\.\s*app_data_dir\s*\(\s*\)/g

export function findDirectResolves(relPath, source) {
  if (relPath === SEAM_FILE) return []
  const stripped = stripRustComments(source)
  const hits = []
  for (const match of stripped.matchAll(DIRECT_RESOLVE)) {
    const line = stripped.slice(0, match.index).split('\n').length
    hits.push({ file: relPath, line })
  }
  return hits
}

function walkRust(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walkRust(full, out)
    else if (entry.name.endsWith('.rs')) out.push(full)
  }
  return out
}

// ─── B. the wdio sandbox ─────────────────────────────────────────────

// Each requirement names what breaks if it disappears, because that is
// the only thing that makes a static guard worth reading when it fires.
export const WDIO_REQUIREMENTS = Object.freeze([
  {
    id: 'data-dir-override',
    pattern: /AGARIC_DATA_DIR/,
    why: 'the app-data override the app honours on every platform; without it the suite resolves the developer’s real vault',
  },
  {
    id: 'sandbox-flag',
    pattern: /AGARIC_E2E_SANDBOX/,
    why: 'the flag that turns a missing override into a hard boot failure instead of a silent fallback to the real vault',
  },
  {
    id: 'per-run-temp-dir',
    pattern: /mkdtempSync\s*\(/,
    why: 'a fresh directory per run; a reused one lets a previous run’s leftover block satisfy a durable-read assertion',
  },
  {
    id: 'sandbox-root-outside-home',
    pattern: /os\.tmpdir\s*\(\s*\)/,
    why: 'the sandbox root must live under the OS temp dir, never anywhere derived from the user’s home',
  },
  {
    id: 'env-reaches-the-app',
    pattern: /spawn\s*\(\s*tauriDriverPath[\s\S]{0,600}?\benv\s*:/,
    why: 'the spawned tauri-driver is the only process whose environment reaches the app; the sandbox must be passed to it explicitly',
  },
  {
    id: 'runtime-verification',
    pattern: /before\s*:\s*async[\s\S]{0,2000}?notes\.db/,
    why: 'a `before` hook must PROVE the running binary actually used the sandbox vault, and abort the run before any spec asserts if it did not',
  },
])

export function checkWdioConf(source) {
  return WDIO_REQUIREMENTS.filter((req) => !req.pattern.test(source))
}

// ─── driver ──────────────────────────────────────────────────────────

function run() {
  if (!fs.existsSync(path.join(ROOT, SEAM_FILE))) {
    console.error(`check-vault-isolation: missing seam module ${SEAM_FILE}`)
    console.error('The single app-data resolution seam (#3334) is gone. Restore it.')
    return 2
  }
  if (!fs.existsSync(RUST_DIR)) {
    console.error(`check-vault-isolation: missing ${RUST_DIR}`)
    return 2
  }

  let failed = false

  const violations = []
  for (const file of walkRust(RUST_DIR)) {
    const rel = path.relative(ROOT, file).split(path.sep).join('/')
    violations.push(...findDirectResolves(rel, fs.readFileSync(file, 'utf8')))
  }
  if (violations.length > 0) {
    failed = true
    console.error('check-vault-isolation: direct app-data resolution outside the seam\n')
    for (const v of violations) console.error(`  ${v.file}:${v.line}`)
    console.error(
      `\n\`app.path().app_data_dir()\` derives a FIXED path from the bundle identifier, so a call\n` +
        `site that uses it directly cannot be pointed anywhere else — it keeps writing into the\n` +
        `developer's real vault even when the rest of the process is sandboxed (#3334).\n\n` +
        `Call \`crate::app_paths::resolve_app_data_dir(&app)\` instead. It honours AGARIC_DATA_DIR\n` +
        `and refuses to fall back to the real vault under AGARIC_E2E_SANDBOX.\n`,
    )
  }

  const confPath = path.join(ROOT, WDIO_CONF)
  if (!fs.existsSync(confPath)) {
    console.error(`check-vault-isolation: missing ${WDIO_CONF}`)
    return 2
  }
  const missing = checkWdioConf(fs.readFileSync(confPath, 'utf8'))
  if (missing.length > 0) {
    failed = true
    console.error(`check-vault-isolation: ${WDIO_CONF} lost part of its vault isolation\n`)
    for (const req of missing) console.error(`  [${req.id}] ${req.why}`)
    console.error(
      `\nThe wdio specs create blocks, pages and tags through the real backend and never clean\n` +
        `up. Without every piece above, a local run writes into the developer's own notes and a\n` +
        `repeat run can pass green against the previous run's leftovers (#3334).\n`,
    )
  }

  if (!failed) console.log('check-vault-isolation: ok')
  return failed ? 1 : 0
}

process.exit(run())
