#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────
// Unanchored-content-regex guard (#3348, theme T4 "text treated as
// structure").
//
// Agaric's primary data is user prose with embedded `[[ULID]]` reference
// tokens. Several code paths rewrite that prose in place. When the
// matcher for such a rewrite is built from a RUNTIME string (a page
// title, an alias, a search term) and is not explicitly bounded, the
// rewrite splices the middle of an unrelated word and durably corrupts
// the user's text — with a success toast on top of it.
//
// This is not hypothetical. #3313: `UnlinkedReferences.tsx` built
// `new RegExp(escapeRegExp(term), 'i')` and ran `content.replace(...)`
// over a block, so applying "Link it" for a page titled `Note` turned
// the block `Notebook shopping list` into `[[01J…]]book shopping list`,
// committed it via `editBlock`, and optimistically stripped the row from
// the query cache so nothing refetched to reveal the damage.
//
// #3313's own first fix was then found to be wrong too: its boundary
// class `[\p{L}\p{N}_]` omitted `\p{M}` (combining marks), so on
// NFD-decomposed content (`café` = `caf` + `e` + U+0301) the trailing
// combining acute is not a letter/digit and therefore read as a
// legitimate word boundary — the splice moved from "mid-word" to
// "mid-grapheme". Rule 3 below exists specifically because that
// near-miss IS statically visible.
//
// ─── The three rules ────────────────────────────────────────────────
//
// 1. `unanchored-surgery`
//    A `new RegExp(<pattern>, …)` where
//      (a) `<pattern>` is DYNAMIC — after substituting module-level
//          string constants (see "Static by construction" below), the
//          pattern still depends on a runtime value (an identifier, a
//          call, a template interpolation); AND
//      (b) the pattern carries no explicit boundary on BOTH sides of the
//          dynamic part — left: `^`, `\b`, `\B`, `(?<=`, `(?<!`;
//          right: `$`, `\b`, `\B`, `(?=`, `(?!`. A half-anchored
//          pattern (`\b${term}`) still splices on the other side, so
//          both sides are required; AND
//      (c) the compiled regex is used for SURGERY — it reaches a
//          `.replace(` / `.replaceAll(` call. Three shapes are followed:
//          the inline form `s.replace(new RegExp(…), …)`, the bound form
//          (`const re = new RegExp(…)` … `s.replace(re, …)`), and the
//          helper form (`function f(t) { return new RegExp(…) }` …
//          `s.replace(f(x), …)`).
//
//    (c) is what keeps this guard usable. Read-only matching — in-page
//    find, glob validation, highlight ranges — legitimately compiles
//    unanchored dynamic regexes all over this codebase; a wrong match
//    there paints a wrong highlight (visible, transient), while a wrong
//    replace corrupts durable data. Only the second is banned.
//
// 2. `error-message-substring`
//    `X.includes('literal')` / `X.indexOf('literal')` where `X` is
//    derived from an error MESSAGE (`err.message`, `String(err)`, or a
//    local binding initialised from either). Platform and backend error
//    strings are locale- and version-dependent, so branching on a
//    hard-coded English fragment is a silently-decaying classifier —
//    `src/lib/categorize-history-error.ts` is the cited case. Array
//    membership (`OPTIONS.includes(value)`) is untouched: the receiver
//    must be error-message-derived AND the argument must be a string
//    literal.
//
// 3. `incomplete-boundary-class`
//    A regex character class that mentions Unicode letters/numbers
//    (`\p{L…}`, `\p{N…}`, `\p{Alpha…}`) but NOT combining marks
//    (`\p{M…}`). Such a class is nearly always a word-boundary class,
//    and one that excludes combining marks treats the base letter of an
//    NFD grapheme cluster as a word edge — the exact #3313 near-miss.
//    Applies to regex literals and to patterns written as strings
//    (`\\p{L}` inside a template is normalised to `\p{L}` first).
//
// ─── Static by construction (why enex-import is not flagged) ────────
//
// Rule 1 resolves module-level `const NAME = '<literal>'` bindings
// before deciding whether a pattern is dynamic. `src/lib/enex-import.ts`
// replaces Private-Use-Area sentinels it injected itself
// (`const CRYPT_SENTINEL = '\uE004'` …, then
// `.replace(new RegExp(CRYPT_SENTINEL, 'g'), …)`). The pattern is a
// compile-time constant, collision-free by construction, and reviewable
// in the diff — not a runtime string. It is therefore NOT a violation
// and needs no exemption. Without this resolution step the guard would
// fire on every sentinel round-trip and be turned off within a week.
//
// ─── Scope ──────────────────────────────────────────────────────────
//
// `src/**/*.{ts,tsx}` only, excluding `__tests__/` + `tests/`
// directories, `*.test.ts[x]` and `*.d.ts`. Deliberately NOT scanned:
//
//   - `scripts/`, `e2e/`, config, and any other tooling — tooling
//     regexes operate on source code and CI output, never on a user's
//     prose. A guard that fires there gets disabled.
//   - test files — a test's whole job may be to construct the bad shape
//     and assert it misbehaves (see the `Note`/`Notebook` collision test
//     in the unlinked-references suite).
//   - `src-tauri/**` (Rust) — out of this guard's language.
//
// ─── Two exemption mechanisms, both explicit ────────────────────────
//
// 1. Per-site marker, for NEW code with a reviewed reason:
//
//        // content-regex-allow: sentinel is a PUA control char
//        const re = new RegExp(SENTINEL, 'g')
//
//    on the violating line or the line immediately above. The reason
//    text after the colon must be non-empty — a bare marker does not
//    suppress anything.
//
// 2. `scripts/content-regex-baseline.json`, for pre-existing debt: a
//    sorted array of `{ file, rule, count, reason }`. A file+rule pair
//    whose live count EXCEEDS its baseline fails (new violation); one
//    whose live count is BELOW its baseline also fails (stale entry —
//    the ratchet must be re-anchored so the debt can only shrink).
//    `--update-baseline` rewrites counts and PRESERVES existing reasons,
//    writing `""` for newly-added entries; an empty reason is a hard
//    error (exit 2). You cannot silently baseline a violation.
//
// ─── Known limits (documented, not accidental) ──────────────────────
//
//   - Rule 1 only follows the three usage shapes listed above. A regex
//     handed to another module and replaced there is not tracked.
//   - A pattern bounded by an ordinary literal character rather than an
//     assertion (`${term}\\]\\]`) is reported; use the marker.
//   - Comment stripping is textual (shared house style): a `//` inside a
//     regex literal or string truncates the rest of that line, which can
//     only cause a missed violation, never a false one.
//
// The guard scans `src/` only, and its own fixtures live in a temp
// directory created by `--self-test`, so nothing here can match itself.
//
// Usage: node scripts/check-unanchored-content-regex.mjs
//        node scripts/check-unanchored-content-regex.mjs --update-baseline
//        node scripts/check-unanchored-content-regex.mjs --self-test
// Exit:  0 = clean, 1 = new violation or stale baseline entry,
//        2 = repo layout / malformed baseline / self-test failure.
// ─────────────────────────────────────────────────────────────────────

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const SRC_DIR = path.join(ROOT, 'src')
const BASELINE_FILE = path.join(ROOT, 'scripts', 'content-regex-baseline.json')

