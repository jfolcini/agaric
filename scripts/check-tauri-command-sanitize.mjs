#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────
// Tauri command IPC error-sanitization check (MAINT-147 (c)).
//
// Every `#[tauri::command]` wrapper that returns
// `Result<_, AppError>` should funnel its tail expression through
// `.map_err(sanitize_internal_error)` so the IPC boundary never leaks
// a bare `AppError::Sqlx` / `AppError::Io` / `AppError::Internal`
// payload to the frontend. The TS bindings only see the sanitized
// surface (`AppError::Internal("internal error")`).
//
// Macro-extracting this wrapper would obstruct specta's type
// extraction (per MAINT-147 spec), so the convention is enforced as a
// regex-based pre-commit check rather than as a code-level helper.
//
// ─── Scope ──────────────────────────────────────────────────────────
//
// Walks every `*.rs` file under `src-tauri/src/commands/`. For each
// `#[tauri::command]` annotation, isolates the function signature +
// body (using a brace-balance scan) and applies the heuristic below.
//
// ─── Heuristic ──────────────────────────────────────────────────────
//
// A function is flagged iff ALL of:
//   1. It is annotated `#[tauri::command]`;
//   2. Its return type is `Result<…, AppError>` (the expected wire
//      shape for command handlers — non-`Result` returns or
//      non-`AppError` errors are out of scope);
//   3. Its body propagates a fallible call (uses `?` — so an
//      internal-source error CAN reach the IPC boundary; commands
//      whose body has zero `?` operators only return `Ok(...)` or
//      explicitly-constructed `Err(AppError::Validation(...))`-style
//      values that are safe by construction);
//   4. Its body does NOT contain the literal token
//      `sanitize_internal_error` anywhere.
//
// Rule 4 is intentionally lenient: a body that even *mentions*
// `sanitize_internal_error` is presumed to call it on the error path.
// This admits a (rare) class of false negatives but eliminates the
// common false positive where the `.map_err(...)` is split across
// multiple match arms (e.g. `Err(e) => Err(sanitize_internal_error(e))`).
// False positives — flagging a command that legitimately can never
// produce an error worth sanitizing — are acceptable per the spec
// rationale: the cost of an extra `.map_err(sanitize_internal_error)`
// is one identity call on the happy path; the cost of leaking an
// internal error is a privacy regression.
//
// ─── Output ─────────────────────────────────────────────────────────
//
// Prints offenders to stderr in `path:line: name` form and exits 1.
// On a clean run prints nothing and exits 0.
//
// ─── Usage ──────────────────────────────────────────────────────────
//
//   node scripts/check-tauri-command-sanitize.mjs
//
// Wired into `prek.toml` as a `local` repo hook, types = ["rust"].

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const REPO_ROOT = join(HERE, '..')
const COMMANDS_DIR = join(REPO_ROOT, 'src-tauri', 'src', 'commands')

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
 * Locate the byte offset of the matching `}` for the `{` at `openIdx`.
 * Naive brace counter — does NOT skip braces inside string/char/raw-string
 * literals or `//`/`/*…*\/` comments. For our purpose (Rust function
 * bodies in `commands/`) this is good enough: Tauri command bodies are
 * straight-line IPC plumbing without pathological literal contents.
 *
 * Returns `null` if no match is found.
 */
function findMatchingBrace(src, openIdx) {
  let depth = 0
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i]
    if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) return i
    }
  }
  return null
}

/**
 * Yield every `#[tauri::command]` function in `src` as
 * `{ name, returnType, body, lineno }`.
 */
