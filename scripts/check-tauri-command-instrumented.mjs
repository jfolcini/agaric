#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────
// Tauri command tracing-span coverage check (#2110, M2).
//
// Every `#[tauri::command]` must be covered by a `tracing` span so the
// OpenTelemetry trace pipeline (issue #2110) sees every IPC entry point.
// The codebase convention is to put `#[tracing::instrument(skip(<non-PII
// args>), err)]` on the logic function and let the thin `#[tauri::command]`
// wrapper delegate to it (instrumenting the wrapper directly does not
// compose cleanly with the command + specta macro stack). This guard makes
// the convention exhaustive: a new command cannot ship without a span.
//
// ─── Scope ──────────────────────────────────────────────────────────
//
// Walks every `*.rs` file under `src-tauri/src/commands/`. For each file it
// (1) collects the names of every function that carries an `#[instrument]`
// attribute, then (2) checks each `#[tauri::command]` function against the
// coverage rule below.
//
// ─── Coverage rule ──────────────────────────────────────────────────
//
// A `#[tauri::command]` fn is COVERED iff either:
//   1. DIRECT   — the command fn itself carries `#[instrument]`; or
//   2. DELEGATED — its body calls an in-file function that carries
//      `#[instrument]` (the `*_inner` / logic-fn convention). The target is
//      resolved by NAME against the file's instrumented-fn set, NOT by a
//      `_inner` suffix — several real delegates are named differently
//      (`create_block` → `create_block_inner_with_space`, `get_block` →
//      `get_active_block_inner`, `list_page_links` → `list_page_links_inner_split`).
//
// Anything else is flagged. A command that delegates to a helper in ANOTHER
// module (which this in-file check cannot resolve) or is a trivial span-free
// getter must be listed in `ALLOWLIST` with a reason.
//
// ─── Output ─────────────────────────────────────────────────────────
//
// Prints offenders to stderr in `path:line: name` form and exits 1.
// On a clean run prints nothing and exits 0.
//
// ─── Usage ──────────────────────────────────────────────────────────
//
//   node scripts/check-tauri-command-instrumented.mjs
//   node scripts/check-tauri-command-instrumented.mjs --self-test
//
// Wired into `prek.toml` as a `local` repo hook, types = ["rust"]; a second
// hook runs `--self-test` whenever this script changes so the guard's own
// detection logic can't silently regress.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const HERE = import.meta.dirname
const REPO_ROOT = join(HERE, '..')
const COMMANDS_DIR = join(REPO_ROOT, 'src-tauri', 'src', 'commands')

/**
 * Commands that are intentionally span-free or whose span lives in a helper
 * this in-file check cannot resolve. Keyed `filename:command_name`.
 *
 * Each entry MUST carry a reason. Two legitimate categories:
 *   - Trivial synchronous getters / fire-and-forget signals that do no
 *     meaningful fallible work (a span would be pure noise).
 *   - Commands whose logic lives in a cross-module helper that IS
 *     `#[instrument]`-ed but lives outside `commands/`, so the in-file
 *     resolver can't see it.
 */
const ALLOWLIST = new Map([
  // ── Trivial sync getters / fire-and-forget signals ──
  ['logging.rs:get_log_dir', 'returns a path; no fallible work worth a span'],
  ['mcp.rs:get_mcp_socket_path', 'pure socket-path builder'],
  ['mcp.rs:get_mcp_rw_socket_path', 'pure socket-path builder'],
  ['mcp.rs:get_mcp_recent_activity', 'reads an in-memory ring buffer'],
  ['mcp.rs:mcp_disconnect_all', 'fire-and-forget disconnect signal, returns Ok(())'],
  ['mcp.rs:mcp_rw_disconnect_all', 'fire-and-forget disconnect signal, returns Ok(())'],
  ['recovery.rs:get_recovery_status', 'clones a lock-guarded boot-status value'],

  // ── Instrumented via a cross-module helper the in-file resolver can't see ──
  [
    'advanced_query.rs:run_advanced_query',
    'span on query::engine::compile_and_run (query/engine.rs)',
  ],
  ['drafts.rs:save_draft', 'span on draft::save_draft (draft.rs)'],
  ['drafts.rs:delete_draft', 'span on draft::delete_draft (draft.rs)'],
  ['drafts.rs:list_drafts', 'span on draft::get_all_drafts (draft.rs)'],
])

/** Recursively yield every `*.rs` path under `dir`. */
function* walkRustFiles(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) {
      yield* walkRustFiles(full)
    } else if (st.isFile() && full.endsWith('.rs')) {
      yield full
    }
  }
}