const RULES = Object.freeze([
  'unanchored-surgery',
  'error-message-substring',
  'incomplete-boundary-class',
])

/** Placeholder standing in for a runtime-dependent chunk of a pattern. */
const DYN = '\u0000'

// ─── generic helpers ──────────────────────────────────────────────────

function toPosix(p) {
  return p.split(path.sep).join('/')
}

/**
 * Walk `srcDir` for `*.ts` / `*.tsx`, excluding test files, `__tests__/`
 * and `tests/` directories, and `.d.ts` declarations.
 */
function listSourceFiles(srcDir) {
  const out = []
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === '__tests__' || entry.name === 'tests') continue
        visit(full)
      } else if (
        entry.isFile() &&
        (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) &&
        !entry.name.endsWith('.test.ts') &&
        !entry.name.endsWith('.test.tsx') &&
        !entry.name.endsWith('.d.ts')
      ) {
        out.push(full)
      }
    }
  }
  visit(srcDir)
  return out.toSorted()
}

/**
 * Replace block comments (`/* … *\/`, incl. JSDoc) and line comments
 * (`// …`) with spaces, preserving newlines so line numbers stay exact.
 * A documented or commented-out bad shape is therefore not a violation.
 */
function stripComments(src) {
  let out = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  out = out.replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length))
  return out
}

/** 1-based line number of `idx` in `src`, via a prefix newline count. */
function makeLineLookup(src) {
  const starts = [0]
  for (let i = 0; i < src.length; i++) if (src[i] === '\n') starts.push(i + 1)
  return (idx) => {
    let lo = 0
    let hi = starts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (starts[mid] <= idx) lo = mid
      else hi = mid - 1
    }
    return lo + 1
  }
}

/**
 * Line numbers carrying a `// content-regex-allow: <reason>` marker with
 * a NON-EMPTY reason. Read from the ORIGINAL source (comments are
 * stripped before scanning, so the marker would otherwise be invisible).
 */
function allowMarkerLines(src) {
  const lines = src.split('\n')
  const out = new Set()
  for (let i = 0; i < lines.length; i++) {
    const m = /\/\/\s*content-regex-allow\s*:\s*(.*)$/.exec(lines[i])
    if (m && m[1].trim().length > 0) out.add(i + 1)
  }
  return out
}

/** Is a violation on `line` exempted by a marker on that line or the one above? */
function isMarked(markers, line) {
  return markers.has(line) || markers.has(line - 1)
}

// ─── a very small JS literal scanner ─────────────────────────────────
//
// Enough to find the end of a balanced `(`…`)`, to split top-level
// arguments, and to walk string / template literals (including nested
// `${…}`). It is NOT a JS parser: regex literals are not tracked, so a
// `(` or `)` inside a regex literal passed as an argument could
// mis-balance. That shape does not occur in the scanned tree and would
// only cause a missed violation.

/** Index just past the string literal starting at `i` (a quote char). */
function skipQuoted(src, i) {
  const q = src[i]
  let j = i + 1
  while (j < src.length) {
    if (src[j] === '\\') {
      j += 2
      continue
    }
    if (src[j] === q) return j + 1
    j++
  }
  return j
}

/** Index just past the template literal starting at `i` (a backtick). */
function skipTemplate(src, i) {
  let j = i + 1
  while (j < src.length) {
    if (src[j] === '\\') {
      j += 2
      continue
    }
    if (src[j] === '`') return j + 1
    if (src[j] === '$' && src[j + 1] === '{') {
      j = skipBalanced(src, j + 1, '{', '}')
      continue
    }
    j++
  }
  return j
}

/**
 * Index just past the balanced group starting at `i` (which must be
 * `open`). Skips over string and template literals.
 */
