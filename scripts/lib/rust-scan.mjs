// Shared Rust-source scanning for the guards that police `src-tauri/` (#5579):
// check-raw-tx.mjs and check-table-ownership.mjs now, check-dynamic-sql when
// it leaves Python.
//
// Whitespace, word characters and line breaks follow Python's definitions
// (`str.isspace`, Unicode `\b`, `str.splitlines`), the ones these guards'
// verdicts were first written against. The scanner walks CODE POINTS, so an
// emoji shifts no offset and `'😀'` is blanked as a char literal; that is why
// it does not reuse `check-bulk-equivalence.mjs`'s `blank()`, which walks
// UTF-16 units and gets both wrong.

import { statSync } from 'node:fs'
import { join } from 'node:path'

import {
  SOURCE_INDEX,
  gitEnv,
  listTrackedEntries,
  readContents,
  resolveSource,
} from './guard-file-source.mjs'

/**
 * Crate roots the Rust guards police. A changed `.rs` file outside every one
 * of these (build scripts, benches, fuzz, gen) is out of scope.
 */
export const CRATE_ROOTS = Object.freeze([
  'src-tauri/agaric-store/src/',
  'src-tauri/agaric-engine/src/',
  'src-tauri/agaric-sync/src/',
  'src-tauri/diagnostics/src/',
  'src-tauri/src/',
])

// Files their parent module declares `#[cfg(test)] mod …`, so they carry no
// inner `#[cfg(test)]` for `cfgTestLineSet` to find.
const TEST_FILE_GLOBS = ['**/tests.rs', '**/tests/**', '**/*_tests.rs']

// Python's `str.isspace()` / `\s`, which String#trim and JS `\s` are not:
// they disagree on U+001C–U+001F, U+0085 and U+FEFF.
const PY_SPACE =
  '\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000'
/** One Python `\s`, for building `u`-flag patterns. */
export const WS = `[${PY_SPACE}]`
// Python's `\b` is Unicode-aware; a JS `\b` treats `é` as a boundary.
/** One Python `\w`, for building `u`-flag patterns. */
export const WORD = '[\\p{L}\\p{N}_]'
/** Python's `\b` before a word character, for `u`-flag patterns. */
export const WORD_START = `(?<!${WORD})`
/** Python's `\b` after a word character, for `u`-flag patterns. */
export const WORD_END = `(?!${WORD})`

const TRIM_RE = new RegExp(`^[${PY_SPACE}]+|[${PY_SPACE}]+$`, 'gu')
// Python's `str.splitlines()` boundaries, U+001C–U+001E included.
// oxlint-disable-next-line no-control-regex -- those separators are the point
const LINE_BREAK_RE = /\r\n|[\n\r\v\f\x1C-\x1E\x85\u2028\u2029]/

const CFG_TEST_RE = new RegExp(`#\\[${WS}*cfg${WS}*\\(${WS}*test${WS}*\\)${WS}*\\]`, 'u')
const MOD_RE = new RegExp(`${WORD_START}mod${WORD_END}`, 'u')

/** `str.strip()`: trims Python's whitespace set, not String#trim's. */
export function trimSpace(text) {
  return text.replace(TRIM_RE, '')
}

/** `str.splitlines()`: every Unicode line break, no trailing empty line. */
export function splitLines(text) {
  const lines = text.split(LINE_BREAK_RE)
  if (lines.at(-1) === '') lines.pop()
  return lines
}

/**
 * Blank comments, string literals (raw strings included) and char literals
 * to spaces, keeping every newline, so line numbers in the result map 1:1
 * onto `text`. A mention of a call inside a comment or string can then never
 * match, and a `//` inside a string never truncates it. A lifetime (`'a`) is
 * not a char literal because the char-literal form needs its closing quote.
 *
 * `keepStrings` blanks the comments only, for a guard whose match lives
 * inside the literals (SQL in `sqlx::query!("…")`); the literals are still
 * parsed, so a `//` inside one is not taken for a comment.
 */