/**
 * Locate the byte offset of the matching `}` for the `{` at `openIdx`,
 * skipping braces inside string / char / raw-string literals and `//` line /
 * nested `/* … *\/` block comments. Returns `null` if unmatched.
 *
 * (Identical scanner to `check-tauri-command-sanitize.mjs` — a `{`/`}` inside
 * a `format!("…{…}…")` string or a comment must not throw off the balance.)
 */
function findMatchingBrace(src, openIdx) {
  let depth = 0
  let i = openIdx
  while (i < src.length) {
    const c = src[i]
    const next = src[i + 1]

    if (c === '/' && next === '/') {
      const nl = src.indexOf('\n', i + 2)
      if (nl === -1) return null
      i = nl + 1
      continue
    }

    if (c === '/' && next === '*') {
      let commentDepth = 1
      i += 2
      while (i < src.length && commentDepth > 0) {
        if (src[i] === '/' && src[i + 1] === '*') {
          commentDepth++
          i += 2
        } else if (src[i] === '*' && src[i + 1] === '/') {
          commentDepth--
          i += 2
        } else {
          i++
        }
      }
      continue
    }

    if (c === 'r' && (next === '"' || next === '#')) {
      let j = i + 1
      let hashes = 0
      while (src[j] === '#') {
        hashes++
        j++
      }
      if (src[j] === '"') {
        const close = `"${'#'.repeat(hashes)}`
        const end = src.indexOf(close, j + 1)
        if (end === -1) return null
        i = end + close.length
        continue
      }
    }

    if (c === '"') {
      i++
      while (i < src.length) {
        if (src[i] === '\\') {
          i += 2
          continue
        }
        if (src[i] === '"') {
          i++
          break
        }
        i++
      }
      continue
    }

    if (c === "'") {
      if (src[i + 1] === '\\') {
        const end = src.indexOf("'", i + 2)
        if (end !== -1 && end - i <= 12) {
          i = end + 1
          continue
        }
      } else if (src[i + 2] === "'") {
        i += 3
        continue
      }
    }

    if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) return i
    }
    i++
  }
  return null
}

/**
 * Names of every function in `src` that carries an `#[instrument]` (or
 * `#[tracing::instrument]`) attribute.
 *
 * Anchors on `#[instrument` at the START of a line (after indentation) so a
 * mention inside a `///` doc comment or a string literal is ignored, then
 * binds it to the next `fn <name>` — attributes always precede their fn, so
 * the first `fn` token after the attribute is the instrumented function.
 */
function instrumentedFnNames(src) {
  const names = new Set()
  const re = /^[ \t]*#\[(?:tracing::)?instrument\b/gm
  let m
  while ((m = re.exec(src)) !== null) {
    const fnMatch = /\bfn\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(src.slice(m.index))
    if (fnMatch) names.add(fnMatch[1])
  }
  return names
}

/**
 * Yield every `#[tauri::command]` function in `src` as
 * `{ name, body, lineno }` (signature is irrelevant to this check).
 */
function* iterCommandFns(src) {
  const re =
    /#\[tauri::command\][^\n]*\n(?:\s*#\[[^\]]*\][^\n]*\n)*\s*pub\s+(?:async\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:<[^>]*>)?\s*\(([\s\S]*?)\)\s*->\s*([^{]+?)\s*\{/g
  let m = re.exec(src)
  while (m !== null) {
    const [matched, name] = m
    const openIdx = m.index + matched.length - 1
    const closeIdx = findMatchingBrace(src, openIdx)
    if (closeIdx !== null) {
      const body = src.slice(openIdx + 1, closeIdx)
      const lineno = src.slice(0, m.index).split('\n').length
      yield { name, body, lineno }
    }
    m = re.exec(src)
  }
}

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Analyze one source file. Returns the list of uncovered command names as
 * `{ name, lineno }`. `allowlist` is a `Set` of `name` strings exempt for
 * THIS file (already filtered by filename by the caller / self-test).
 */
function uncoveredCommands(src, allowlist) {
  const instrumented = instrumentedFnNames(src)
  const offenders = []
  for (const { name, body, lineno } of iterCommandFns(src)) {
    // 1. DIRECT — the command fn itself is instrumented (its name was bound
    //    to an `#[instrument]` attribute).
    if (instrumented.has(name)) continue
    // 2. DELEGATED — the body calls an in-file instrumented fn.
    let delegated = false
    for (const fn of instrumented) {
      if (new RegExp(`\\b${escapeRegex(fn)}\\s*\\(`).test(body)) {
        delegated = true
        break
      }
    }
    if (delegated) continue
    if (allowlist.has(name)) continue
    offenders.push({ name, lineno })
  }
  return offenders
}