function skipBalanced(src, i, open = '(', close = ')') {
  let depth = 0
  let j = i
  while (j < src.length) {
    const c = src[j]
    if (c === "'" || c === '"') {
      j = skipQuoted(src, j)
      continue
    }
    if (c === '`') {
      j = skipTemplate(src, j)
      continue
    }
    if (c === open) depth++
    else if (c === close) {
      depth--
      if (depth === 0) return j + 1
    }
    j++
  }
  return j
}

/**
 * Split the argument list of a call whose `(` is at `openIdx`. Returns
 * `{ end, args }` where `end` is the index of the closing `)` and `args`
 * are the raw top-level argument texts.
 */
function readCallArgs(src, openIdx) {
  const args = []
  let depth = 0
  let start = openIdx + 1
  let j = openIdx
  while (j < src.length) {
    const c = src[j]
    if (c === "'" || c === '"') {
      j = skipQuoted(src, j)
      continue
    }
    if (c === '`') {
      j = skipTemplate(src, j)
      continue
    }
    if (c === '(' || c === '[' || c === '{') {
      depth++
      j++
      continue
    }
    if (c === ']' || c === '}') {
      depth--
      j++
      continue
    }
    if (c === ')') {
      depth--
      if (depth === 0) {
        args.push(src.slice(start, j))
        return { end: j, args }
      }
      j++
      continue
    }
    if (c === ',' && depth === 1) {
      args.push(src.slice(start, j))
      start = j + 1
      j++
      continue
    }
    j++
  }
  return { end: j, args }
}

// ─── pattern analysis ────────────────────────────────────────────────

/**
 * Module-level `const NAME = '<string literal>'` bindings, as a
 * `Map<name, rawLiteralContents>`. Template literals containing `${` are
 * skipped (not compile-time constant). These are what makes a
 * sentinel-based `new RegExp(SENTINEL, 'g')` static rather than dynamic.
 */
function collectStringConsts(stripped) {
  const out = new Map()
  // Anchored with NO leading `\s*`: only a truly column-0 (module-level)
  // declaration counts. Without this, a same-named `const NAME = '<literal>'`
  // declared inside an unrelated function anywhere else in the file (any
  // indentation) would be collected into the same flat, unscoped map and
  // wrongly inlined at a genuinely dynamic use site elsewhere in the file —
  // e.g. a local `const term = 'x'` inside a helper silently defeats
  // detection of `new RegExp(term, 'i')` in an unrelated exported function
  // that takes `term` as a runtime parameter of the same name.
  const re = /^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=\s*(['"`])/gm
  let m
  while ((m = re.exec(stripped))) {
    const quoteIdx = m.index + m[0].length - 1
    const end = m[2] === '`' ? skipTemplate(stripped, quoteIdx) : skipQuoted(stripped, quoteIdx)
    const body = stripped.slice(quoteIdx + 1, end - 1)
    const rest = stripped.slice(end).match(/^[^\n]*/)[0]
    if (rest.trim().length > 0) continue // not a lone literal initialiser
    if (m[2] === '`' && body.includes('${')) continue // interpolated => not constant
    out.set(m[1], body)
    re.lastIndex = end
  }
  return out
}

/**
 * Reduce a `new RegExp` pattern EXPRESSION to `{ text, dynamic }`, where
 * `text` is the regex source with every runtime-dependent chunk replaced
 * by `DYN`. Module-level string constants from `consts` are inlined, so
 * a pattern built purely from them comes back `dynamic: false`.
 */
function patternInfo(expr, consts) {
  let text = ''
  let dynamic = false
  let i = 0
  const pushDyn = () => {
    if (!text.endsWith(DYN)) text += DYN
    dynamic = true
  }
  while (i < expr.length) {
    const c = expr[i]
    if (/\s/.test(c) || c === '+' || c === '(' || c === ')') {
      i++
      continue
    }
    if (c === "'" || c === '"') {
      const end = skipQuoted(expr, i)
      text += expr.slice(i + 1, end - 1)
      i = end
      continue
    }
    if (c === '`') {
      const end = skipTemplate(expr, i)
      const inner = expr.slice(i + 1, end - 1)
      let k = 0
      while (k < inner.length) {
        if (inner[k] === '\\') {
          text += inner.slice(k, k + 2)
          k += 2
          continue
        }
        if (inner[k] === '$' && inner[k + 1] === '{') {
          const close = skipBalanced(inner, k + 1, '{', '}')
          const sub = patternInfo(inner.slice(k + 2, close - 1), consts)
          text += sub.text
          if (sub.dynamic) dynamic = true
          k = close
          continue
        }
        text += inner[k]
        k++
      }
      i = end
      continue
    }
    const idm = /^[A-Za-z_$][\w$]*/.exec(expr.slice(i))
    if (idm) {
      const name = idm[0]
      let j = i + name.length
      while (j < expr.length && /\s/.test(expr[j])) j++
      if (expr[j] === '(') {
        // A call: always runtime-dependent (escapeRegExp(term), …).
        i = skipBalanced(expr, j)
        pushDyn()
        continue
      }
      if (consts.has(name) && expr[j] !== '.' && expr[j] !== '[') {
        text += consts.get(name)
        i = j
        continue
      }
      i = j
      pushDyn()
      continue
    }
    i++
    pushDyn()
  }
  return { text, dynamic }
}

/** `\\p{L}` (as written inside a JS string) → `\p{L}`, `\\b` → `\b`, … */
function unescapeSource(text) {
  return text.replace(/\\\\/g, '\\')
}

/** Does `seg` (regex source, left of the dynamic part) assert a left boundary? */
function hasLeftAnchor(seg) {
  const s = unescapeSource(seg)
  if (/\(\?<[=!]/.test(s)) return true
  if (/\\[bB]/.test(s)) return true
  // `^` is an anchor unless it is the negation inside `[^…]`.
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '^' && s[i - 1] !== '[' && s[i - 1] !== '\\') return true
  }
  return false
}

/** Does `seg` (regex source, right of the dynamic part) assert a right boundary? */
function hasRightAnchor(seg) {
  const s = unescapeSource(seg)
  if (/\(\?[=!]/.test(s)) return true
  if (/\\[bB]/.test(s)) return true
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '$' && s[i - 1] !== '\\') return true
  }
  return false
}

