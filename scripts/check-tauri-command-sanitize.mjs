#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────
// Tauri command IPC error-sanitization check.
//
// Every `#[tauri::command]` wrapper that returns
// `Result<_, AppError>` should funnel its tail expression through
// `.map_err(sanitize_internal_error)` so the IPC boundary never leaks
// a bare `AppError::Sqlx` / `AppError::Io` / `AppError::Internal`
// payload to the frontend. The TS bindings only see the sanitized
// surface (`AppError::Internal("internal error")`).
//
// Macro-extracting this wrapper would obstruct specta's type
// Extraction (spec), so the convention is enforced as a
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
//   4. Its body does NOT actually CALL `sanitize_internal_error`.
//
// Rule 4 (#2045) requires a real call, not a bare mention: the body must
// either pipe an error through `.map_err(sanitize_internal_error)` (the
// function used as a value) or invoke `sanitize_internal_error(<expr>)`
// directly (e.g. `Err(e) => Err(sanitize_internal_error(e))` split across
// match arms). A reference to the token that only appears in a comment no
// longer satisfies the rule — `findMatchingBrace` skips comment bodies, but
// a doc line *above* the `{` is part of the signature, not the body, and a
// trailing comment that merely names the function used to slip through the
// old `includes('sanitize_internal_error')` token check.
//
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

const HERE = import.meta.dirname
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
 *
 * Skips braces that live inside Rust string literals (`"…"`), char literals
 * (`'{'`), raw strings (`r"…"`, `r#"…"#`, `r##"…"##`, …), and `//` line /
 * `/* … *\/` block comments — so a `{`/`}` inside a `format!("…{…}…")` string
 * or a comment cannot throw off the body's brace balance (#2045). Rust block
 * comments nest, so the scanner tracks block-comment depth.
 *
 * Returns `null` if no match is found.
 */
function findMatchingBrace(src, openIdx) {
  let depth = 0
  let i = openIdx
  while (i < src.length) {
    const c = src[i]
    const next = src[i + 1]

    // Line comment: skip to end of line.
    if (c === '/' && next === '/') {
      const nl = src.indexOf('\n', i + 2)
      if (nl === -1) return null
      i = nl + 1
      continue
    }

    // Block comment (nesting): skip past the matching `*/`.
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

    // Raw string: r"…", r#"…"#, r##"…"##, … — match the same number of
    // `#`s on the closing delimiter. No escape processing inside.
    if (c === 'r' && (next === '"' || next === '#')) {
      let j = i + 1
      let hashes = 0
      while (src[j] === '#') {
        hashes++
        j++
      }
      if (src[j] === '"') {
        // Confirmed raw-string opener `r{#*}"`.
        const close = `"${'#'.repeat(hashes)}`
        const end = src.indexOf(close, j + 1)
        if (end === -1) return null
        i = end + close.length
        continue
      }
      // Not actually a raw string (e.g. an identifier starting with `r`):
      // fall through and treat `r` as an ordinary char.
    }

    // Ordinary string literal: "…" with `\` escapes.
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

    // Char literal: '…' with `\` escapes — but NOT a lifetime (`'a`), which
    // has no closing quote. Only treat as a char literal when a closing `'`
    // is present a plausible distance away.
    if (c === "'") {
      if (src[i + 1] === '\\') {
        // Escaped char: '\n', '\'', '\\', '\u{7f}', … — find the closing '.
        const end = src.indexOf("'", i + 2)
        if (end !== -1 && end - i <= 12) {
          i = end + 1
          continue
        }
      } else if (src[i + 2] === "'") {
        // Simple char literal like '{' or 'a'.
        i += 3
        continue
      }
      // Otherwise a lifetime/label — fall through, `'` is an ordinary char.
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
 * Yield every `#[tauri::command]` function in `src` as
 * `{ name, returnType, body, lineno }`.
 */
function* iterCommandFns(src) {
  // Find every `#[tauri::command]` annotation, capture from there to
  // the next `{` to extract the signature, then balance braces for the
  // body. `[\s\S]` is the portable "any char including newline" idiom
  // (oxlint's eslint/no-empty-character-class flags `[^]` even though it works).
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
 * Match `Result<…, AppError>` returns. Anchors on the ERROR position —
 * a `, AppError>` immediately before the trailing `>` — instead of
 * trying to match the Ok-type with `[^>]*`, which cannot cross the
 * first `>` of a nested generic. The old pattern silently exempted
 * every `Result<Vec<…>, AppError>` / `Result<Option<…>, AppError>` /
 * `Result<HashMap<…, …>, AppError>` command from the sanitize rules
 * (52 of 131 commands at the time of the fix — issue #807).
 */
function returnsResultAppError(returnType) {
  return /,\s*(?:crate::error::)?AppError\s*>\s*$/.test(returnType.trim())
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
 * Body actually CALLS `sanitize_internal_error` (#2045) — not a mere mention.
 * Accepts either form (with an optional `crate::`/`super::`/… path prefix,
 * since both `sanitize_internal_error` and `super::sanitize_internal_error`
 * appear in the tree):
 *   - `.map_err(sanitize_internal_error)` — the fn passed as a value;
 *   - `sanitize_internal_error(<expr>)`   — an explicit call, e.g. in a
 *     match arm `Err(e) => Err(sanitize_internal_error(e))`.
 * A bare token in a comment (which `findMatchingBrace` leaves in the body
 * for non-doc trailing comments) is rejected because neither pattern matches.
 */
const SANITIZE_PATH = String.raw`(?:\w+\s*::\s*)*sanitize_internal_error`
function callsSanitize(body) {
  return (
    new RegExp(String.raw`\.map_err\(\s*${SANITIZE_PATH}\s*\)`).test(body) ||
    new RegExp(String.raw`${SANITIZE_PATH}\s*\(`).test(body)
  )
}

/**
 * Grandfathered violations. Emptied in #2045: the 7 previously-listed
 * commands (`logging.rs:get_log_dir` + 6 `mcp.rs` commands) already route
 * their fallible `?` expressions through `.map_err(sanitize_internal_error)`,
 * so the burndown was a no-op on the Rust side — only the stale allowlist
 * entries (and the lenient rule 4 that let them through) needed removing.
 *
 * The set MUST stay empty. Every `#[tauri::command]` returning
 * `Result<_, AppError>` that propagates errors via `?` must actually CALL
 * `sanitize_internal_error` — either `.map_err(sanitize_internal_error)` or
 * `sanitize_internal_error(e)` in a match arm (rule 4, below). A bare mention
 * in a comment no longer satisfies the check.
 */
const ALLOWLIST = new Set([])

const offenders = []
for (const path of walkRustFiles(COMMANDS_DIR)) {
  const src = readFileSync(path, 'utf8')
  for (const { name, returnType, body, lineno } of iterCommandFns(src)) {
    if (!returnsResultAppError(returnType)) continue
    if (!propagatesErrors(body)) continue
    if (callsSanitize(body)) continue
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
