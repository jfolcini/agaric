/**
 * Lightweight glob validation for the frontend.
 *
 * The backend re-validates and brace-expands authoritatively
 * (`src-tauri/src/fts/glob_filter.rs`); the frontend duplicates the
 * cheap checks so the chip can render red **before** an IPC round-trip
 * tells us the same thing.
 *
 * Validation surface intentionally narrow:
 *   - unbalanced `[` → `InvalidGlob: unbalanced bracket`
 *   - nested `{` → `InvalidGlob: brace nesting not supported`
 *   - escape characters (`\{`, `\}`, `\[`, `\]`) → `InvalidGlob: escapes not supported`
 *
 * Empty values are surfaced separately by the caller (the prefix
 * parser) as the more user-friendly "path: value required".
 */

import { prefixed, ValidationCode } from './validation-codes'

export interface GlobValidationError {
  /** `InvalidGlob: …` — the same prefix the backend emits. */
  message: string
}

/** Build an `InvalidGlob: <reason>` error from the shared code (#1061). */
function globError(reason: string): GlobValidationError {
  return { message: prefixed(ValidationCode.InvalidGlob, reason) }
}

/** Returns `null` for OK, otherwise a typed error. */
export function validateGlob(input: string): GlobValidationError | null {
  if (input.length === 0) return globError('empty pattern')
  const state = { bracket: 0, brace: 0 }
  for (let i = 0; i < input.length; i++) {
    const err = stepGlobValidate(input, i, state)
    if (err) return err
  }
  if (state.bracket !== 0) return globError('unbalanced bracket')
  if (state.brace !== 0) return globError('unbalanced brace')
  return null
}

function stepGlobValidate(
  input: string,
  i: number,
  state: { bracket: number; brace: number },
): GlobValidationError | null {
  const ch = input[i]
  if (ch === '\\') {
    const next = input[i + 1]
    if (next === '{' || next === '}' || next === '[' || next === ']') {
      return globError('escapes not supported')
    }
    return null
  }
  switch (ch) {
    case '[': {
      state.bracket++
      return null
    }
    case ']': {
      if (state.bracket === 0) return globError('unbalanced bracket')
      state.bracket--
      return null
    }
    case '{': {
      state.brace++
      if (state.brace > 1) return globError('brace nesting not supported')
      return null
    }
    case '}': {
      if (state.brace === 0) return globError('unbalanced brace')
      state.brace--
      return null
    }
    default: {
      return null
    }
  }
}

/**
 * Brace-expand a glob pattern into the list of expanded patterns the
 * backend will see. Cartesian over multiple `{…}` groups, capped at
 * `EXPANSION_CAP` total patterns.
 *
 * `{a,b}/{c,d}` → `['a/c', 'a/d', 'b/c', 'b/d']`
 *
 * Bare patterns (no braces) expand to themselves. Whitespace-only
 * alternatives are silently dropped (matches the plan's "Whitespace-
 * only entry between commas → silently dropped" rule).
 *
 * Mirrors the Rust implementation in `src-tauri/src/fts/glob_filter.rs`
 * so chip-side preview counts match the backend exactly.
 *
 * This is a parity reference: it currently has no production
 * caller (the chip-side preview-count consumer was never built; the
 * glob value is passed verbatim to the backend, which expands it
 * authoritatively). It is intentionally retained, exported, and pinned
 * by `__tests__/glob-validate.test.ts` so its contract stays in lockstep
 * with the Rust expander. The contract that matters: at `EXPANSION_CAP`
 * the result is *truncated*, never an error — matching the backend's
 * `results.truncate(EXPANSION_CAP)` (it does not error on overflow).
 */
export const EXPANSION_CAP = 64

type Segment = { literal: string } | { alts: string[] }

