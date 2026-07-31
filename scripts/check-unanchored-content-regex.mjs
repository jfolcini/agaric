#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────
// Unanchored-content-regex guard (#3348, theme T4 "text treated as
// structure"; AST reachability added in #3369).
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
//    A `new RegExp(<pattern>, …)` (or a bare `RegExp(<pattern>, …)`)
//    where
//      (a) `<pattern>` is DYNAMIC — after constant-folding every
//          statically-known string binding (see "Static by construction"
//          below), the pattern still depends on a runtime value (an
//          unresolved identifier, a call, a template interpolation); AND
//      (b) the pattern carries no explicit boundary on BOTH sides of the
//          dynamic part — left: `^`, `\b`, `\B`, `(?<=`, `(?<!`;
//          right: `$`, `\b`, `\B`, `(?=`, `(?!`. A half-anchored
//          pattern (`\b${term}`) still splices on the other side, so
//          both sides are required; AND
//      (c) the compiled regex REACHES a `.replace(` / `.replaceAll(`
//          first argument, i.e. it is used for SURGERY.
//
//    (c) is what keeps this guard usable. Read-only matching — in-page
//    find, glob validation, highlight ranges — legitimately compiles
//    unanchored dynamic regexes all over this codebase; a wrong match
//    there paints a wrong highlight (visible, transient), while a wrong
//    replace corrupts durable data. Only the second is banned.
//
//    Reachability for (c) is a value-flow fixpoint over the file's AST
//    with real lexical binding resolution (see "Why an AST" below), so
//    it follows the regex through variable declarations, bare
//    reassignments, call arguments into local functions, returns,
//    object properties, destructuring and array elements — not just the
//    three textual spellings the first version could see.
//
// 2. `error-message-substring`
//    `X.includes('literal')` / `X.indexOf('literal')` where `X` is
//    derived from an error MESSAGE (`.message`, `String(err)`, or a
//    binding whose initialiser is either, resolved through the real
//    scope chain). Platform and backend error strings are locale- and
//    version-dependent, so branching on a hard-coded English fragment is
//    a silently-decaying classifier — `src/lib/categorize-history-error.ts`
//    is the cited case. Array membership (`OPTIONS.includes(value)`) is
//    untouched: the receiver must be error-message-derived AND the
//    argument must be a string literal.
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
// ─── Why an AST (#3369) ─────────────────────────────────────────────
//
// The first version (#3348) followed the regex textually and could only
// see three spellings: inline, `const re = …` + `.replace(re, …)`, and
// `return new RegExp(…)` + `.replace(build(x), …)`. A reviewer built
// four genuinely-corrupting shapes it exits 0 on — a bare reassignment
// (`let re; re = new RegExp(…)`), a regex passed as a call argument, one
// stashed in an object property, and one stashed in an array element.
// Sharing persist/regex option boilerplate is an ordinary refactor, so
// the guard could be defeated with zero signal, which is worse than no
// guard because it is trusted.
//
// Rules 1 and 2 are therefore evaluated on a real AST parsed with
// `@babel/core` (a direct devDependency) and resolved with Babel's
// scope/binding model. That closes all four shapes, removes the
// unscoped whole-file `const`/`let`/`var` collection that both rules
// used (a same-named local binding elsewhere in the file could feed the
// wrong value into either rule), and makes `// content-regex-allow:`
// markers come from real comment tokens rather than a textual sweep of
// the source, so a marker-shaped substring inside a multi-line string
// cannot suppress a violation.
//
// TypeScript's own compiler API is NOT used: as of TypeScript 7 (the
// native port, which is what this repo pins) the JS package exports only
// `version`, and the `typescript/unstable/*` entry points reach an
// out-of-process `tsgo` server whose AST is exposed as IPC node handles
// with no single-file parse entry point at all. Measured on this repo:
// walking a program that way needs a loaded project (1559 files) and one
// round trip per node, versus 137 ms to load `@babel/core` in-process
// and ~0.5 ms to parse and analyse a file. Binding resolution WITHIN a
// file needs no type checker, and the guard has never followed a regex
// across module boundaries, so nothing is lost.
//
// Rule 3 stays a textual scan on purpose. It is purely syntactic — it
// inspects the characters of a regex character class and has no
// binding-resolution or reachability component — so an AST would look at
// the same literal text for the same answer. Keeping it textual is also
// what lets the guard skip parsing the ~730 files that contain no
// `RegExp`, no `.includes(`/`.indexOf(` and no allow-marker.
//
// ─── Static by construction (why enex-import is not flagged) ────────
//
// Rule 1 constant-folds the pattern expression before deciding whether
// it is dynamic. `src/lib/enex-import.ts` replaces Private-Use-Area
// sentinels it injected itself (`const CRYPT_SENTINEL = '\uE004'` …,
// then `.replace(new RegExp(CRYPT_SENTINEL, 'g'), …)`). The pattern is a
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
//    suppress anything. The marker is only honoured when it is a real
//    `//` comment token, so the same text inside a string cannot
//    suppress anything either.
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
//   - Analysis is per-file. A regex exported to another module and
//     replaced there is not tracked; neither is one handed to an
//     unresolved callee (an imported helper, a callback parameter).
//   - Object-property and unresolved array-element slots are keyed by
//     property name / "some array" rather than by object identity, so
//     reachability through them is an OVER-approximation. That direction
//     costs recall nothing and has been checked to add no findings
//     across the scanned tree; if it ever misfires, the site marker is
//     the escape hatch.
//   - A pattern bounded by an ordinary literal character rather than an
//     assertion (`${term}\\]\\]`) is reported; use the marker.
//   - Rule 3's comment stripping is textual: a `//` inside a regex
//     literal or string truncates the rest of that line, which can only
//     cause a missed violation, never a false one.
//   - A file under `src/` that does not parse is a hard error (exit 2),
//     never a silent skip.
//
// The guard walks `src/` only, and its own fixtures live in a temp
// directory created by `--self-test`, so nothing here can match itself;
// `--self-test` asserts both of those properties rather than assuming
// them.
//
// Usage: node scripts/check-unanchored-content-regex.mjs
//        node scripts/check-unanchored-content-regex.mjs --update-baseline
//        node scripts/check-unanchored-content-regex.mjs --self-test
// Exit:  0 = clean, 1 = new violation or stale baseline entry,
//        2 = repo layout / malformed baseline / unparseable source /
//            self-test failure.
// ─────────────────────────────────────────────────────────────────────