function* iterCommandFns(src) {
  // Find every `#[tauri::command]` annotation, capture from there to
  // the next `{` to extract the signature, then balance braces for the
  // body. `[\s\S]` is the portable "any char including newline" idiom
  // (biome flags `[^]` as a negated-empty-class even though it works).
  const re =
    /#\[tauri::command\][^\n]*\n(?:\s*#\[[^\]]*\][^\n]*\n)*\s*pub\s+(?:async\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:<[^>]*>)?\s*\(([\s\S]*?)\)\s*->\s*([^{]+?)\s*\{/g
  let m = re.exec(src)
  while (m !== null) {
    const [matched, name, , returnType] = m
    const openIdx = m.index + matched.length - 1
    const closeIdx = findMatchingBrace(src, openIdx)
    if (closeIdx !== null) {
      const body = src.slice(openIdx + 1, closeIdx)
      const lineno = src.slice(0, m.index).split('\n').length
      yield { name, returnType: returnType.trim(), body, lineno }
    }
    m = re.exec(src)
  }
}

/**
 * Match `Result<…, AppError>` returns. Tolerates whitespace and
 * generic-argument variations like `Result<crate::error::AppError>`.
 */
function returnsResultAppError(returnType) {
  return /Result<[^>]*,\s*(?:crate::error::)?AppError\s*>/.test(returnType)
}

/**
 * Body propagates errors via `?`. Distinguishes commands that "can
 * fail through internal code" from ones that only construct
 * happy-path or validation-only errors directly.
 *
 * The pattern `\?` matches any `?` token; this is conservative —
 * a `?` inside a string literal would also match — but commands
 * with string-literal `?`s in this codebase are vanishingly rare
 * and the conservative direction is "flag it, ask the human".
 */
function propagatesErrors(body) {
  return /\?[^?]/.test(body) || body.endsWith('?')
}

/**
 * Pre-existing violations grandfathered in at the time MAINT-147 (c)
 * landed. Each entry is `<filename>:<command name>` (relative to
 * `commands/`). Listed here rather than fixed inline because:
 *
 *   - The fix in some cases requires a deeper refactor (e.g. the
 *     `mcp` commands return state-summary types that arguably could
 *     leak `AppError::Sqlx` only via the snapshot decoder, which is
 *     already test-covered for non-internal payloads — see MAINT-147
 *     batch report);
 *   - Touching files outside the MAINT-147 (c) scope (`mcp.rs`,
 *     `logging.rs`) would step on adjacent in-flight MAINT items.
 *
 * New `#[tauri::command]`s must NOT be added to this list; they must
 * use `.map_err(sanitize_internal_error)` (or call
 * `sanitize_internal_error` explicitly inside a match arm). When one
 * of these grandfathered commands is fixed, drop its entry here.
 */
const ALLOWLIST = new Set([
  'logging.rs:get_log_dir',
  'mcp.rs:get_mcp_status',
  'mcp.rs:get_mcp_socket_path',
  'mcp.rs:mcp_set_enabled',
  'mcp.rs:get_mcp_rw_status',
  'mcp.rs:get_mcp_rw_socket_path',
  'mcp.rs:mcp_rw_set_enabled',
])

const offenders = []
for (const path of walkRustFiles(COMMANDS_DIR)) {
  const src = readFileSync(path, 'utf8')
  for (const { name, returnType, body, lineno } of iterCommandFns(src)) {
    if (!returnsResultAppError(returnType)) continue
    if (!propagatesErrors(body)) continue
    if (body.includes('sanitize_internal_error')) continue
    const filename = path.slice(path.lastIndexOf('/') + 1)
    if (ALLOWLIST.has(`${filename}:${name}`)) continue
    offenders.push({ path: relative(REPO_ROOT, path), name, lineno })
  }
}

if (offenders.length === 0) {
  process.exit(0)
}

console.error('`#[tauri::command]` wrappers returning `Result<_, AppError>` must')
console.error('funnel errors through `.map_err(sanitize_internal_error)` so the IPC')
console.error('boundary never leaks bare `AppError::Sqlx` / `AppError::Internal`.')
console.error('')
console.error('Missing sanitize call:')
for (const { path, name, lineno } of offenders) {
  console.error(`  ${path}:${lineno}: ${name}`)
}
process.exit(1)