function parseSegments(pattern: string): Segment[] {
  const segments: Segment[] = []
  let i = 0
  let buf = ''
  while (i < pattern.length) {
    const ch = pattern[i]
    if (ch === '{') {
      if (buf.length > 0) {
        segments.push({ literal: buf })
        buf = ''
      }
      const end = pattern.indexOf('}', i + 1)
      if (end === -1) {
        buf = pattern.slice(i)
        break
      }
      const alts = pattern
        .slice(i + 1, end)
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
      segments.push({ alts: alts.length > 0 ? alts : [''] })
      i = end + 1
    } else {
      buf += ch
      i++
    }
  }
  if (buf.length > 0) segments.push({ literal: buf })
  return segments
}

export function expandBraces(pattern: string): string[] {
  if (!pattern.includes('{')) return [pattern]
  const segments = parseSegments(pattern)
  let results: string[] = ['']
  for (const seg of segments) {
    const next: string[] = []
    if ('literal' in seg) {
      for (const r of results) next.push(r + seg.literal)
    } else {
      outer: for (const r of results) {
        for (const a of seg.alts) {
          next.push(r + a)
          if (next.length > EXPANSION_CAP) break outer
        }
      }
    }
    results = next.length > EXPANSION_CAP ? next.slice(0, EXPANSION_CAP) : next
    if (results.length >= EXPANSION_CAP) break
  }
  return results
}

/**
 * Maximum byte length of a single trimmed sub-entry. Mirrors
 * `MAX_GLOB_LEN` in `src-tauri/src/fts/glob_filter.rs` — a DoS guard against
 * a caller shipping a many-megabyte pattern. Measured in UTF-8 bytes (as the
 * Rust side measures `str::len`) AFTER comma-split + trim.
 */
export const MAX_GLOB_LEN = 1024

/** ASCII-only lowercase (A–Z → a–z), mirroring SQLite's ICU-free `LOWER()`. */
export function asciiLowercase(input: string): string {
  return input.replace(/[A-Z]/g, (c) => c.toLowerCase())
}

/**
 * Split one raw entry on top-level commas only — commas inside a `{…}` group
 * are brace alternatives and must NOT split the entry. Mirrors
 * `split_top_level_commas` in `glob_filter.rs`.
 */
function splitTopLevelCommas(input: string): string[] {
  const out: string[] = []
  let depth = 0
  let last = 0
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]
    if (ch === '{') depth++
    else if (ch === '}') depth = Math.max(0, depth - 1)
    else if (ch === ',' && depth === 0) {
      out.push(input.slice(last, i))
      last = i + 1
    }
  }
  out.push(input.slice(last))
  return out
}