export function stripRustComments(text, { keepStrings = false } = {}) {
  const cps = Array.from(text)
  const out = [...cps]
  const n = cps.length
  const blank = (start, end) => {
    for (let k = start; k < Math.min(end, n); k++) {
      if (out[k] !== '\n') out[k] = ' '
    }
  }
  let i = 0
  while (i < n) {
    const end = literalEnd(cps, i)
    if (end === -1) {
      i += 1
    } else {
      // Only a comment starts with `/`.
      if (!keepStrings || cps[i] === '/') blank(i, end)
      i = end
    }
  }
  return out.join('')
}

// Where the comment or literal starting at `i` ends (exclusive, possibly past
// the end of input), or -1 when none starts there.
function literalEnd(cps, i) {
  const ch = cps[i]
  const nxt = cps[i + 1]
  if (ch === '/' && nxt === '/') return lineCommentEnd(cps, i)
  if (ch === '/' && nxt === '*') return blockCommentEnd(cps, i)
  if (ch === 'r' && (nxt === '"' || nxt === '#')) {
    const end = rawStringEnd(cps, i)
    if (end !== -1) return end
  }
  if (ch === '"') return stringEnd(cps, i)
  if (ch === "'") return charLiteralEnd(cps, i)
  return -1
}

function lineCommentEnd(cps, i) {
  let j = i
  while (j < cps.length && cps[j] !== '\n') j += 1
  return j
}

// Rust block comments nest.
function blockCommentEnd(cps, i) {
  const n = cps.length
  let depth = 0
  let j = i
  while (j < n) {
    if (cps[j] === '/' && cps[j + 1] === '*') {
      depth += 1
      j += 2
    } else if (cps[j] === '*' && cps[j + 1] === '/') {
      depth -= 1
      j += 2
      if (depth === 0) break
    } else {
      j += 1
    }
  }
  return j
}

// `r"…"` / `r#"…"#`; -1 when the `r` does not open one. Unterminated runs to
// the end of input.
function rawStringEnd(cps, i) {
  const n = cps.length
  let h = i + 1
  while (h < n && cps[h] === '#') h += 1
  if (cps[h] !== '"') return -1
  const hashes = h - i - 1
  for (let p = h + 1; p < n; p++) {
    if (cps[p] !== '"') continue
    let k = 0
    while (k < hashes && cps[p + 1 + k] === '#') k += 1
    if (k === hashes) return p + 1 + hashes
  }
  return n
}

function stringEnd(cps, i) {
  const n = cps.length
  let j = i + 1
  while (j < n) {
    if (cps[j] === '\\') {
      j += 2
    } else if (cps[j] === '"') {
      return j + 1
    } else {
      j += 1
    }
  }
  return j
}

// `'x'` or `'\x'`, where x is any code point but a newline; -1 otherwise.
function charLiteralEnd(cps, i) {
  const [a, b, c] = [cps[i + 1], cps[i + 2], cps[i + 3]]
  if (a === '\\') return b !== undefined && b !== '\n' && c === "'" ? i + 4 : -1
  if (a !== undefined && a !== "'" && a !== '\n' && b === "'") return i + 3
  return -1
}

/**
 * A pattern containing `**` is a glob in which `**` spans `/` and `*` does
 * not; any other pattern is an exact path.
 */
export function globMatch(path, pattern) {
  if (!pattern.includes('**')) return path === pattern
  const regex = escapeRegex(pattern)
    .replaceAll('\\*\\*/', '[^\\n]*')
    .replaceAll('\\*\\*', '[^\\n]*')
    .replaceAll('\\*', '[^/]*')
  return new RegExp(`^(?:${regex})$`).test(path)
}