import fs from 'node:fs'
import { createRequire } from 'node:module'
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
const DYN = ' '

// Cheap gates that decide whether a file is worth parsing, and whether an
// AST is worth walking for a given rule. Each one is matched against the
// RAW source (comments included) and keys on a BARE IDENTIFIER the rule
// cannot fire without: rule 1 needs the global `RegExp` named, rule 2
// needs `includes`/`indexOf` named, and an allow-marker needs its own
// text. Nothing about spacing, punctuation or comments can hide those
// tokens, so a gate can never skip a file that had something to say. Rule
// 3 needs no AST and runs on every file. On this tree the gates take the
// 818 walked files down to 99 parsed and 8 walked for rule 1.
const SURGERY_GATE_RE = /\bRegExp\b/
const SUBSTRING_GATE_RE = /\bincludes\b|\bindexOf\b/
const MARKER_GATE_RE = /content-regex-allow/
const NEEDS_AST_RE = new RegExp(
  [SURGERY_GATE_RE, SUBSTRING_GATE_RE, MARKER_GATE_RE].map((r) => r.source).join('|'),
)

// ─── generic helpers ──────────────────────────────────────────────────

function toPosix(p) {
  return p.split(path.sep).join('/')
}

/**
 * Walk `srcDir` for `*.ts` / `*.tsx`, excluding test files, `__tests__/`
 * and `tests/` directories, and `.d.ts` declarations. Exported so the
 * self-test can prove the walk never leaves `srcDir`.
 */