/** Wrap a bare token in `*…*` for substring matching, matching `wrap_substring`. */
function wrapSubstring(input: string): string {
  return /[*?[]/.test(input) ? input : `*${input}*`
}

const UTF8 = new TextEncoder()

/**
 * Port of `prepare_globs` (`src-tauri/src/fts/glob_filter.rs`): turn raw glob
 * entries into the SQL-ready, ASCII-lowercased GLOB pattern list the backend
 * would bind into `LOWER(title) GLOB ?`. Each entry is split on top-level
 * commas; each non-empty trimmed sub-entry is length-checked, validated
 * (`validateGlob`), brace-expanded, substring-wrapped, then ASCII-lowercased.
 *
 * Throws an {@link Error} whose message carries the shared `InvalidGlob:`
 * prefix on a malformed pattern — the same contract the backend surfaces as
 * `AppError::Validation`. An all-whitespace input yields `[]` (the caller
 * treats that as "no constraint").
 */
export function prepareGlobs(entries: string[]): string[] {
  const out: string[] = []
  for (const entry of entries) {
    for (const raw of splitTopLevelCommas(entry)) {
      const trimmed = raw.trim()
      if (trimmed.length === 0) continue
      if (UTF8.encode(trimmed).length > MAX_GLOB_LEN) {
        throw new Error(
          prefixed(
            ValidationCode.InvalidGlob,
            `pattern length ${UTF8.encode(trimmed).length} exceeds cap ${MAX_GLOB_LEN}`,
          ),
        )
      }
      const invalid = validateGlob(trimmed)
      if (invalid) throw new Error(invalid.message)
      const expanded = expandBraces(trimmed)
      const patterns = expanded.length > 0 ? expanded : [trimmed]
      for (const pat of patterns) {
        out.push(asciiLowercase(wrapSubstring(pat)))
      }
    }
    if (out.length > EXPANSION_CAP) {
      throw new Error(
        prefixed(ValidationCode.InvalidGlob, `expansion exceeded cap ${EXPANSION_CAP}`),
      )
    }
  }
  return out
}

/**
 * Compile ONE already-prepared (brace-expanded, substring-wrapped,
 * ASCII-lowercased) GLOB pattern into an anchored `RegExp` mirroring SQLite's
 * `GLOB` operator:
 *   - `*` → any run of chars (incl. empty), `?` → exactly one char;
 *   - `[…]` is a character class — a leading `^` negates (SQLite uses `^`,
 *     not `!`), `a-z` ranges and a literal leading `]` are honored;
 *   - every other char is a literal; GLOB has NO escape char, so a backslash
 *     is itself a literal.
 * GLOB is case-SENSITIVE and whole-string-anchored; case-insensitivity is
 * obtained upstream by ASCII-lowercasing BOTH the pattern (in
 * {@link prepareGlobs}) and the title (via {@link asciiLowercase}), so the
 * compiled regex carries no `i` flag.
 */
export function globToRegExp(glob: string): RegExp {
  let src = '^'
  let i = 0
  while (i < glob.length) {
    const ch = glob[i]
    if (ch === undefined) break
    if (ch === '*') {
      src += '.*'
      i++
    } else if (ch === '?') {
      src += '.'
      i++
    } else if (ch === '[') {
      const cls = compileCharClass(glob, i)
      if (cls === null) {
        // Unterminated `[` — `validateGlob` rejects this upstream, but stay
        // safe and treat the bracket as a literal.
        src += '\\['
        i++
      } else {
        src += cls.regex
        i = cls.next
      }
    } else {
      src += escapeRegexLiteral(ch)
      i++
    }
  }
  src += '$'
  return new RegExp(src)
}

/** Compile a `[...]` GLOB class starting at `start`; null if unterminated. */
function compileCharClass(glob: string, start: number): { regex: string; next: number } | null {
  let j = start + 1
  let negate = false
  if (glob[j] === '^') {
    negate = true
    j++
  }
  let body = ''
  // A `]` immediately after `[` or `[^` is a literal member, not the close.
  if (glob[j] === ']') {
    body += '\\]'
    j++
  }
  while (j < glob.length && glob[j] !== ']') {
    const c = glob[j]
    if (c === undefined) break
    // Preserve `-` (range) and `^` (literal mid-class); escape only the chars
    // that are structurally special inside a JS regex class.
    body += c === '\\' ? '\\\\' : c
    j++
  }
  if (j >= glob.length) return null
  return { regex: `[${negate ? '^' : ''}${body}]`, next: j + 1 }
}

/** Escape a single literal char for use outside a regex character class. */
function escapeRegexLiteral(ch: string): string {
  return ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Evaluate one Pages `PathGlob` filter primitive against a page title,
 * faithfully mirroring the backend's `compile_pages_filters` PathGlob branch
 * (`src-tauri/src/commands/pages/metadata.rs`):
 *   - the raw pattern is run through {@link prepareGlobs} as a single entry;
 *   - a whitespace-only / fully-stripped pattern constrains nothing, so the
 *     row passes (the backend `continue`s, emitting no clause);
 *   - include (`exclude=false`): the title matches if it GLOB-matches ANY
 *     prepared pattern; exclude (`exclude=true`): it must match NONE;
 *   - an invalid glob makes the backend reject the whole query
 *     (`AppError::Validation` → zero rows); the closest per-row approximation
 *     is "no rows", so the row is dropped for both include and exclude.
 */
export function pageGlobFilterMatches(pattern: string, title: string, exclude: boolean): boolean {
  let prepared: string[]
  try {
    prepared = prepareGlobs([pattern])
  } catch {
    return false
  }
  if (prepared.length === 0) return true
  const hay = asciiLowercase(title)
  const hit = prepared.some((p) => globToRegExp(p).test(hay))
  return exclude ? !hit : hit
}