/** Is `text` bounded on BOTH sides of its runtime-dependent span? */
function isAnchored(text) {
  const first = text.indexOf(DYN)
  if (first === -1) return true
  const last = text.lastIndexOf(DYN)
  return hasLeftAnchor(text.slice(0, first)) && hasRightAnchor(text.slice(last + 1))
}

// ─── rule 1: unanchored surgery ──────────────────────────────────────

/**
 * Name of the function enclosing `idx`, looked up by scanning backwards
 * for the nearest `function NAME(` / `const NAME = (`/`async (`/`function`.
 * Used to follow the helper shape
 * `function build(t) { return new RegExp(…) }` … `s.replace(build(x), …)`.
 */
function enclosingFunctionName(stripped, idx) {
  const head = stripped.slice(0, idx)
  const re =
    /(?:function\s+([A-Za-z_$][\w$]*)\s*[(<]|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]*)?=\s*(?:async\s*)?(?:function\b|\())/g
  let last = null
  let m
  while ((m = re.exec(head))) last = m[1] ?? m[2]
  return last
}

/** Every `.replace(`/`.replaceAll(` first-argument text in the file. */
function replaceFirstArgs(stripped) {
  const out = []
  const re = /\.\s*(?:replace|replaceAll)\s*\(/g
  let m
  while ((m = re.exec(stripped))) {
    const open = m.index + m[0].length - 1
    const { args } = readCallArgs(stripped, open)
    if (args.length > 0) out.push(args[0].trim())
  }
  return out
}

function scanUnanchoredSurgery(stripped, consts, lineOf) {
  const found = []
  const firstArgs = replaceFirstArgs(stripped)
  const boundToReplace = new Set()
  const calledInReplace = new Set()
  for (const a of firstArgs) {
    const ident = /^([A-Za-z_$][\w$]*)\s*(\(?)/.exec(a)
    if (!ident) continue
    if (ident[2] === '(') calledInReplace.add(ident[1])
    else if (a === ident[1]) boundToReplace.add(ident[1])
  }

  const re = /\bnew\s+RegExp\s*\(/g
  let m
  while ((m = re.exec(stripped))) {
    const open = m.index + m[0].length - 1
    const { end, args } = readCallArgs(stripped, open)
    re.lastIndex = end
    if (args.length === 0) continue
    const info = patternInfo(args[0], consts)
    if (!info.dynamic) continue
    if (isAnchored(info.text)) continue

    // Is the compiled regex used to rewrite a string?
    const before = stripped.slice(Math.max(0, m.index - 60), m.index)
    const inlineReplace = /\.\s*(?:replace|replaceAll)\s*\(\s*$/.test(before)
    const binding = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]*)?=\s*$/.exec(before)
    const isReturned = /(?:return|=>)\s*$/.test(before)
    let surgery = inlineReplace
    let via = 'inline `.replace(new RegExp(…))`'
    if (!surgery && binding && boundToReplace.has(binding[1])) {
      surgery = true
      via = `bound to \`${binding[1]}\`, used in \`.replace(${binding[1]}, …)\``
    }
    if (!surgery && isReturned) {
      const fn = enclosingFunctionName(stripped, m.index)
      if (fn && calledInReplace.has(fn)) {
        surgery = true
        via = `returned from \`${fn}()\`, used in \`.replace(${fn}(…), …)\``
      }
    }
    if (!surgery) continue

    found.push({
      rule: 'unanchored-surgery',
      line: lineOf(m.index),
      detail: `unanchored dynamic pattern ${JSON.stringify(args[0].trim())} — ${via}`,
    })
  }
  return found
}

// ─── rule 2: error-message substring branching ───────────────────────

/** Local bindings initialised from an error message (`err.message`, `String(err)`). */
function errorDerivedNames(stripped) {
  const out = new Set()
  const re = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=\s*([^\n;]*)/g
  let m
  while ((m = re.exec(stripped))) {
    const rhs = m[2]
    if (/\.\s*message\b/.test(rhs) || /\bString\s*\(\s*[A-Za-z_$][\w$]*\s*\)/.test(rhs)) {
      out.add(m[1])
    }
  }
  return out
}

function scanErrorMessageSubstring(stripped, lineOf) {
  const found = []
  const seen = new Set()
  const push = (idx, detail) => {
    const line = lineOf(idx)
    const key = `${line}`
    if (seen.has(key)) return
    seen.add(key)
    found.push({ rule: 'error-message-substring', line, detail })
  }

  const derived = errorDerivedNames(stripped)
  if (derived.size > 0) {
    const names = [...derived].map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
    const re = new RegExp(`\\b(${names})\\s*\\.\\s*(includes|indexOf)\\s*\\(\\s*(['"\`])`, 'g')
    let m
    while ((m = re.exec(stripped))) {
      push(m.index, `\`${m[1]}.${m[2]}('…')\` branches on an error-message substring`)
    }
  }

  // Direct forms with no intermediate binding.
  const direct =
    /(?:\.\s*message|String\s*\(\s*[A-Za-z_$][\w$]*\s*\))\s*(?:\.\s*toLowerCase\s*\(\s*\)\s*)?\.\s*(includes|indexOf)\s*\(\s*(['"`])/g
  let d
  while ((d = direct.exec(stripped))) {
    push(d.index, `\`.${d[1]}('…')\` branches directly on an error-message substring`)
  }
  return found
}

// ─── rule 3: boundary class without combining marks ──────────────────

const LETTERISH_RE = /\\p\{(?:L|Letter|Lu|Ll|Lt|Lm|Lo|N|Number|Nd|Nl|No|Alpha|Alphabetic)\}/
const MARK_RE = /\\p\{(?:M|Mark|Mn|Mc|Me)\}/

function scanIncompleteBoundaryClass(stripped, lineOf) {
  const found = []
  const seen = new Set()
  const re = /\[(?:\\.|[^\]\\])*\]/g
  let m
  while ((m = re.exec(stripped))) {
    const body = unescapeSource(m[0])
    if (!LETTERISH_RE.test(body)) continue
    if (MARK_RE.test(body)) continue
    const line = lineOf(m.index)
    if (seen.has(line)) continue
    seen.add(line)
    found.push({
      rule: 'incomplete-boundary-class',
      line,
      detail: `class ${m[0]} matches letters/digits but not \`\\p{M}\` (combining marks)`,
    })
  }
  return found
}

// ─── analysis ────────────────────────────────────────────────────────

/**
 * Scan one file's source. Returns violations `{ rule, line, detail }`,
 * already filtered by `// content-regex-allow:` markers. Pure over a
 * string so the self-test can drive it directly.
 */
export function scanSource(src) {
  const stripped = stripComments(src)
  const lineOf = makeLineLookup(stripped)
  const consts = collectStringConsts(stripped)
  const markers = allowMarkerLines(src)
  const all = [
    ...scanUnanchoredSurgery(stripped, consts, lineOf),
    ...scanErrorMessageSubstring(stripped, lineOf),
    ...scanIncompleteBoundaryClass(stripped, lineOf),
  ]
  return all.filter((v) => !isMarked(markers, v.line)).toSorted((a, b) => a.line - b.line)
}

/**
 * Scan `srcDir` and diff the per-(file, rule) violation counts against
 * `baseline`. Returns `{ sites, counts, added, stale, scanned }`.
 * Pure over the filesystem so the self-test can drive it against a
 * synthetic tree.
 */
export function analyze({ root, srcDir, baseline }) {
  const sites = []
  const counts = new Map()
  let scanned = 0
  for (const file of listSourceFiles(srcDir)) {
    scanned += 1
    const rel = toPosix(path.relative(root, file))
    for (const v of scanSource(fs.readFileSync(file, 'utf8'))) {
      sites.push({ file: rel, ...v })
      const key = `${rel}|${v.rule}`
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
  }

  const baseCounts = new Map()
  for (const e of baseline) baseCounts.set(`${e.file}|${e.rule}`, e.count)

  const added = []
  for (const [key, live] of counts) {
    const base = baseCounts.get(key) ?? 0
    if (live > base) {
      const [file, rule] = key.split('|')
      added.push({ file, rule, live, base })
    }
  }
  const stale = []
  for (const [key, base] of baseCounts) {
    const live = counts.get(key) ?? 0
    if (live < base) {
      const [file, rule] = key.split('|')
      stale.push({ file, rule, live, base })
    }
  }
  const byFileRule = (a, b) => a.file.localeCompare(b.file) || a.rule.localeCompare(b.rule)
  return {
    sites,
    counts,
    added: added.toSorted(byFileRule),
    stale: stale.toSorted(byFileRule),
    scanned,
  }
}

// ─── baseline I/O ────────────────────────────────────────────────────

function readBaseline() {
  if (!fs.existsSync(BASELINE_FILE)) return []
  const raw = JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8'))
  if (!Array.isArray(raw)) throw new Error(`baseline file is not a JSON array: ${BASELINE_FILE}`)
  return raw
}

/** Structural + "must carry a reason" validation. Returns a list of problems. */
export function validateBaseline(baseline) {
  const problems = []
  const seen = new Set()
  for (const e of baseline) {
    const label = JSON.stringify(e)
    if (!e || typeof e.file !== 'string' || typeof e.rule !== 'string') {
      problems.push(`malformed entry (needs string \`file\` and \`rule\`): ${label}`)
      continue
    }
    if (!RULES.includes(e.rule)) problems.push(`unknown rule "${e.rule}" in entry: ${label}`)
    if (!Number.isInteger(e.count) || e.count < 1) {
      problems.push(`\`count\` must be a positive integer: ${label}`)
    }
    if (typeof e.reason !== 'string' || e.reason.trim().length === 0) {
      problems.push(
        `entry has no \`reason\` — every baselined violation must be justified: ${label}`,
      )
    }
    const key = `${e.file}|${e.rule}`
    if (seen.has(key)) problems.push(`duplicate entry for ${e.file} / ${e.rule}`)
    seen.add(key)
  }
  return problems
}

function writeBaseline(entries) {
  fs.writeFileSync(BASELINE_FILE, `${JSON.stringify(entries, null, 2)}\n`)
}

// ─── entry point ─────────────────────────────────────────────────────

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)

if (isMain) {
  if (process.argv.includes('--self-test')) runSelfTest()
  else if (process.argv.includes('--update-baseline')) updateBaseline()
  else runGuard()
}

function requireSrc() {
  if (!fs.existsSync(SRC_DIR)) {
    console.error(`ERROR: expected directory not found (repo layout changed?): ${SRC_DIR}`)
    process.exit(2)
  }
}

function updateBaseline() {
  requireSrc()
  const previous = fs.existsSync(BASELINE_FILE) ? readBaseline() : []
  const reasons = new Map(previous.map((e) => [`${e.file}|${e.rule}`, e.reason ?? '']))
  const { counts } = analyze({ root: ROOT, srcDir: SRC_DIR, baseline: [] })
  const entries = [...counts.entries()]
    .map(([key, count]) => {
      const [file, rule] = key.split('|')
      return { file, rule, count, reason: reasons.get(key) ?? '' }
    })
    .toSorted((a, b) => a.file.localeCompare(b.file) || a.rule.localeCompare(b.rule))
  writeBaseline(entries)
  const missing = entries.filter((e) => e.reason.trim().length === 0)
  console.log(
    `OK: wrote baseline with ${entries.length} entr(ies) to ${path.relative(ROOT, BASELINE_FILE)}`,
  )
  if (missing.length > 0) {
    console.log('')
    console.log(`${missing.length} new entr(ies) have an EMPTY reason. The guard fails until each`)
    console.log('one says why the violation is acceptable (or the code is fixed instead):')
    for (const e of missing) console.log(`  ${e.file}  [${e.rule}]`)
  }
}

function runGuard() {
  requireSrc()

  let baseline
  try {
    baseline = readBaseline()
  } catch (err) {
    console.error(`ERROR: ${err.message}`)
    process.exit(2)
  }
  const problems = validateBaseline(baseline)
  if (problems.length > 0) {
    console.error(`ERROR: ${path.relative(ROOT, BASELINE_FILE)} is not usable:`)
    for (const p of problems) console.error(`  ${p}`)
    process.exit(2)
  }

  const { sites, added, stale, scanned } = analyze({ root: ROOT, srcDir: SRC_DIR, baseline })
  let failed = false

  if (added.length > 0) {
    failed = true
    console.error('ERROR: new unanchored/locale-fragile content-matching in app code:')
    for (const a of added) {
      console.error(`  ${a.file}  [${a.rule}]  ${a.base} baselined -> ${a.live} live`)
      for (const site of sites.filter((v) => v.file === a.file && v.rule === a.rule)) {
        console.error(`    ${a.file}:${site.line}  ${site.detail}`)
      }
    }
    console.error('')
    console.error("Rewriting a user's prose with a matcher built from a runtime string corrupts")
    console.error('durable data when the term is a substring of a longer word (#3313: page "Note"')
    console.error('turned "Notebook shopping list" into "[[id]]book shopping list").')
    console.error('')
    console.error('Fix, in order of preference:')
    console.error('  1. Operate on the parsed ProseMirror document, not the serialized text.')
    console.error('  2. If a regex is unavoidable, bound BOTH sides explicitly and include')
    console.error('     combining marks in the boundary class, then add a substring-collision')
    console.error('     test (`Note` vs `Notebook`) and an NFD test (`cafe` vs `caf`+`e`+U+0301):')
    console.error('')
    console.error(
      '         new RegExp(`(?<![\\\\p{L}\\\\p{N}\\\\p{M}_])${escapeRegExp(t)}(?![\\\\p{L}\\\\p{N}\\\\p{M}_])`, "iu")',
    )
    console.error('')
    console.error('  3. For error classification, branch on a structured code, not on a substring')
    console.error('     of a locale-dependent message.')
    console.error('')
    console.error('If the site is genuinely safe (a pattern built from compile-time constants that')
    console.error('cannot collide), mark it at the call site:')
    console.error('')
    console.error('         // content-regex-allow: <why this cannot splice user content>')
    console.error('')
    console.error('Grandfathering an unfixable site instead: `--update-baseline`, then fill in the')
    console.error('`reason` field it leaves empty.')
  }

  if (stale.length > 0) {
    failed = true
    console.error('ERROR: stale entr(ies) in the content-regex baseline — these sites were fixed')
    console.error('or removed, so the baseline must ratchet down to the new floor:')
    for (const s of stale) {
      console.error(`  ${s.file}  [${s.rule}]  ${s.base} baselined -> ${s.live} live`)
    }
    console.error('')
    console.error(
      'Re-anchor with:  node scripts/check-unanchored-content-regex.mjs --update-baseline',
    )
  }

  if (failed) process.exit(1)

  console.log(
    `OK: ${scanned} file(s) scanned, ${sites.length} baselined violation(s), no new ones, no stale entries`,
  )
}

// ─── self-test ───────────────────────────────────────────────────────
//
// Drives analyze() and validateBaseline() against a synthetic src tree
// written to a temp directory, so every rule is proved to FIRE on a
// violating fixture and to STAY QUIET on the legitimate counterpart.
// Nothing here reads the real repo, and the fixtures live outside the
// scanned tree, so no assertion can be satisfied by this file itself.
function runSelfTest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'content-regex-selftest-'))
  const failures = []
  const ok = (name) => console.log(`  ok   - ${name}`)
  const fail = (name, detail) => {
    failures.push(name)
    console.error(`  FAIL - ${name}: ${detail}`)
  }

  try {
    const srcDir = path.join(tmp, 'src')
    const libDir = path.join(srcDir, 'lib')
    const compDir = path.join(srcDir, 'components')
    const testDir = path.join(compDir, '__tests__')
    for (const d of [libDir, compDir, testDir]) fs.mkdirSync(d, { recursive: true })
    const w = (dir, name, body) => fs.writeFileSync(path.join(dir, name), body)

    // ── rule 1: unanchored surgery ────────────────────────────────────

    // The literal pre-#3313 shape → violation.
    w(
      compDir,
      'BadSurgery.tsx',
      [
        'function escapeRegExp(s: string) { return s }',
        'export function linkIt(content: string, term: string, id: string) {',
        "  const regex = new RegExp(escapeRegExp(term), 'i')",
        '  return content.replace(regex, `[[${id}]]`)',
        '}',
      ].join('\n'),
    )
    // The #3313 FIXED shape (both-sided lookarounds, `\p{M}` included) → clean.
    w(
      compDir,
      'GoodSurgery.tsx',
      [
        'function escapeRegExp(s: string) { return s }',
        'function buildBoundaryRegex(term: string): RegExp {',
        '  return new RegExp(',
        '    `(?<![\\\\p{L}\\\\p{N}\\\\p{M}_])${escapeRegExp(term)}(?![\\\\p{L}\\\\p{N}\\\\p{M}_])`,',
        "    'iu',",
        '  )',
        '}',
        'export function linkIt(content: string, term: string, id: string) {',
        '  return content.replace(buildBoundaryRegex(term), `[[${id}]]`)',
        '}',
      ].join('\n'),
    )
    // Anchored on the LEFT only — still splices on the right → violation.
    w(
      compDir,
      'HalfAnchored.tsx',
      [
        'function escapeRegExp(s: string) { return s }',
        'export function linkIt(content: string, term: string) {',
        "  const re = new RegExp(`\\\\b${escapeRegExp(term)}`, 'i')",
        "  return content.replace(re, 'x')",
        '}',
      ].join('\n'),
    )
    // Inline `.replace(new RegExp(…))` → violation.
    w(
      compDir,
      'DirectReplace.tsx',
      [
        'function escapeRegExp(s: string) { return s }',
        'export const strip = (text: string, t: string) =>',
        "  text.replace(new RegExp(escapeRegExp(t), 'g'), '')",
      ].join('\n'),
    )
    // Unanchored dynamic regex used only for MATCHING → clean (not surgery).
    w(
      libDir,
      'read-only.ts',
      [
        'export function findIt(haystack: string, query: string, flags: string) {',
        '  const re = new RegExp(query, flags)',
        '  return re.test(haystack)',
        '}',
      ].join('\n'),
    )
    // Pattern built from a module-level string CONSTANT → clean (static by
    // construction — the `enex-import.ts` sentinel shape).
    w(
      libDir,
      'sentinels.ts',
      [
        "const CRYPT_SENTINEL = '\\uE004'",
        'export function restore(md: string) {',
        "  return md.replace(new RegExp(CRYPT_SENTINEL, 'g'), '[encrypted]')",
        '}',
      ].join('\n'),
    )
    // The bad shape, but entirely inside comments → clean.
    w(
      compDir,
      'Commented.tsx',
      [
        "// const regex = new RegExp(escapeRegExp(term), 'i')",
        "/** was: content.replace(new RegExp(escapeRegExp(t), 'g'), '') */",
        'export const C = () => null',
      ].join('\n'),
    )
    // Marked with a reason → clean.
    w(
      compDir,
      'Marked.tsx',
      [
        'function escapeRegExp(s: string) { return s }',
        'export const strip = (text: string, t: string) =>',
        '  // content-regex-allow: t is a fixed protocol token, never user prose',
        "  text.replace(new RegExp(escapeRegExp(t), 'g'), '')",
      ].join('\n'),
    )
    // Marker with an EMPTY reason → still a violation.
    w(
      compDir,
      'MarkedNoReason.tsx',
      [
        'function escapeRegExp(s: string) { return s }',
        'export const strip = (text: string, t: string) =>',
        '  // content-regex-allow:',
        "  text.replace(new RegExp(escapeRegExp(t), 'g'), '')",
      ].join('\n'),
    )
    // Test file carrying the bad shape → not scanned at all.
    w(
      testDir,
      'Ignored.test.tsx',
      [
        'function escapeRegExp(s: string) { return s }',
        "it('collides', () => {",
        "  const re = new RegExp(escapeRegExp('Note'), 'i')",
        "  expect('Notebook'.replace(re, 'X')).toBe('Xbook')",
        '})',
      ].join('\n'),
    )

    // ── rule 2: error-message substring branching ─────────────────────

    w(
      libDir,
      'categorize.ts',
      [
        "export function categorize(err: unknown): 'network' | 'unknown' {",
        '  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase()',
        "  if (msg.includes('network')) return 'network'",
        "  return 'unknown'",
        '}',
      ].join('\n'),
    )
    w(
      libDir,
      'direct-message.ts',
      [
        'export function isTimeout(err: Error) {',
        "  return err.message.includes('timeout')",
        '}',
      ].join('\n'),
    )
    // Array membership + non-literal argument → clean.
    w(
      libDir,
      'membership.ts',
      [
        "const OPTIONS = ['a', 'b']",
        'export function pick(value: string, evt: { data: string }, needle: string) {',
        '  const msg = evt.data',
        '  return OPTIONS.includes(value) && msg.includes(needle)',
        '}',
      ].join('\n'),
    )

    // ── rule 3: boundary class without combining marks ────────────────

    w(libDir, 'word-re.ts', ['export const WORD_RE = /[\\p{L}\\p{N}_]/u'].join('\n'))
    w(
      libDir,
      'tag-re.ts',
      ['export const TAG_RE = /(^|[^\\p{L}\\p{N}_])#([\\p{L}\\p{N}_]+)/gu'].join('\n'),
    )
    w(libDir, 'word-re-ok.ts', ['export const WORD_RE = /[\\p{L}\\p{N}\\p{M}_]/u'].join('\n'))

    // ── baseline behaviour ────────────────────────────────────────────

    w(
      compDir,
      'Baselined.tsx',
      [
        'function escapeRegExp(s: string) { return s }',
        'export const strip = (text: string, t: string) =>',
        "  text.replace(new RegExp(escapeRegExp(t), 'g'), '')",
      ].join('\n'),
    )
    w(libDir, 'fixed.ts', ['export const NOTHING = 1'].join('\n'))

    const baseline = [
      {
        file: 'src/components/Baselined.tsx',
        rule: 'unanchored-surgery',
        count: 1,
        reason: 'grandfathered',
      },
      { file: 'src/lib/fixed.ts', rule: 'unanchored-surgery', count: 1, reason: 'already fixed' },
    ]
    const { sites, added, stale } = analyze({ root: tmp, srcDir, baseline })
    const hit = (file, rule) => sites.some((s) => s.file === `src/${file}` && s.rule === rule)
    const R1 = 'unanchored-surgery'
    const R2 = 'error-message-substring'
    const R3 = 'incomplete-boundary-class'

    const expect = (name, cond, detail) => (cond ? ok(name) : fail(name, detail))

    expect(
      'pre-#3313 shape (bound regex + content.replace) is flagged',
      hit('components/BadSurgery.tsx', R1),
      JSON.stringify(sites),
    )
    expect(
      'fixed #3313 shape (both-sided lookarounds incl. \\p{M}) is NOT flagged',
      !sites.some((s) => s.file === 'src/components/GoodSurgery.tsx'),
      JSON.stringify(sites.filter((s) => s.file === 'src/components/GoodSurgery.tsx')),
    )
    expect(
      'left-anchored-only pattern is flagged (both sides required)',
      hit('components/HalfAnchored.tsx', R1),
      JSON.stringify(sites),
    )
    expect(
      'inline `.replace(new RegExp(…))` is flagged',
      hit('components/DirectReplace.tsx', R1),
      JSON.stringify(sites),
    )
    expect(
      'unanchored dynamic regex used only for matching is NOT flagged',
      !hit('lib/read-only.ts', R1),
      'read-only.ts flagged',
    )
    expect(
      'pattern built from a module-level string const is NOT flagged',
      !hit('lib/sentinels.ts', R1),
      'sentinels.ts flagged',
    )
    expect(
      'commented-out bad shape is NOT flagged',
      !hit('components/Commented.tsx', R1),
      'Commented.tsx flagged',
    )
    expect(
      'site with a reasoned content-regex-allow marker is NOT flagged',
      !hit('components/Marked.tsx', R1),
      'Marked.tsx flagged',
    )
    expect(
      'content-regex-allow marker with an empty reason does NOT suppress',
      hit('components/MarkedNoReason.tsx', R1),
      JSON.stringify(sites),
    )
    expect(
      'test files are not scanned',
      !sites.some((s) => s.file.includes('__tests__')),
      JSON.stringify(sites.filter((s) => s.file.includes('__tests__'))),
    )

    expect(
      'error-message substring branch via a local binding is flagged',
      hit('lib/categorize.ts', R2),
      JSON.stringify(sites),
    )
    expect(
      'direct `err.message.includes(...)` is flagged',
      hit('lib/direct-message.ts', R2),
      JSON.stringify(sites),
    )
    expect(
      'array membership / non-literal argument is NOT flagged',
      !hit('lib/membership.ts', R2),
      'membership.ts flagged',
    )

    expect(
      'boundary class omitting \\p{M} is flagged',
      hit('lib/word-re.ts', R3),
      JSON.stringify(sites),
    )
    expect(
      'negated boundary class omitting \\p{M} is flagged',
      hit('lib/tag-re.ts', R3),
      JSON.stringify(sites),
    )
    expect(
      'boundary class including \\p{M} is NOT flagged',
      !hit('lib/word-re-ok.ts', R3),
      'word-re-ok.ts flagged',
    )

    expect(
      'baselined violation does not count as new',
      !added.some((a) => a.file === 'src/components/Baselined.tsx'),
      JSON.stringify(added),
    )
    expect(
      'un-baselined violation counts as new',
      added.some((a) => a.file === 'src/components/BadSurgery.tsx' && a.rule === R1),
      JSON.stringify(added),
    )
    expect(
      'stale baseline entry (site fixed) is flagged',
      stale.some((s) => s.file === 'src/lib/fixed.ts'),
      JSON.stringify(stale),
    )

    // validateBaseline
    const noReason = validateBaseline([{ file: 'a.ts', rule: R1, count: 1, reason: '   ' }])
    expect(
      'baseline entry without a reason is rejected',
      noReason.length === 1 && /no `reason`/.test(noReason[0]),
      JSON.stringify(noReason),
    )
    const badRule = validateBaseline([{ file: 'a.ts', rule: 'nope', count: 1, reason: 'x' }])
    expect(
      'baseline entry with an unknown rule is rejected',
      badRule.length === 1,
      JSON.stringify(badRule),
    )
    const dup = validateBaseline([
      { file: 'a.ts', rule: R1, count: 1, reason: 'x' },
      { file: 'a.ts', rule: R1, count: 1, reason: 'y' },
    ])
    expect('duplicate baseline entry is rejected', dup.length === 1, JSON.stringify(dup))
    expect(
      'a well-formed baseline entry is accepted',
      validateBaseline([{ file: 'a.ts', rule: R1, count: 2, reason: 'why' }]).length === 0,
      'well-formed entry rejected',
    )
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }

  if (failures.length > 0) {
    console.error(`\nself-test: ${failures.length} assertion(s) failed`)
    process.exit(2)
  }
  console.log('self-test: all assertions passed')
}