// Escapes `*` too, so the rewrites above find every wildcard as `\*`.
function escapeRegex(text) {
  return text.replace(/[()[\]{}?*+\-|^$\\.&~# \t\n\r\v\f]/g, '\\$&')
}

/** A whole-file test module: `tests.rs`, anything under `tests/`, `*_tests.rs`. */
export function isTestFile(relPath) {
  return TEST_FILE_GLOBS.some((glob) => globMatch(relPath, glob))
}

/**
 * The 0-based indices of `lines` inside a `#[cfg(test)] mod … { … }`, from
 * the line holding its opening brace through the line holding the matching
 * close (or the last line, when it never closes). Feed it comment-stripped
 * lines; braces are counted without regard to literals.
 */
export function cfgTestLineSet(lines) {
  const inside = new Set()
  const n = lines.length
  let i = 0
  while (i < n) {
    if (!CFG_TEST_RE.test(lines[i])) {
      i += 1
      continue
    }
    const modLine = findModLine(lines, i)
    if (modLine === -1) {
      i += 1
      continue
    }
    let braceLine = modLine
    while (braceLine < n && !lines[braceLine].includes('{')) braceLine += 1
    if (braceLine === n) {
      i = modLine + 1
      continue
    }
    const end = matchingCloseLine(lines, braceLine)
    for (let idx = braceLine; idx <= end; idx++) inside.add(idx)
    i = end + 1
  }
  return inside
}

// The line at or after `from` holding `mod`, or -1 when a line that is
// neither blank nor an attribute comes first (`#[cfg(test)]` on a fn).
function findModLine(lines, from) {
  for (let j = from; j < lines.length; j++) {
    if (MOD_RE.test(lines[j])) return j
    const stripped = trimSpace(lines[j])
    if (stripped && !stripped.startsWith('#[')) return -1
  }
  return -1
}

function matchingCloseLine(lines, braceLine) {
  let depth = 0
  for (let m = braceLine; m < lines.length; m++) {
    const line = lines[m]
    for (let c = m === braceLine ? line.indexOf('{') : 0; c < line.length; c++) {
      if (line[c] === '{') depth += 1
      else if (line[c] === '}') {
        depth -= 1
        if (depth === 0) return m
      }
    }
  }
  return lines.length - 1
}

/**
 * Which copy of each file a guard judges (the staged index during a commit,
 * the working tree otherwise), behind the `exists` / `read` pair the Rust
 * guards ask per path. Arguments not starting with `-` are paths and are not
 * judged as flags.
 *
 * @param {string[]} argv the guard's own arguments, without node and script.
 * @throws whatever `resolveSource` throws for a bad flag or a foreign index.
 */
export function openFileSource(argv, env, { repoRoot, extraFlags = [] }) {
  // `resolveSource` skips the two leading entries of a full `process.argv`.
  const flags = ['', '', ...argv.filter((arg) => arg.startsWith('-'))]
  const { source, why } = resolveSource(flags, env, { extraFlags, repoRoot })
  const gitEnvironment = gitEnv(repoRoot, env)
  let entries
  const index = () => {
    if (entries === undefined) {
      entries = listTrackedEntries(repoRoot, { env: gitEnvironment })
      // An index that cannot be read must not answer "absent" for every path.
      if (entries === null) throw new Error(`${repoRoot} is not a git repository`)
    }
    return entries
  }
  return {
    source,
    why,
    /** Is `rel` in the commit (index) or a file on disk (working tree)? */
    exists(rel) {
      if (source === SOURCE_INDEX) return Boolean(index().byPath.get(rel)?.sha)
      try {
        return statSync(join(repoRoot, rel)).isFile()
      } catch {
        return false
      }
    },
    /** `rel`'s text from the source, or null; an empty file is `''`. */
    read(rel) {
      const bodies = readContents([rel], {
        repoRoot,
        source,
        entries: source === SOURCE_INDEX ? index() : undefined,
        env: gitEnvironment,
      })
      return bodies.get(rel) ?? null
    },
  }
}
