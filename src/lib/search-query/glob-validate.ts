/**
 * PEND-54 — Lightweight glob validation for the frontend.
 *
 * The backend re-validates and brace-expands authoritatively
 * (`src-tauri/src/fts/glob_filter.rs`); the frontend duplicates the
 * cheap checks so the chip can render red **before** an IPC round-trip
 * tells us the same thing.
 *
 * Validation surface intentionally narrow:
 *   - unbalanced `[` → `InvalidGlob: unbalanced bracket`
 *   - nested `{` → `InvalidGlob: brace nesting not supported`
 *   - escape characters (`\{`, `\}`, `\[`) → `InvalidGlob: escapes not supported`
 *
 * Empty values are surfaced separately by the caller (the prefix
 * parser) as the more user-friendly "path: value required".
 */

export type GlobValidationError = {
  /** `InvalidGlob: …` — the same prefix the backend emits. */
  message: string
}

/** Returns `null` for OK, otherwise a typed error. */
export function validateGlob(input: string): GlobValidationError | null {
  if (input.length === 0) return { message: 'InvalidGlob: empty pattern' }
  const state = { bracket: 0, brace: 0 }
  for (let i = 0; i < input.length; i++) {
    const err = stepGlobValidate(input, i, state)
    if (err) return err
  }
  if (state.bracket !== 0) return { message: 'InvalidGlob: unbalanced bracket' }
  if (state.brace !== 0) return { message: 'InvalidGlob: unbalanced brace' }
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
      return { message: 'InvalidGlob: escapes not supported' }
    }
    return null
  }
  switch (ch) {
    case '[':
      state.bracket++
      return null
    case ']':
      if (state.bracket === 0) return { message: 'InvalidGlob: unbalanced bracket' }
      state.bracket--
      return null
    case '{':
      state.brace++
      if (state.brace > 1) return { message: 'InvalidGlob: brace nesting not supported' }
      return null
    case '}':
      if (state.brace === 0) return { message: 'InvalidGlob: unbalanced brace' }
      state.brace--
      return null
    default:
      return null
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
        i = pattern.length
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