/**
 * Self-test: exercise the detection logic against in-memory fixtures so a
 * regression that vacuums the guard fails its own hook. Returns true on pass.
 */
function selfTest() {
  const cases = [
    {
      label: 'DIRECT: #[instrument] on the command fn ⇒ covered',
      src: `#[tauri::command]\n#[instrument(skip(pool), err)]\npub async fn a(pool: P) -> Result<(), AppError> {\n  do_thing()?;\n  Ok(())\n}\n`,
      allow: new Set(),
      expect: [],
    },
    {
      label: 'DELEGATED: wrapper calls an in-file instrumented helper ⇒ covered',
      src: `#[instrument(skip(pool), err)]\nasync fn b_inner_with_space(pool: P) -> Result<(), AppError> { Ok(()) }\n\n#[tauri::command]\npub async fn b(pool: P) -> Result<(), AppError> {\n  b_inner_with_space(pool).await\n}\n`,
      allow: new Set(),
      expect: [],
    },
    {
      label: 'GAP: wrapper delegates to an UN-instrumented helper ⇒ flagged',
      src: `async fn c_inner(pool: P) -> Result<(), AppError> { Ok(()) }\n\n#[tauri::command]\npub async fn c(pool: P) -> Result<(), AppError> {\n  c_inner(pool).await\n}\n`,
      allow: new Set(),
      expect: ['c'],
    },
    {
      label: 'GAP suppressed by allowlist ⇒ not flagged',
      src: `#[tauri::command]\npub async fn d() -> Result<(), AppError> {\n  Ok(())\n}\n`,
      allow: new Set(['d']),
      expect: [],
    },
    {
      label: 'doc-comment mention of #[instrument] does NOT count as coverage',
      src: `/// see #[instrument] elsewhere\n#[tauri::command]\npub async fn e(pool: P) -> Result<(), AppError> {\n  e_logic(pool)?;\n  Ok(())\n}\n`,
      allow: new Set(),
      expect: ['e'],
    },
  ]
  let ok = true
  for (const { label, src, allow, expect } of cases) {
    const got = uncoveredCommands(src, allow).map((o) => o.name)
    const pass = JSON.stringify(got) === JSON.stringify(expect)
    if (!pass) {
      ok = false
      console.error(`self-test FAILED: ${label}`)
      console.error(`  expected ${JSON.stringify(expect)}, got ${JSON.stringify(got)}`)
    }
  }
  // Stale-allowlist guard: every ALLOWLIST entry must still correspond to a
  // real command in the tree, else it silently masks a renamed/removed fn.
  for (const key of ALLOWLIST.keys()) {
    const [file, name] = key.split(':')
    let found = false
    for (const path of walkRustFiles(COMMANDS_DIR)) {
      if (!path.endsWith(`/${file}`)) continue
      const src = readFileSync(path, 'utf8')
      for (const cmd of iterCommandFns(src)) {
        if (cmd.name === name) {
          found = true
          break
        }
      }
    }
    if (!found) {
      ok = false
      console.error(`self-test FAILED: stale ALLOWLIST entry ${key} — no such command`)
    }
  }
  return ok
}

// ─── Entry point ────────────────────────────────────────────────────

if (process.argv.includes('--self-test')) {
  if (selfTest()) {
    process.exit(0)
  }
  console.error('check-tauri-command-instrumented self-test failed (see above).')
  process.exit(1)
}

const offenders = []
for (const path of walkRustFiles(COMMANDS_DIR)) {
  const src = readFileSync(path, 'utf8')
  const filename = path.slice(path.lastIndexOf('/') + 1)
  const fileAllow = new Set(
    [...ALLOWLIST.keys()]
      .filter((k) => k.startsWith(`${filename}:`))
      .map((k) => k.slice(filename.length + 1)),
  )
  for (const { name, lineno } of uncoveredCommands(src, fileAllow)) {
    offenders.push({ path: relative(REPO_ROOT, path), name, lineno })
  }
}

if (offenders.length === 0) {
  process.exit(0)
}

console.error('Every `#[tauri::command]` must be covered by a `tracing` span (#2110 M2):')
console.error('add `#[tracing::instrument(skip(<non-PII args>), err)]` to the command or its')
console.error('logic helper, or add it to ALLOWLIST in this script with a reason.')
console.error('')
console.error('Missing span coverage:')
for (const { path, name, lineno } of offenders) {
  console.error(`  ${path}:${lineno}: ${name}`)
}
process.exit(1)