export function listSourceFiles(srcDir) {
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
 * Used by rule 3 only; rules 1 and 2 see real comment tokens instead.
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

/** `\\p{L}` (as written inside a JS string) → `\p{L}`, `\\b` → `\b`, … */
function unescapeSource(text) {
  return text.replace(/\\\\/g, '\\')
}

/** Is a violation on `line` exempted by a marker on it or the line above? */
function isMarked(markers, line) {
  return markers.has(line) || markers.has(line - 1)
}

/**
 * Line numbers carrying a `// content-regex-allow: <reason>` marker with
 * a NON-EMPTY reason, taken from real `//` comment tokens. A marker-shaped
 * substring inside a string literal is not a comment and suppresses
 * nothing.
 */
function markerLinesFromComments(ast) {
  const out = new Set()
  for (const comment of ast.comments ?? []) {
    if (comment.type !== 'CommentLine') continue
    const m = /^\s*content-regex-allow\s*:\s*(.*)$/.exec(comment.value)
    if (m && m[1].trim().length > 0) out.add(comment.loc.start.line)
  }
  return out
}

// ─── AST layer ────────────────────────────────────────────────────────

let babelCache = null

/**
 * `@babel/core` is loaded lazily and synchronously so that importing this
 * module (for `validateBaseline`, or by the main-module-detection guard)
 * does not pay ~140 ms, and so a tree with nothing to parse pays nothing.
 */
function loadBabel() {
  if (babelCache === null) {
    const require = createRequire(import.meta.url)
    babelCache = require('@babel/core')
  }
  return babelCache
}

/**
 * Parse one TS/TSX source. A parse failure THROWS: every file under
 * `src/` compiles, so an unparseable one means the guard cannot do its
 * job and must say so instead of silently reporting "clean".
 */
function parseSource(code, filename) {
  const { parseSync } = loadBabel()
  const isTsx = filename.endsWith('.tsx')
  try {
    return parseSync(code, {
      filename,
      babelrc: false,
      configFile: false,
      browserslistConfigFile: false,
      cwd: ROOT,
      sourceType: 'module',
      parserOpts: {
        plugins: isTsx ? ['typescript', 'jsx'] : ['typescript'],
        errorRecovery: false,
      },
    })
  } catch (err) {
    throw new Error(`cannot parse ${filename}: ${err.message}`)
  }
}

/** Property name of a non-computed member/property key, or null. */
function keyName(node) {
  if (!node) return null
  if (node.type === 'Identifier') return node.name
  if (node.type === 'StringLiteral') return node.value
  return null
}

/** Stable per-file id for an AST node (used to key binding/function slots). */
function makeUid() {
  const ids = new Map()
  let next = 0
  return (node) => {
    let id = ids.get(node)
    if (id === undefined) {
      next += 1
      id = next
      ids.set(node, id)
    }
    return id
  }
}

/** The function NodePath a call's identifier callee resolves to, or null. */
function resolveFunctionPath(calleePath) {
  if (!calleePath.isIdentifier()) return null
  const binding = calleePath.scope.getBinding(calleePath.node.name)
  if (!binding) return null
  const declared = binding.path
  if (declared.isFunctionDeclaration()) return declared
  if (declared.isVariableDeclarator()) {
    const init = declared.get('init')
    if (init.isArrowFunctionExpression() || init.isFunctionExpression()) return init
  }
  return null
}

// ─── rule 1: unanchored surgery ──────────────────────────────────────

/** Does `seg` (regex source, left of the dynamic part) assert a left boundary? */
function hasLeftAnchor(seg) {
  if (/\(\?<[=!]/.test(seg)) return true
  if (/\\[bB]/.test(seg)) return true
  // `^` is an anchor unless it is the negation inside `[^…]`.
  for (let i = 0; i < seg.length; i++) {
    if (seg[i] === '^' && seg[i - 1] !== '[' && seg[i - 1] !== '\\') return true
  }
  return false
}

/** Does `seg` (regex source, right of the dynamic part) assert a right boundary? */
function hasRightAnchor(seg) {
  if (/\(\?[=!]/.test(seg)) return true
  if (/\\[bB]/.test(seg)) return true
  for (let i = 0; i < seg.length; i++) {
    if (seg[i] === '$' && seg[i - 1] !== '\\') return true
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

/**
 * Reduce a `new RegExp` pattern EXPRESSION to `{ text, dynamic }`, where
 * `text` is the resulting REGEX SOURCE with every runtime-dependent chunk
 * replaced by `DYN`.
 *
 * Static folding runs through Babel's `evaluate()`, which resolves a
 * binding only when it is provably constant in the scope of the USE site
 * — the whole point of moving off the textual, whole-file, column-0
 * `const` sweep the first version used. Because the folded value is the
 * string's COOKED value, `text` is the real regex source: `'\\b'` folds
 * to a backslash + `b` (a word-boundary assertion) while `'\b'` folds to
 * U+0008 (a backspace character, correctly NOT an anchor).
 */
function patternInfo(exprPath) {
  const evaluated = exprPath.evaluate()
  if (evaluated.confident && typeof evaluated.value === 'string') {
    return { text: evaluated.value, dynamic: false }
  }
  if (exprPath.isRegExpLiteral()) {
    return { text: exprPath.node.pattern, dynamic: false }
  }
  if (exprPath.isTemplateLiteral()) {
    const quasis = exprPath.node.quasis
    const exprs = exprPath.get('expressions')
    let text = ''
    let dynamic = false
    for (let i = 0; i < quasis.length; i++) {
      text += quasis[i].value.cooked ?? quasis[i].value.raw
      if (i < exprs.length) {
        const sub = patternInfo(exprs[i])
        text += sub.text
        if (sub.dynamic) dynamic = true
      }
    }
    return { text, dynamic }
  }
  if (exprPath.isBinaryExpression({ operator: '+' })) {
    const left = patternInfo(exprPath.get('left'))
    const right = patternInfo(exprPath.get('right'))
    return { text: left.text + right.text, dynamic: left.dynamic || right.dynamic }
  }
  if (
    exprPath.isTSAsExpression() ||
    exprPath.isTSSatisfiesExpression() ||
    exprPath.isTSNonNullExpression() ||
    exprPath.isTSTypeAssertion()
  ) {
    return patternInfo(exprPath.get('expression'))
  }
  return { text: DYN, dynamic: true }
}

/** Is this `new RegExp(…)` / `RegExp(…)` on the GLOBAL `RegExp`? */
function isRegExpConstruction(callPath) {
  const callee = callPath.get('callee')
  if (!callee.isIdentifier({ name: 'RegExp' })) return false
  // A local binding named `RegExp` is somebody else's function.
  return !callPath.scope.getBinding('RegExp')
}

/**
 * Value-flow slots. A slot is a place a regex value can come to rest and
 * be read back out again:
 *
 *   `bind:<id>`  a resolved lexical binding (const/let/var/param/function)
 *   `prop:<name>`  an object property with that name (name-keyed)
 *   `elem:<id>`  elements of the array held by a resolved binding
 *   `elem:*`     elements of an array whose holder could not be resolved
 *   `ret:<id>`   the return value of a local function
 *
 * Taint (a set of regex-construction ids) is pushed into slots and pulled
 * back out by every expression that reads them, to a fixpoint. A
 * construction is SURGERY iff its id reaches the first argument of a
 * `.replace(` / `.replaceAll(` call.
 */
function scanUnanchoredSurgery(ast, code) {
  const { traverse } = loadBabel()
  const uid = makeUid()

  const constructions = [] // { id, path, line, argText }
  const readers = new Map() // slot -> NodePath[] whose value is that slot
  const edges = new Map() // slot -> Set<slot> (destructuring links)
  const taint = new Map() // slot -> Set<constructionId>
  const surgery = new Map() // constructionId -> { via }

  const addReader = (slot, at) => {
    let list = readers.get(slot)
    if (!list) readers.set(slot, (list = []))
    list.push(at)
  }
  const addEdge = (from, to) => {
    let set = edges.get(from)
    if (!set) edges.set(from, (set = new Set()))
    set.add(to)
  }

  /** Slot for the binding an identifier declares or references, or null. */
  const bindingSlot = (idPath) => {
    if (!idPath || !idPath.isIdentifier()) return null
    const binding = idPath.scope.getBinding(idPath.node.name)
    return binding ? `bind:${uid(binding.identifier)}` : null
  }

  /** Slot for the array-element store of `arr` in `arr[i]` / `const arr = [...]`. */
  const elementSlot = (holderPath) => {
    const slot = bindingSlot(holderPath)
    return slot ? `elem:${slot}` : 'elem:*'
  }

  /** Link every `{ p: local }` / `[local]` pattern binding to its source slot. */
  const linkPattern = (patternPath) => {
    if (patternPath.isObjectPattern()) {
      for (const prop of patternPath.get('properties')) {
        if (prop.isRestElement()) continue
        const name = prop.node.computed ? null : keyName(prop.node.key)
        if (!name) continue
        linkPatternTarget(`prop:${name}`, prop.get('value'))
      }
      return
    }
    if (patternPath.isArrayPattern()) {
      for (const el of patternPath.get('elements')) {
        if (!el || !el.node) continue
        linkPatternTarget('elem:*', el.isRestElement() ? el.get('argument') : el)
      }
    }
  }
  const linkPatternTarget = (fromSlot, targetPath) => {
    if (!targetPath || !targetPath.node) return
    const inner = targetPath.isAssignmentPattern() ? targetPath.get('left') : targetPath
    if (inner.isIdentifier()) {
      const slot = bindingSlot(inner)
      if (slot) addEdge(fromSlot, slot)
      return
    }
    linkPattern(inner)
  }

  /** Does the value of `child` pass through `parent` unchanged? */
  const isTransparent = (parent, child) => {
    if (
      parent.isTSAsExpression() ||
      parent.isTSSatisfiesExpression() ||
      parent.isTSNonNullExpression() ||
      parent.isTSTypeAssertion() ||
      parent.isParenthesizedExpression() ||
      parent.isAwaitExpression()
    ) {
      return true
    }
    if (parent.isConditionalExpression()) return child.key !== 'test'
    if (parent.isLogicalExpression()) return child.key === 'right'
    if (parent.isSequenceExpression()) return child.key === parent.node.expressions.length - 1
    return false
  }

  /** Slots written by `x = <value>` / `x.p = <value>` / `x[i] = <value>`. */
  const assignmentSlots = (left) => {
    if (left.isIdentifier()) {
      const slot = bindingSlot(left)
      return slot ? [slot] : []
    }
    if (left.isMemberExpression()) {
      if (left.node.computed) return [elementSlot(left.get('object'))]
      const name = keyName(left.node.property)
      return name ? [`prop:${name}`] : []
    }
    return []
  }

  /** Slots written by passing a value as argument #`index` of `call`. */
  const argumentSlots = (call, index) => {
    const callee = call.get('callee')
    const isMember = callee.isMemberExpression() || callee.isOptionalMemberExpression()
    const method = isMember && !callee.node.computed ? keyName(callee.node.property) : null
    if ((method === 'replace' || method === 'replaceAll') && index === 0) {
      const argNode = call.node.arguments[0]
      return [
        {
          sink: true,
          line: call.node.loc.start.line,
          argText: code.slice(argNode.start, argNode.end),
        },
      ]
    }
    const fn = resolveFunctionPath(callee)
    if (!fn) return []
    const param = fn.get('params')[index]
    if (!param?.node) return []
    // Destructured parameters are wired up by the static pattern links.
    const inner = param.isAssignmentPattern() ? param.get('left') : param
    if (!inner.isIdentifier()) return []
    const slot = bindingSlot(inner)
    return slot ? [slot] : []
  }

  /**
   * Where does the value produced at `from` flow? Returns slot keys, plus
   * at most one `{ sink }` descriptor when it lands in a `.replace()` first
   * argument.
   */
  const targetsOf = (from) => {
    let cur = from
    for (let hops = 0; hops < 64; hops++) {
      const parent = cur.parentPath
      if (!parent) return []
      if (isTransparent(parent, cur)) {
        cur = parent
        continue
      }
      if (parent.isVariableDeclarator() && cur.key === 'init') {
        const slot = bindingSlot(parent.get('id'))
        return slot ? [slot] : []
      }
      if (parent.isAssignmentExpression() && cur.key === 'right' && parent.node.operator === '=') {
        return assignmentSlots(parent.get('left'))
      }
      if (parent.isObjectProperty() && cur.key === 'value' && !parent.node.computed) {
        const name = keyName(parent.node.key)
        return name ? [`prop:${name}`] : []
      }
      if (parent.isArrayExpression() && cur.listKey === 'elements') {
        const holder = parent.parentPath
        if (holder?.isVariableDeclarator() && holder.node.init === parent.node) {
          const slot = bindingSlot(holder.get('id'))
          return [slot ? `elem:${slot}` : 'elem:*']
        }
        return ['elem:*']
      }
      if (
        parent.isReturnStatement() ||
        (parent.isArrowFunctionExpression() && cur.key === 'body')
      ) {
        const fn = parent.isArrowFunctionExpression() ? parent : parent.getFunctionParent()
        return fn ? [`ret:${uid(fn.node)}`] : []
      }
      if (
        (parent.isCallExpression() ||
          parent.isNewExpression() ||
          parent.isOptionalCallExpression()) &&
        cur.listKey === 'arguments'
      ) {
        return argumentSlots(parent, cur.key)
      }
      return []
    }
    return []
  }

  // `new RegExp(p, f)` and a bare `RegExp(p, f)` build the same object, so
  // both are candidate constructions.
  const collectConstruction = (p) => {
    if (!isRegExpConstruction(p)) return
    if (p.node.arguments.length === 0) return
    const argPath = p.get('arguments.0')
    if (!argPath.isExpression()) return
    const info = patternInfo(argPath)
    if (!info.dynamic) return
    if (isAnchored(info.text)) return
    constructions.push({
      id: constructions.length,
      at: p,
      line: p.node.loc.start.line,
      argText: code.slice(argPath.node.start, argPath.node.end),
    })
  }
  const collectReturnReader = (p) => {
    const fn = resolveFunctionPath(p.get('callee'))
    if (fn) addReader(`ret:${uid(fn.node)}`, p)
  }
  const collectMemberReader = (p) => {
    if (p.node.computed) {
      addReader(elementSlot(p.get('object')), p)
      return
    }
    const name = keyName(p.node.property)
    if (name) addReader(`prop:${name}`, p)
  }

  // NOTE: every node type gets exactly ONE key here. Babel's visitor
  // `explode()` expands an `'A|B'` key by ASSIGNING to `visitor.A` and
  // `visitor.B` rather than merging, so two alias keys naming the same node
  // type silently drop the first handler — which is how the bare
  // `RegExp(...)` construction went unvisited while `new RegExp(...)` worked.
  traverse(ast, {
    NewExpression: collectConstruction,
    CallExpression: (p) => {
      collectConstruction(p)
      collectReturnReader(p)
    },
    OptionalCallExpression: collectReturnReader,
    MemberExpression: collectMemberReader,
    OptionalMemberExpression: collectMemberReader,
    Identifier: (p) => {
      if (!p.isReferencedIdentifier()) return
      const slot = bindingSlot(p)
      if (slot) addReader(slot, p)
    },
    VariableDeclarator: (p) => {
      const id = p.get('id')
      if (id.isObjectPattern() || id.isArrayPattern()) linkPattern(id)
    },
    Function: (p) => {
      for (const param of p.get('params')) {
        const inner = param.isAssignmentPattern() ? param.get('left') : param
        if (inner.isObjectPattern() || inner.isArrayPattern()) linkPattern(inner)
      }
    },
  })

  if (constructions.length === 0) return []

  // Fixpoint: push each construction's id from where it is written, follow
  // every reader of every slot it lands in, until nothing new is learned.
  const queue = constructions.map((c) => ({ at: c.at, ids: new Set([c.id]), seed: true }))
  const pushSlot = (slot, ids) => {
    let held = taint.get(slot)
    if (!held) taint.set(slot, (held = new Set()))
    const added = new Set()
    for (const id of ids) {
      if (held.has(id)) continue
      held.add(id)
      added.add(id)
    }
    if (added.size === 0) return
    for (const reader of readers.get(slot) ?? []) queue.push({ at: reader, ids: added })
    for (const to of edges.get(slot) ?? []) pushSlot(to, added)
  }

  while (queue.length > 0) {
    const item = queue.pop()
    for (const target of targetsOf(item.at)) {
      if (typeof target === 'object' && target.sink) {
        for (const id of item.ids) {
          if (surgery.has(id)) continue
          surgery.set(id, {
            via: item.seed
              ? 'inline `.replace(new RegExp(…), …)`'
              : `flows into \`.replace(${target.argText}, …)\` at line ${target.line}`,
          })
        }
        continue
      }
      pushSlot(target, item.ids)
    }
  }

  return constructions
    .filter((c) => surgery.has(c.id))
    .map((c) => ({
      rule: 'unanchored-surgery',
      line: c.line,
      detail: `unanchored dynamic pattern ${JSON.stringify(c.argText)} — ${surgery.get(c.id).via}`,
    }))
}

// ─── rule 2: error-message substring branching ───────────────────────

const MESSAGE_PASSTHROUGH = new Set([
  'toLowerCase',
  'toUpperCase',
  'trim',
  'trimStart',
  'trimEnd',
  'toString',
  'normalize',
])

/** Non-computed `<obj>.<name>` (optional chaining included), else null. */
function memberName(expr) {
  if (!expr.isMemberExpression() && !expr.isOptionalMemberExpression()) return null
  if (expr.node.computed) return null
  return keyName(expr.node.property)
}

/** `String(err)` or `<x>.toLowerCase()`-style passthrough on an error message. */
function isErrorDerivedCall(expr, seen) {
  const callee = expr.get('callee')
  if (callee.isIdentifier({ name: 'String' })) return true
  const name = memberName(callee)
  if (name && MESSAGE_PASSTHROUGH.has(name)) return isErrorDerived(callee.get('object'), seen)
  return false
}

/**
 * Follow an identifier to its declaration and to any assignment made to
 * it, through the REAL scope chain, so a same-named binding in a
 * different function cannot contaminate the answer — the unscoped
 * whole-file `const`/`let`/`var` sweep the first version used could, and
 * that same shape caused a confirmed false negative in rule 1.
 */
function isErrorDerivedBinding(expr, seen) {
  const binding = expr.scope.getBinding(expr.node.name)
  if (!binding) return false
  if (binding.path.isVariableDeclarator() && binding.path.node.init) {
    if (isErrorDerived(binding.path.get('init'), seen)) return true
  }
  return binding.constantViolations.some(
    (v) => v.isAssignmentExpression() && isErrorDerived(v.get('right'), seen),
  )
}

/** Is `expr` an expression derived from an error MESSAGE? */
function isErrorDerived(expr, seen = new Set()) {
  if (!expr?.node || seen.has(expr.node)) return false
  seen.add(expr.node)

  if (memberName(expr) === 'message') return true
  if (expr.isCallExpression() || expr.isOptionalCallExpression()) {
    return isErrorDerivedCall(expr, seen)
  }
  if (expr.isConditionalExpression()) {
    return (
      isErrorDerived(expr.get('consequent'), seen) || isErrorDerived(expr.get('alternate'), seen)
    )
  }
  if (expr.isLogicalExpression()) {
    return isErrorDerived(expr.get('left'), seen) || isErrorDerived(expr.get('right'), seen)
  }
  if (
    expr.isTSAsExpression() ||
    expr.isTSSatisfiesExpression() ||
    expr.isTSNonNullExpression() ||
    expr.isTSTypeAssertion() ||
    expr.isParenthesizedExpression()
  ) {
    return isErrorDerived(expr.get('expression'), seen)
  }
  if (expr.isTemplateLiteral()) {
    return expr.get('expressions').some((e) => isErrorDerived(e, seen))
  }
  if (expr.isIdentifier()) return isErrorDerivedBinding(expr, seen)
  return false
}

/** Is `arg` a plain string literal (no interpolation)? */
function isStringLiteralArg(arg) {
  if (arg.isStringLiteral()) return true
  return arg.isTemplateLiteral() && arg.node.expressions.length === 0
}

function scanErrorMessageSubstring(ast) {
  const { traverse } = loadBabel()
  const found = []
  const seen = new Set()

  // One key per node type — see the `explode()` note in scanUnanchoredSurgery.
  const visit = (p) => {
    const callee = p.get('callee')
    const method = memberName(callee)
    if (method !== 'includes' && method !== 'indexOf') return
    if (p.node.arguments.length === 0) return
    if (!isStringLiteralArg(p.get('arguments.0'))) return
    if (!isErrorDerived(callee.get('object'))) return
    const line = p.node.loc.start.line
    if (seen.has(line)) return
    seen.add(line)
    found.push({
      rule: 'error-message-substring',
      line,
      detail: `\`.${method}('…')\` branches on an error-message substring`,
    })
  }

  traverse(ast, { CallExpression: visit, OptionalCallExpression: visit })
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
 * string so the self-test can drive it directly. `filename` selects the
 * parser dialect (`.tsx` enables JSX) and names the file in parse errors.
 */
export function scanSource(src, filename = 'source.tsx') {
  const ast = NEEDS_AST_RE.test(src) ? parseSource(src, filename) : null
  const stripped = stripComments(src)
  const lineOf = makeLineLookup(stripped)
  // A file with no allow-marker text cannot carry a marker, and one that
  // has the text was parsed above, so markers are always exact.
  const markers = ast ? markerLinesFromComments(ast) : new Set()
  const all = [
    ...(ast && SURGERY_GATE_RE.test(src) ? scanUnanchoredSurgery(ast, src) : []),
    ...(ast && SUBSTRING_GATE_RE.test(src) ? scanErrorMessageSubstring(ast) : []),
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
    for (const v of scanSource(fs.readFileSync(file, 'utf8'), file)) {
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

// Entry-point check (#3373): realpath BOTH sides — `import.meta.filename` is the
// RESOLVED path while `process.argv[1]` is the path AS INVOKED, so a naive
// comparison is false through a symlink and the script exits 0 having run nothing.
const isMain =
  !!process.argv[1] && fs.realpathSync(import.meta.filename) === fs.realpathSync(process.argv[1])

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

function analyzeOrExit(baseline) {
  try {
    return analyze({ root: ROOT, srcDir: SRC_DIR, baseline })
  } catch (err) {
    console.error(`ERROR: ${err.message}`)
    console.error('')
    console.error('Every file under src/ must parse for this guard to mean anything; refusing to')
    console.error('report "clean" over a file it could not read.')
    process.exit(2)
  }
}

function updateBaseline() {
  requireSrc()
  const previous = fs.existsSync(BASELINE_FILE) ? readBaseline() : []
  const reasons = new Map(previous.map((e) => [`${e.file}|${e.rule}`, e.reason ?? '']))
  const { counts } = analyzeOrExit([])
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

  const { sites, added, stale, scanned } = analyzeOrExit(baseline)
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
// Drives analyze(), scanSource() and validateBaseline() against a
// synthetic src tree written to a temp directory, so every rule is proved
// to FIRE on a violating fixture and to STAY QUIET on the legitimate
// counterpart — including each of the four usage shapes that evaded the
// pre-#3369 textual scanner. Two further blocks are not hermetic on
// purpose: one proves the walk cannot reach this script or anything else
// outside `src/`, and one pins the four real sites that #3348 confirmed
// safe, so a future change that starts flagging them fails here.
function runSelfTest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'content-regex-selftest-'))
  const failures = []
  const ok = (name) => console.log(`  ok   - ${name}`)
  const fail = (name, detail) => {
    failures.push(name)
    console.error(`  FAIL - ${name}: ${detail}`)
  }
  const expect = (name, cond, detail) => (cond ? ok(name) : fail(name, detail))

  try {
    const srcDir = path.join(tmp, 'src')
    const libDir = path.join(srcDir, 'lib')
    const compDir = path.join(srcDir, 'components')
    const testDir = path.join(compDir, '__tests__')
    const toolDir = path.join(tmp, 'scripts')
    for (const d of [libDir, compDir, testDir, toolDir]) fs.mkdirSync(d, { recursive: true })
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
    // Anchored on the RIGHT only — still splices on the left → violation.
    // (Symmetric counterpart to HalfAnchored.tsx above: without this fixture,
    // a broken `hasLeftAnchor()` that unconditionally reported "anchored" —
    // silently defeating half the boundary check — passed every assertion
    // in this file, because nothing here exercised a pattern that is
    // right-anchored but left-unanchored.)
    w(
      compDir,
      'HalfAnchoredRight.tsx',
      [
        'function escapeRegExp(s: string) { return s }',
        'export function linkIt(content: string, term: string) {',
        "  const re = new RegExp(`${escapeRegExp(term)}\\\\b`, 'i')",
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

    // ── the four shapes that evaded the textual scanner (#3369) ───────

    // (1) Reassignment with no declaration keyword on the RegExp line.
    w(
      compDir,
      'Reassigned.tsx',
      [
        'function escapeRegExp(s: string) { return s }',
        'export function linkIt(content: string, term: string, id: string) {',
        '  let re: RegExp',
        "  re = new RegExp(escapeRegExp(term), 'i')",
        '  return content.replace(re, `[[${id}]]`)',
        '}',
      ].join('\n'),
    )
    // (2) Regex passed as a call argument to a local helper that replaces.
    w(
      compDir,
      'PassedAsArg.tsx',
      [
        'function escapeRegExp(s: string) { return s }',
        'function applySurgery(content: string, re: RegExp, id: string) {',
        '  return content.replace(re, `[[${id}]]`)',
        '}',
        'export function linkIt(content: string, term: string, id: string) {',
        "  return applySurgery(content, new RegExp(escapeRegExp(term), 'i'), id)",
        '}',
      ].join('\n'),
    )
    // (3) Regex stashed in an object property, replaced through the property.
    w(
      compDir,
      'InObjectProp.tsx',
      [
        'function escapeRegExp(s: string) { return s }',
        'function applySurgery(content: string, opts: { re: RegExp }, id: string) {',
        '  return content.replace(opts.re, `[[${id}]]`)',
        '}',
        'export function linkIt(content: string, term: string, id: string) {',
        "  return applySurgery(content, { re: new RegExp(escapeRegExp(term), 'i') }, id)",
        '}',
      ].join('\n'),
    )
    // (4) Regex stashed in an array element, replaced through the index.
    w(
      compDir,
      'InArrayElem.tsx',
      [
        'function escapeRegExp(s: string) { return s }',
        'export function linkIt(content: string, term: string, id: string) {',
        "  const res = [new RegExp(escapeRegExp(term), 'i')]",
        '  return content.replace(res[0], `[[${id}]]`)',
        '}',
      ].join('\n'),
    )
    // A bare `RegExp(…)` call builds the same object as `new RegExp(…)`.
    // (Babel's visitor `explode()` overwrites rather than merges when two
    // alias keys name the same node type, which once made this shape
    // unvisited while `new RegExp` worked — hence a fixture for it.)
    w(
      compDir,
      'BareCall.tsx',
      [
        'function escapeRegExp(s: string) { return s }',
        'export function linkIt(content: string, term: string, id: string) {',
        "  const re = RegExp(escapeRegExp(term), 'i')",
        '  return content.replace(re, `[[${id}]]`)',
        '}',
      ].join('\n'),
    )
    // …but a LOCAL binding named `RegExp` is somebody else's function.
    w(
      libDir,
      'shadowed-regexp.ts',
      [
        'function escapeRegExp(s: string) { return s }',
        'function makeMatcher(p: string, f: string) { return { p, f } }',
        'export function linkIt(content: string, term: string) {',
        '  const RegExp = makeMatcher',
        "  const re = RegExp(escapeRegExp(term), 'i')",
        '  return content.replace(re as never, term)',
        '}',
      ].join('\n'),
    )
    // Bonus shape the AST gets for free: destructured out of an options object.
    w(
      compDir,
      'Destructured.tsx',
      [
        'function escapeRegExp(s: string) { return s }',
        'function applySurgery(content: string, opts: { re: RegExp }, id: string) {',
        '  const { re } = opts',
        '  return content.replace(re, `[[${id}]]`)',
        '}',
        'export function linkIt(content: string, term: string, id: string) {',
        "  return applySurgery(content, { re: new RegExp(escapeRegExp(term), 'i') }, id)",
        '}',
      ].join('\n'),
    )

    // ── the same four shapes used READ-ONLY → must stay clean ─────────

    w(
      libDir,
      'reassigned-read-only.ts',
      [
        'export function findIt(haystack: string, query: string) {',
        '  let re: RegExp',
        "  re = new RegExp(query, 'i')",
        '  return re.test(haystack)',
        '}',
      ].join('\n'),
    )
    w(
      libDir,
      'arg-read-only.ts',
      [
        'function matches(haystack: string, re: RegExp) {',
        '  return re.test(haystack)',
        '}',
        'export function findIt(haystack: string, query: string) {',
        "  return matches(haystack, new RegExp(query, 'i'))",
        '}',
      ].join('\n'),
    )
    w(
      libDir,
      'prop-read-only.ts',
      [
        'function matches(haystack: string, opts: { re: RegExp }) {',
        '  return opts.re.test(haystack)',
        '}',
        'export function findIt(haystack: string, query: string) {',
        "  return matches(haystack, { re: new RegExp(query, 'i') })",
        '}',
      ].join('\n'),
    )
    w(
      libDir,
      'array-read-only.ts',
      [
        'export function findIt(haystack: string, query: string) {',
        "  const res = [new RegExp(query, 'i')]",
        '  return res[0].test(haystack)',
        '}',
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
    // A LOCAL const string is compile-time constant too, and the scope chain
    // says so — the whole-file column-0 sweep could not.
    w(
      libDir,
      'local-const.ts',
      [
        'export function restore(md: string) {',
        "  const sentinel = '\\uE004'",
        "  return md.replace(new RegExp(sentinel, 'g'), '[encrypted]')",
        '}',
      ].join('\n'),
    )
    // …and a same-named RUNTIME parameter elsewhere in the file must NOT be
    // silently folded into that constant (the #3348 false negative).
    w(
      libDir,
      'shadowed-const.ts',
      [
        "function helper() { const term = 'x'; return term }",
        'export function linkIt(content: string, term: string, id: string) {',
        "  return content.replace(new RegExp(term, 'i'), id) + helper()",
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
    // Marker-shaped text inside a STRING is not a comment → does not suppress.
    w(
      compDir,
      'FakeMarker.tsx',
      [
        'function escapeRegExp(s: string) { return s }',
        'export const HELP = `',
        'to exempt a site write',
        '  // content-regex-allow: some reason',
        'above it',
        '`',
        'export const strip = (text: string, t: string) =>',
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
    // A same-named binding in a DIFFERENT scope must not make this an
    // error-message branch (the unscoped-collection false positive).
    w(
      libDir,
      'scoped-msg.ts',
      [
        'export function describe(err: Error) {',
        '  const msg = err.message',
        '  return msg.length',
        '}',
        'export function isDraft(row: { msg: string }) {',
        '  const msg = row.msg',
        "  return msg.includes('draft')",
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

    // ── scope proof: a copy of THIS script, outside src/ ──────────────
    //
    // Placed where a tooling file lives. If the walk ever escaped srcDir,
    // this file — which contains every banned shape as documentation and
    // as fixture text — would light up like a christmas tree.
    fs.copyFileSync(import.meta.filename, path.join(toolDir, path.basename(import.meta.filename)))
    w(
      toolDir,
      'tooling-fixture.ts',
      [
        'function escapeRegExp(s: string) { return s }',
        'export const strip = (text: string, t: string) =>',
        "  text.replace(new RegExp(escapeRegExp(t), 'g'), '')",
      ].join('\n'),
    )

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
      'right-anchored-only pattern is flagged (both sides required)',
      hit('components/HalfAnchoredRight.tsx', R1),
      JSON.stringify(sites),
    )
    expect(
      'inline `.replace(new RegExp(…))` is flagged',
      hit('components/DirectReplace.tsx', R1),
      JSON.stringify(sites),
    )

    // The four shapes from #3369, each of which the textual scanner missed.
    expect(
      'shape 1/4: bare reassignment (`let re; re = new RegExp(…)`) is flagged',
      hit('components/Reassigned.tsx', R1),
      JSON.stringify(sites),
    )
    expect(
      'shape 2/4: regex passed as a call argument is flagged',
      hit('components/PassedAsArg.tsx', R1),
      JSON.stringify(sites),
    )
    expect(
      'shape 3/4: regex stored in an object property is flagged',
      hit('components/InObjectProp.tsx', R1),
      JSON.stringify(sites),
    )
    expect(
      'shape 4/4: regex stored in an array element is flagged',
      hit('components/InArrayElem.tsx', R1),
      JSON.stringify(sites),
    )
    expect(
      'regex destructured out of an options object is flagged',
      hit('components/Destructured.tsx', R1),
      JSON.stringify(sites),
    )
    expect(
      'a bare `RegExp(…)` call (no `new`) is flagged',
      hit('components/BareCall.tsx', R1),
      JSON.stringify(sites),
    )
    expect(
      'a locally-bound `RegExp` is NOT treated as the global constructor',
      !hit('lib/shadowed-regexp.ts', R1),
      JSON.stringify(sites.filter((s) => s.file === 'src/lib/shadowed-regexp.ts')),
    )

    // …and the same four shapes used read-only must stay silent.
    for (const f of [
      'reassigned-read-only.ts',
      'arg-read-only.ts',
      'prop-read-only.ts',
      'array-read-only.ts',
    ]) {
      expect(
        `read-only counterpart ${f} is NOT flagged`,
        !hit(`lib/${f}`, R1),
        JSON.stringify(sites.filter((s) => s.file === `src/lib/${f}`)),
      )
    }

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
      'pattern built from a LOCAL const string is NOT flagged',
      !hit('lib/local-const.ts', R1),
      'local-const.ts flagged',
    )
    expect(
      'a same-named const in another scope does NOT mask a runtime pattern',
      hit('lib/shadowed-const.ts', R1),
      JSON.stringify(sites),
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
      'marker text inside a string literal does NOT suppress',
      hit('components/FakeMarker.tsx', R1),
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
      'same-named binding in another scope is NOT an error-message branch',
      !hit('lib/scoped-msg.ts', R2),
      JSON.stringify(sites.filter((s) => s.file === 'src/lib/scoped-msg.ts')),
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

    // ── the guard cannot see itself or any other tooling ──────────────

    expect(
      'nothing outside src/ is reported (this script + a tooling fixture sit in scripts/)',
      sites.every((s) => s.file.startsWith('src/')),
      JSON.stringify(sites.filter((s) => !s.file.startsWith('src/'))),
    )
    expect(
      'a copy of this script placed in scripts/ is not scanned',
      !listSourceFiles(srcDir).some((f) => f.includes(path.basename(import.meta.filename))),
      JSON.stringify(listSourceFiles(srcDir).filter((f) => f.includes('check-unanchored'))),
    )
    expect(
      "this script is not in the real repo's scanned set",
      !fs.existsSync(SRC_DIR) ||
        !listSourceFiles(SRC_DIR).some(
          (f) => path.resolve(f) === path.resolve(import.meta.filename),
        ),
      'guard script is inside the scanned tree',
    )
    expect(
      'self-test fixtures live outside the real scanned tree',
      !path.resolve(tmp).startsWith(`${path.resolve(SRC_DIR)}${path.sep}`),
      `fixtures written inside ${SRC_DIR}`,
    )

    // ── an unparseable file is a hard error, never a silent pass ──────

    let threw = false
    try {
      scanSource('const re = new RegExp(((((', 'broken.ts')
    } catch {
      threw = true
    }
    expect('an unparseable source throws instead of reporting clean', threw, 'no throw')

    // ── real sites #3348 confirmed safe must stay unflagged ───────────

    const safeSites = [
      'src/lib/enex-import.ts',
      'src/editor/markdown-parse/parser.ts',
      'src/lib/in-page-find/matcher.ts',
      'src/lib/search-query/glob-validate.ts',
    ]
    for (const rel of safeSites) {
      const abs = path.join(ROOT, rel)
      if (!fs.existsSync(abs)) {
        fail(
          `known-safe site ${rel} still exists`,
          'file moved or renamed — re-confirm it is safe and update this list',
        )
        continue
      }
      const found = scanSource(fs.readFileSync(abs, 'utf8'), abs).filter((v) => v.rule === R1)
      expect(
        `known-safe real site ${rel} is NOT flagged as surgery`,
        found.length === 0,
        JSON.stringify(found),
      )
    }

    // ── validateBaseline ──────────────────────────────────────────────

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
