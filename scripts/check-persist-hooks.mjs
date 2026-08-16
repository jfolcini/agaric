#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────
// Persist migrate/merge guard (#3352, split out of #3323).
//
// `src/stores/pageBrowserFilters.ts` shipped a `persist()` of a
// non-scalar shape (`Record<string, PageFilterWithKey[]>` plus a
// counter) with neither a `migrate` nor a `merge` hook. A malformed
// `localStorage` blob threw the page browser into its error boundary and
// permanently broke the counter via string concatenation. #3323 fixed
// that one store; this guard stops the next one from shipping the same
// way.
//
// `src/lib/safe-persist-storage.ts:12-13` states as an invariant that
// "the read path (migrate/merge) is already hardened per-store" — but
// that was enforced only by convention. The project has paid for exactly
// this class five times: #753, #823, #1578, #1609, #3323.
//
// Both hooks are required, not just `migrate`: per `search-history.ts`
// (search for "zustand skips `migrate`"), zustand only invokes `migrate`
// when the persisted blob's version DIFFERS from `options.version`. A
// same-version corrupt blob bypasses `migrate` entirely and is handed
// straight to `merge` (or, absent `merge`, to the default shallow merge,
// unvalidated). A store with `migrate` but no `merge` is therefore still
// exposed to exactly the #3323 bug on a same-version corrupt blob.
//
// ─── What counts as "non-scalar" (structural, not an allowlist) ───────
//
// Two stores legitimately persist a bare scalar and are fine without
// either hook: `space.ts` (`currentSpaceId: string | null`, re-validated
// against server truth by `reconcileCurrentSpaceId`) and
// `useDebugStore.ts` (`debugMode: boolean`). Hardcoding those two
// filenames would rot the moment a third scalar store appears, so this
// guard instead derives "non-scalar" from the STATE INTERFACE:
//
//   1. Find the state type from `create<TypeName>()(...)` and locate
//      `interface TypeName { ... }` (or `type TypeName = { ... }`) in
//      the same file.
//   2. Walk `partialize`'s returned object literal. Each `key:
//      state.field` entry is resolved to `field`'s declared type in that
//      interface.
//   3. A type is SCALAR iff every member of its top-level union is a
//      primitive keyword (`string`/`number`/`boolean`/`null`/
//      `undefined`/`bigint`), a string/numeric/boolean literal. Anything
//      else — `T[]`, `Record<..>`/`Map<..>`/`Set<..>`, an inline object
//      type `{ .. }`, `any`/`unknown`, or a BARE TYPE REFERENCE this
//      guard does not attempt to resolve (`View`, `Date`, `PageRef`, an
//      imported type, …) — is conservatively NON-SCALAR. A store is
//      non-scalar overall if ANY persisted field is non-scalar, or if
//      `partialize` is absent (the whole state, including action
//      closures, is persisted), or if `partialize`'s shape can't be read
//      statically (not an inline arrow returning an inline object
//      literal).
//
// Deliberately NOT resolving bare type-alias references (e.g. following
// `View` to its `'journal' | 'search' | …` union) keeps the classifier
// small and its failure mode SAFE: an unresolvable type is treated as
// risky, so the guard can only ask for `migrate`/`merge` where they may
// not be strictly required — never the other way around. In the current
// tree this costs nothing (`navigation.ts`'s `currentView: View` field
// sits alongside `currentViewBySpace: Record<string, View>`, which is
// non-scalar on its own regardless of `View`'s resolution).
//
// This structural rule reproduces both exemptions from the interface
// declarations alone (`currentSpaceId: string | null` and `debugMode:
// boolean` are the ONLY all-scalar `partialize` shapes in the tree today)
// — nothing references `space.ts` or `useDebugStore.ts` by name anywhere
// in this file.
//
// ─── Escape hatch ───────────────────────────────────────────────────
//
// A per-site `// persist-hooks-allow: <reason>` marker on the `persist(`
// line or the line immediately above it exempts that call (empty reason
// does not suppress — mirrors `content-regex-allow` in
// check-unanchored-content-regex.mjs). No baseline file: the live tree
// has zero pre-existing debt (every non-scalar `persist()` already
// declares both hooks), so there is nothing to grandfather.
//
// ─── Scope ──────────────────────────────────────────────────────────
//
// `src/stores/**/*.{ts,tsx}` only, excluding `__tests__/`/`tests/` and
// `*.test.ts[x]`. The guard therefore can never match its own source
// (which lives in `scripts/`), and `--self-test`'s fixtures are written
// to a temp directory outside the repo entirely — neither is reachable
// by the scan, proven by `--self-test`'s own assertions.
//
// Usage: node scripts/check-persist-hooks.mjs
//        node scripts/check-persist-hooks.mjs --self-test
// Exit:  0 = clean, 1 = at least one violation, 2 = repo layout /
//        self-test failure.
// ─────────────────────────────────────────────────────────────────────

import { spawnSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { ScanError, skipString, stripComments } from './lib/js-scanner.mjs'

const ROOT = path.resolve(import.meta.dirname, '..')
const STORES_DIR = path.join(ROOT, 'src', 'stores')

// ─── generic string/bracket scanning ─────────────────────────────────

function toPosix(p) {
  return p.split(path.sep).join('/')
}

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
 * Index just past the bracket group opened by `src[openIdx]` (one of
 * `( { [`), tracking a single depth counter across all three bracket
 * kinds (valid JS/TS is always balanced, so this is sufficient) and
 * skipping over string/template literal contents so brackets inside them
 * don't perturb the count.
 */
function findMatchingClose(src, openIdx) {
  let depth = 0
  let i = openIdx
  while (i < src.length) {
    const c = src[i]
    if (c === "'" || c === '"' || c === '`') {
      i = skipString(src, i)
      continue
    }
    if (c === '(' || c === '{' || c === '[') {
      depth++
      i++
      continue
    }
    if (c === ')' || c === '}' || c === ']') {
      depth--
      i++
      if (depth === 0) return i
      continue
    }
    i++
  }
  return i
}

/**
 * Split the group opened at `openIdx` into top-level comma-separated
 * parts (depth === 1, i.e. directly inside the opening bracket). Returns
 * absolute `{start, end}` spans (not sliced text) plus `closeIdx` (index
 * just past the matching close bracket).
 */
function splitTopLevel(src, openIdx) {
  const closeIdx = findMatchingClose(src, openIdx)
  const endIdx = closeIdx - 1
  const parts = []
  let depth = 0
  let segStart = openIdx + 1
  let i = openIdx
  while (i < endIdx) {
    const c = src[i]
    if (c === "'" || c === '"' || c === '`') {
      i = skipString(src, i)
      continue
    }
    if (c === '(' || c === '{' || c === '[') {
      depth++
      i++
      continue
    }
    if (c === ')' || c === '}' || c === ']') {
      depth--
      i++
      continue
    }
    if (c === ',' && depth === 1) {
      parts.push({ start: segStart, end: i })
      segStart = i + 1
      i++
      continue
    }
    i++
  }
  if (segStart < endIdx || parts.length === 0) {
    const trimmedNonEmpty = src.slice(segStart, endIdx).trim().length > 0
    if (trimmedNonEmpty) parts.push({ start: segStart, end: endIdx })
  }
  return { parts, closeIdx }
}

function findFirstNonWs(src, from, limit = src.length) {
  let i = from
  while (i < limit && /\s/.test(src[i])) i++
  return i
}

/**
 * Parse one comma-split segment `[start, end)` of an object literal into
 * `{ key, valueStart, valueEnd, valueText, shorthand }`. `key: value`
 * (the only shape used by every real `persist()` options object /
 * `partialize` return in this tree) and bare shorthand `key` are both
 * supported; a shorthand entry's `valueText` is the key itself (implying
 * `state.key`).
 */
function parseProp(src, start, end) {
  const raw = src.slice(start, end)
  const leadWs = raw.match(/^\s*/)[0].length
  const afterLead = start + leadWs
  const rest = raw.slice(leadWs)
  const m = /^([A-Za-z_$][\w$]*)(\s*):/.exec(rest)
  if (m) {
    const key = m[1]
    const valueRawStart = start + leadWs + m[0].length
    const vLead = findFirstNonWs(src, valueRawStart, end) - valueRawStart
    const valueStart = valueRawStart + vLead
    const valueText = src.slice(valueStart, end).trim()
    return { key, valueStart, valueEnd: valueStart + valueText.length, valueText, shorthand: false }
  }
  const key = rest.trim()
  return { key, valueStart: afterLead, valueEnd: end, valueText: key, shorthand: true }
}

// ─── type classification ──────────────────────────────────────────────

const SCALAR_KEYWORDS = new Set(['string', 'number', 'boolean', 'null', 'undefined', 'bigint'])

/** Top-level `|` split of a type-annotation string, respecting `<>()[]{}` nesting. */
function splitTopLevelUnion(text) {
  const parts = []
  let depth = 0
  let start = 0
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '<' || c === '(' || c === '{' || c === '[') depth++
    else if (c === '>' || c === ')' || c === '}' || c === ']') depth--
    else if (c === '|' && depth === 0) {
      parts.push(text.slice(start, i))
      start = i + 1
    }
  }
  parts.push(text.slice(start))
  return parts.map((p) => p.trim()).filter((p) => p.length > 0)
}

const COLLECTION_PREFIX_RE =
  /^(?:Readonly<|ReadonlyArray<|Array<|Record<|ReadonlyMap<|Map<|ReadonlySet<|Set<|WeakMap<|WeakSet<|Promise<)/

/** Classify a single (already union-split) type fragment as 'scalar' | 'non-scalar'. */
function classifyTypePart(part) {
  const p = part.trim()
  if (SCALAR_KEYWORDS.has(p)) return 'scalar'
  if (p === 'true' || p === 'false') return 'scalar'
  if (/^(['"]).*\1$/.test(p)) return 'scalar' // string literal type
  if (/^-?\d+(\.\d+)?$/.test(p)) return 'scalar' // numeric literal type
  if (p.endsWith('[]')) return 'non-scalar'
  if (COLLECTION_PREFIX_RE.test(p)) return 'non-scalar'
  if (p.startsWith('{')) return 'non-scalar' // inline object type literal
  if (p === 'any' || p === 'unknown' || p === 'object') return 'non-scalar'
  // Bare identifier / unresolved generic reference (Date, PageRef, View,
  // an imported type, …): not statically provable scalar without
  // resolving elsewhere in the file. Conservative default — see the
  // file header's "Deliberately NOT resolving..." note.
  return 'non-scalar'
}

/** Classify a full type-annotation string. Non-scalar if ANY union member is. */
export function classifyType(typeText) {
  const parts = splitTopLevelUnion(typeText)
  if (parts.length === 0) return 'non-scalar'
  return parts.every((p) => classifyTypePart(p) === 'scalar') ? 'scalar' : 'non-scalar'
}

/**
 * Locate `interface Name { ... }` or `type Name = { ... }` in
 * (comment-stripped) `stripped` and return its body text, or `null`.
 */
function findTypeOrInterfaceBody(stripped, typeName) {
  const escaped = typeName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const ifaceRe = new RegExp(`(?:^|\\n)\\s*(?:export\\s+)?interface\\s+${escaped}\\b[^{]*\\{`)
  let m = ifaceRe.exec(stripped)
  if (!m) {
    const aliasRe = new RegExp(`(?:^|\\n)\\s*(?:export\\s+)?type\\s+${escaped}\\s*=\\s*\\{`)
    m = aliasRe.exec(stripped)
  }
  if (!m) return null
  const openIdx = m.index + m[0].length - 1
  const closeIdx = findMatchingClose(stripped, openIdx)
  return stripped.slice(openIdx + 1, closeIdx - 1)
}

/**
 * Declared type text of `fieldName` inside an interface/type-literal
 * body, or `null` if not present. Anchored so `mode` cannot match inside
 * `modeBySpace`.
 */
function lookupFieldType(bodyText, fieldName) {
  const escaped = fieldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`(?:^|[\\n;{])[ \\t]*${escaped}\\??[ \\t]*:[ \\t]*([^\\n;]+)`)
  const m = re.exec(bodyText)
  return m ? m[1].trim() : null
}

// ─── persist() call discovery ─────────────────────────────────────────

/** `{matchIndex, openIdx}` for every top-level `persist(` call in `stripped`. */
function findPersistCalls(stripped) {
  const out = []
  const re = /\bpersist\s*\(/g
  let m
  while ((m = re.exec(stripped))) {
    out.push({ matchIndex: m.index, openIdx: m.index + m[0].length - 1 })
  }
  return out
}

/** Nearest `create<TypeName>` occurring before `beforeIdx`, or `null`. */
function findPrecedingCreateType(stripped, beforeIdx) {
  const re = /\bcreate\s*<\s*([A-Za-z_$][\w$]*)\s*>/g
  let best = null
  let m
  while ((m = re.exec(stripped))) {
    if (m.index >= beforeIdx) break
    best = m[1]
  }
  return best
}

/** Extract the plain string contents of a `'…'`/`"…"`/`` `…` `` literal, or `null`. */
function extractStringLiteral(text) {
  const m = /^(['"`])(.*)\1$/.exec(text.trim())
  return m ? m[2] : null
}

/**
 * Classify the shape `partialize` persists. Returns
 * `{ nonScalar, reason, fields }`.
 */
function classifyPersistedShape(stripped, optionsProps, stateType) {
  const partializeProp = optionsProps.find((p) => p.key === 'partialize')
  if (!partializeProp) {
    return {
      nonScalar: true,
      reason: 'no `partialize` — the full state object (including action closures) is persisted',
      fields: [],
    }
  }

  const arrowIdx = stripped.indexOf('=>', partializeProp.valueStart)
  if (arrowIdx === -1 || arrowIdx >= partializeProp.valueEnd) {
    return {
      nonScalar: true,
      reason: 'partialize is not an inline arrow function — cannot verify the shape statically',
      fields: [],
    }
  }
  const paramText = stripped.slice(partializeProp.valueStart, arrowIdx).trim()
  const paramMatch = /^\(?\s*([A-Za-z_$][\w$]*)\s*\)?$/.exec(paramText)
  const paramName = paramMatch ? paramMatch[1] : null

  let i = findFirstNonWs(stripped, arrowIdx + 2, partializeProp.valueEnd)
  if (stripped[i] === '(') i = findFirstNonWs(stripped, i + 1, partializeProp.valueEnd)
  if (stripped[i] !== '{') {
    return {
      nonScalar: true,
      reason:
        'partialize does not return an inline object literal — cannot verify the shape statically',
      fields: [],
    }
  }

  const { parts: fieldParts } = splitTopLevel(stripped, i)
  const fieldProps = fieldParts.map((p) => parseProp(stripped, p.start, p.end))
  if (fieldProps.length === 0) {
    return { nonScalar: false, reason: 'partialize persists no fields', fields: [] }
  }

  const interfaceBody = stateType ? findTypeOrInterfaceBody(stripped, stateType) : null

  const fields = fieldProps.map((fp) => {
    let fieldName = null
    if (fp.shorthand) {
      fieldName = fp.key
    } else if (paramName) {
      const m = new RegExp(`^${paramName}\\.([A-Za-z_$][\\w$]*)$`).exec(fp.valueText)
      if (m) fieldName = m[1]
    }
    if (!fieldName) {
      return {
        key: fp.key,
        classification: 'non-scalar',
        why: 'persisted value is not a plain `state.<field>` reference',
      }
    }
    if (!interfaceBody) {
      return {
        key: fp.key,
        classification: 'non-scalar',
        why: `could not locate an interface/type named \`${stateType ?? '?'}\` in this file to check \`${fieldName}\`'s type`,
      }
    }
    const typeText = lookupFieldType(interfaceBody, fieldName)
    if (typeText == null) {
      return {
        key: fp.key,
        classification: 'non-scalar',
        why: `\`${fieldName}\` not found on \`${stateType}\``,
      }
    }
    return {
      key: fp.key,
      classification: classifyType(typeText),
      why: `\`${fieldName}: ${typeText}\``,
    }
  })

  const nonScalar = fields.some((f) => f.classification === 'non-scalar')
  return {
    nonScalar,
    reason: nonScalar
      ? 'persisted shape includes a non-scalar field'
      : 'every persisted field is scalar',
    fields,
  }
}

// ─── marker exemption ──────────────────────────────────────────────────

/** Line numbers carrying `// persist-hooks-allow: <reason>` with a NON-EMPTY reason. */
function allowMarkerLines(src) {
  const lines = src.split('\n')
  const out = new Set()
  for (let i = 0; i < lines.length; i++) {
    const m = /\/\/\s*persist-hooks-allow\s*:\s*(.*)$/.exec(lines[i])
    if (m && m[1].trim().length > 0) out.add(i + 1)
  }
  return out
}

function isMarked(markers, line) {
  return markers.has(line) || markers.has(line - 1)
}

// ─── per-file scan ─────────────────────────────────────────────────────

/**
 * Scan one file's source. Returns violations
 * `{ line, store, missing, reason, fields }`. Pure over a string so the
 * self-test can drive it directly.
 */
export function scanSource(src) {
  const stripped = stripComments(src)
  const lineOf = makeLineLookup(stripped)
  const markers = allowMarkerLines(src)
  const violations = []

  for (const call of findPersistCalls(stripped)) {
    const { parts: argParts } = splitTopLevel(stripped, call.openIdx)
    if (argParts.length < 2) continue // not a recognizable persist(creator, options) call

    const optionsArg = argParts[1]
    const optObjOpenIdx = findFirstNonWs(stripped, optionsArg.start, optionsArg.end)
    if (stripped[optObjOpenIdx] !== '{') continue // options isn't an inline object literal

    const { parts: optParts } = splitTopLevel(stripped, optObjOpenIdx)
    const optionsProps = optParts.map((p) => parseProp(stripped, p.start, p.end))

    const hasMigrate = optionsProps.some((p) => p.key === 'migrate')
    const hasMerge = optionsProps.some((p) => p.key === 'merge')
    if (hasMigrate && hasMerge) continue // already compliant, skip classification entirely

    const stateType = findPrecedingCreateType(stripped, call.matchIndex)
    const { nonScalar, reason, fields } = classifyPersistedShape(stripped, optionsProps, stateType)
    if (!nonScalar) continue

    const line = lineOf(call.matchIndex)
    if (isMarked(markers, line)) continue

    const nameProp = optionsProps.find((p) => p.key === 'name')
    const store =
      (nameProp && extractStringLiteral(nameProp.valueText)) ?? stateType ?? '(unknown store)'
    const missing = []
    if (!hasMigrate) missing.push('migrate')
    if (!hasMerge) missing.push('merge')
    violations.push({ line, store, missing, reason, fields })
  }

  return violations.toSorted((a, b) => a.line - b.line)
}

// ─── tree walk ──────────────────────────────────────────────────────────

/** Walk `dir` for `*.ts`/`*.tsx`, excluding test files and `__tests__`/`tests` dirs. */
function listStoreFiles(dir) {
  const out = []
  const visit = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name)
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
  visit(dir)
  return out.toSorted()
}

/**
 * Scan `storesDir` for violations. Pure over the filesystem so the
 * self-test can drive it against a synthetic tree. Returns
 * `{ violations, scanned, files, scanErrors }` (`files` are root-relative
 * POSIX). `scanErrors` is `{ file, message }` for files the shared scanner
 * could not lex unambiguously — a FAILURE, not a skip: a file this guard
 * cannot parse is a file whose `persist()` calls nobody verified (#3993).
 */
export function analyze({ root, storesDir }) {
  const violations = []
  const scanErrors = []
  const files = []
  for (const file of listStoreFiles(storesDir)) {
    const rel = toPosix(path.relative(root, file))
    files.push(rel)
    const src = fs.readFileSync(file, 'utf8')
    try {
      for (const v of scanSource(src)) violations.push({ file: rel, ...v })
    } catch (err) {
      if (!(err instanceof ScanError)) throw err
      scanErrors.push({ file: rel, message: err.message })
    }
  }
  return { violations, scanned: files.length, files, scanErrors }
}

// ─── entry point ─────────────────────────────────────────────────────

// Entry-point check (#3373): realpath BOTH sides — see
// check-main-module-detection.mjs for why a naive `argv[1]` comparison
// silently no-ops through a symlink.
const isMainModule =
  !!process.argv[1] && realpathSync(import.meta.filename) === realpathSync(process.argv[1])

if (isMainModule) {
  if (process.argv.includes('--self-test')) runSelfTest()
  else runGuard()
}

function runGuard() {
  if (!fs.existsSync(STORES_DIR)) {
    console.error(`ERROR: expected directory not found (repo layout changed?): ${STORES_DIR}`)
    process.exit(2)
  }

  const { violations, scanned, scanErrors } = analyze({ root: ROOT, storesDir: STORES_DIR })

  if (scanErrors.length > 0) {
    console.error('ERROR: file(s) could not be scanned unambiguously, so their persist() calls')
    console.error('were NOT verified:')
    console.error('')
    for (const e of scanErrors) {
      console.error(`  ${e.file} — ${e.message}`)
    }
    console.error('')
    console.error('The shared scanner (scripts/lib/js-scanner.mjs) fails closed rather than')
    console.error('guessing. Fix the construct it names, or extend the scanner.')
    process.exit(1)
  }

  if (violations.length > 0) {
    console.error('ERROR: persist() of a non-scalar shape without both migrate AND merge:')
    for (const v of violations) {
      console.error(`  ${v.file}:${v.line}  store "${v.store}"  missing: ${v.missing.join(', ')}`)
      console.error(`    ${v.reason}`)
      for (const f of v.fields.filter((x) => x.classification === 'non-scalar')) {
        console.error(`      non-scalar field \`${f.key}\` — ${f.why}`)
      }
    }
    console.error('')
    console.error("zustand only invokes `migrate` when the persisted blob's version DIFFERS from")
    console.error('`options.version`. A same-version corrupt blob bypasses `migrate` entirely and')
    console.error(
      'reaches `merge` (or, absent `merge`, the default shallow merge) unvalidated — so',
    )
    console.error(
      'BOTH hooks are required, sharing one coercion function (mirrors search-history.ts):',
    )
    console.error('')
    console.error('    migrate: (persisted, _version) => coercePersistedFoo(persisted),')
    console.error(
      '    merge: (persisted, current) => ({ ...current, ...coercePersistedFoo(persisted) }),',
    )
    console.error('')
    console.error('If a persisted field is genuinely scalar and this guard cannot see it (an')
    console.error('unresolved type alias, a computed partialize value), mark the call site:')
    console.error('')
    console.error('    // persist-hooks-allow: <why this shape cannot be corrupted structurally>')
    console.error('    persist(')
    console.error('')
    process.exit(1)
  }

  console.log(
    `OK: ${scanned} store file(s) scanned, every non-scalar persist() has migrate + merge`,
  )
}

// ─── self-test ───────────────────────────────────────────────────────
function runSelfTest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'persist-hooks-selftest-'))
  const failures = []
  const ok = (name) => console.log(`  ok   - ${name}`)
  const fail = (name, detail) => {
    failures.push(name)
    console.error(`  FAIL - ${name}: ${detail}`)
  }

  try {
    const storesDir = path.join(tmp, 'src', 'stores')
    const testDir = path.join(storesDir, '__tests__')
    fs.mkdirSync(testDir, { recursive: true })
    const w = (name, body) => fs.writeFileSync(path.join(storesDir, name), body)

    // 1. Non-scalar (array field), both hooks missing → violation, both listed.
    w(
      'badBoth.ts',
      [
        "import { create } from 'zustand'",
        "import { persist } from 'zustand/middleware'",
        'interface BadState {',
        '  items: string[]',
        '  setItems: (items: string[]) => void',
        '}',
        'export const useBad = create<BadState>()(',
        '  persist(',
        '    (set) => ({ items: [], setItems: (items) => set({ items }) }),',
        "    { name: 'bad', version: 1, partialize: (state) => ({ items: state.items }) },",
        '  ),',
        ')',
      ].join('\n'),
    )

    // 2. Non-scalar (Record field), migrate present but merge missing → violation, only merge listed.
    w(
      'badMergeOnly.ts',
      [
        "import { create } from 'zustand'",
        "import { persist } from 'zustand/middleware'",
        'interface BadMergeState {',
        '  bySpace: Record<string, string[]>',
        '}',
        'function coerce(p: unknown) { return p as Partial<BadMergeState> }',
        'export const useBadMerge = create<BadMergeState>()(',
        '  persist(',
        '    (_set) => ({ bySpace: {} }),',
        '    {',
        "      name: 'bad-merge',",
        '      version: 1,',
        '      partialize: (state) => ({ bySpace: state.bySpace }),',
        '      migrate: (persisted, _version) => coerce(persisted),',
        '    },',
        '  ),',
        ')',
      ].join('\n'),
    )

    // 3. Non-scalar, merge present but migrate missing → violation, only migrate listed
    //    (the search-history.ts:173-183 shape: migrate alone is NOT sufficient either,
    //    but this proves the converse omission is caught too).
    w(
      'badMigrateOnly.ts',
      [
        "import { create } from 'zustand'",
        "import { persist } from 'zustand/middleware'",
        'interface BadMigrateState {',
        '  bySpace: Record<string, string[]>',
        '}',
        'function coerce(p: unknown) { return p as Partial<BadMigrateState> }',
        'export const useBadMigrate = create<BadMigrateState>()(',
        '  persist(',
        '    (_set) => ({ bySpace: {} }),',
        '    {',
        "      name: 'bad-migrate',",
        '      version: 1,',
        '      partialize: (state) => ({ bySpace: state.bySpace }),',
        '      merge: (persisted, current) => ({ ...current, ...coerce(persisted) }),',
        '    },',
        '  ),',
        ')',
      ].join('\n'),
    )

    // 4. Non-scalar, BOTH hooks present → clean (mirrors the six real stores).
    w(
      'goodBoth.ts',
      [
        "import { create } from 'zustand'",
        "import { persist } from 'zustand/middleware'",
        'interface GoodState {',
        '  bySpace: Record<string, string[]>',
        '  historyEnabled: boolean',
        '}',
        'function coerce(p: unknown) { return p as Partial<GoodState> }',
        'export const useGood = create<GoodState>()(',
        '  persist(',
        '    (_set) => ({ bySpace: {}, historyEnabled: true }),',
        '    {',
        "      name: 'good',",
        '      version: 1,',
        '      partialize: (state) => ({ bySpace: state.bySpace, historyEnabled: state.historyEnabled }),',
        '      migrate: (persisted, _version) => coerce(persisted),',
        '      merge: (persisted, current) => ({ ...current, ...coerce(persisted) }),',
        '    },',
        '  ),',
        ')',
      ].join('\n'),
    )

    // 5. Single scalar field (string | null), no hooks → clean (mirrors space.ts),
    //    proven via the STATE INTERFACE, not a filename.
    w(
      'scalarSingle.ts',
      [
        "import { create } from 'zustand'",
        "import { persist } from 'zustand/middleware'",
        'interface ScalarState {',
        '  currentId: string | null',
        '}',
        'export const useScalar = create<ScalarState>()(',
        '  persist(',
        '    (_set) => ({ currentId: null }),',
        "    { name: 'scalar', partialize: (state) => ({ currentId: state.currentId }) },",
        '  ),',
        ')',
      ].join('\n'),
    )

    // 6. Single boolean field, no hooks → clean (mirrors useDebugStore.ts).
    w(
      'scalarBoolean.ts',
      [
        "import { create } from 'zustand'",
        "import { persist } from 'zustand/middleware'",
        'interface DebugishState {',
        '  debugMode: boolean',
        '}',
        'export const useDebugish = create<DebugishState>()(',
        '  persist(',
        '    (_set) => ({ debugMode: false }),',
        "    { name: 'debugish', partialize: (state) => ({ debugMode: state.debugMode }) },",
        '  ),',
        ')',
      ].join('\n'),
    )

    // 7. TWO scalar fields (string + number), no hooks → clean. Proves the rule is
    //    "every field scalar", not a naive "single key" count.
    w(
      'scalarMulti.ts',
      [
        "import { create } from 'zustand'",
        "import { persist } from 'zustand/middleware'",
        'interface ScalarMultiState {',
        '  label: string',
        '  count: number',
        '}',
        'export const useScalarMulti = create<ScalarMultiState>()(',
        '  persist(',
        '    (_set) => ({ label: "x", count: 0 }),',
        "    { name: 'scalar-multi', partialize: (state) => ({ label: state.label, count: state.count }) },",
        '  ),',
        ')',
      ].join('\n'),
    )

    // 8. `partialize` absent → whole state persisted → violation.
    w(
      'noPartialize.ts',
      [
        "import { create } from 'zustand'",
        "import { persist } from 'zustand/middleware'",
        'interface NoPartializeState { flag: boolean }',
        'export const useNoPartialize = create<NoPartializeState>()(',
        "  persist((_set) => ({ flag: false }), { name: 'no-partialize' }),",
        ')',
      ].join('\n'),
    )

    // 9. Bare unresolved type reference (`Date`) → conservatively non-scalar → violation.
    w(
      'unresolvedType.ts',
      [
        "import { create } from 'zustand'",
        "import { persist } from 'zustand/middleware'",
        'interface DateState { updatedAt: Date }',
        'export const useDateState = create<DateState>()(',
        '  persist(',
        '    (_set) => ({ updatedAt: new Date() }),',
        "    { name: 'date-state', partialize: (state) => ({ updatedAt: state.updatedAt }) },",
        '  ),',
        ')',
      ].join('\n'),
    )

    // 10. `partialize` delegates to a named helper (not an inline object literal)
    //     → cannot verify statically → conservatively non-scalar → violation.
    w(
      'nonInlinePartialize.ts',
      [
        "import { create } from 'zustand'",
        "import { persist } from 'zustand/middleware'",
        'interface HelperState { value: string }',
        'function pick(state: HelperState) { return { value: state.value } }',
        'export const useHelper = create<HelperState>()(',
        "  persist((_set) => ({ value: 'x' }), { name: 'helper', partialize: pick }),",
        ')',
      ].join('\n'),
    )

    // 11. Marked with a reasoned `persist-hooks-allow` → suppressed.
    w(
      'marked.ts',
      [
        "import { create } from 'zustand'",
        "import { persist } from 'zustand/middleware'",
        'interface MarkedState { items: string[] }',
        'export const useMarked = create<MarkedState>()(',
        '  // persist-hooks-allow: fixture only, never shipped',
        '  persist(',
        '    (_set) => ({ items: [] }),',
        "    { name: 'marked', partialize: (state) => ({ items: state.items }) },",
        '  ),',
        ')',
      ].join('\n'),
    )

    // 12. Marker present but EMPTY reason → still a violation.
    w(
      'markedNoReason.ts',
      [
        "import { create } from 'zustand'",
        "import { persist } from 'zustand/middleware'",
        'interface MarkedNoReasonState { items: string[] }',
        'export const useMarkedNoReason = create<MarkedNoReasonState>()(',
        '  // persist-hooks-allow:',
        '  persist(',
        '    (_set) => ({ items: [] }),',
        "    { name: 'marked-no-reason', partialize: (state) => ({ items: state.items }) },",
        '  ),',
        ')',
      ].join('\n'),
    )

    // 13. TWO stores in one file: first violates, second (different interface) is
    //     clean — proves `create<T>` association isn't crossed between stores.
    w(
      'twoStores.ts',
      [
        "import { create } from 'zustand'",
        "import { persist } from 'zustand/middleware'",
        'interface FirstState { items: string[] }',
        'interface SecondState { flag: boolean }',
        'export const useFirst = create<FirstState>()(',
        "  persist((_set) => ({ items: [] }), { name: 'first', partialize: (state) => ({ items: state.items }) }),",
        ')',
        'export const useSecond = create<SecondState>()(',
        "  persist((_set) => ({ flag: false }), { name: 'second', partialize: (state) => ({ flag: state.flag }) }),",
        ')',
      ].join('\n'),
    )

    // 14. `persist` as an unrelated local identifier, not the zustand middleware
    //     shape (single arg, no options object) → skipped without crashing.
    w(
      'unrelatedPersist.ts',
      ['export const persist = (value: number) => value', 'export const x = persist(1)'].join('\n'),
    )

    // 15. Violating shape inside `__tests__/` → not scanned at all.
    fs.writeFileSync(
      path.join(testDir, 'notAStore.test.ts'),
      [
        "import { create } from 'zustand'",
        "import { persist } from 'zustand/middleware'",
        'interface TestOnlyState { items: string[] }',
        'export const useTestOnly = create<TestOnlyState>()(',
        "  persist((_set) => ({ items: [] }), { name: 'test-only', partialize: (state) => ({ items: state.items }) }),",
        ')',
      ].join('\n'),
    )

    // 16. #3993: a string literal containing `/*` (`'/* pattern'`) sits
    //     above a real non-scalar `persist()` call missing both hooks, and a
    //     real JSDoc block comment closes later in the file. The
    //     byte-identical private `stripComments` this guard used to carry is
    //     not string-aware: it reads the `/*` inside the string as a comment
    //     opener and blanks everything up to the JSDoc's `*/`, hiding the
    //     `persist(` call from `findPersistCalls` entirely and reporting the
    //     file clean. The shared scanner's `stripComments` is string-aware,
    //     so this must still be flagged. (Demonstrated verbatim in #3993.)
    w(
      'fakeCommentOpener.ts',
      [
        "import { create } from 'zustand'",
        "import { persist } from 'zustand/middleware'",
        "const GLOB = '/* pattern'",
        'interface FakeCommentState {',
        '  items: string[]',
        '}',
        'export const useFakeComment = create<FakeCommentState>()(',
        '  persist(',
        '    (set) => ({ items: [], setItems: (items) => set({ items }) }),',
        "    { name: 'fake-comment', version: 1, partialize: (state) => ({ items: state.items }) },",
        '  ),',
        ')',
        '/** trailing doc */',
      ].join('\n'),
    )

    // 17. #3993: a file with an unterminated string literal cannot be lexed
    //     unambiguously. The shared scanner fails CLOSED (throws
    //     `ScanError`), and this guard must surface that as a scanError — a
    //     FAILURE the human sees — not silently drop the file (and the real
    //     violation it also contains) from both `violations` and the
    //     scanned count.
    w(
      'unterminatedString.ts',
      [
        "import { create } from 'zustand'",
        "import { persist } from 'zustand/middleware'",
        'interface UnterminatedState { items: string[] }',
        'export const useUnterminated = create<UnterminatedState>()(',
        '  persist(',
        '    (_set) => ({ items: [] }),',
        "    { name: 'unterminated', partialize: (state) => ({ items: state.items }) },",
        '  ),',
        ')',
        "const bad = 'unterminated string literal, never closes",
      ].join('\n'),
    )

    const { violations, files, scanErrors } = analyze({ root: tmp, storesDir })
    const hit = (f) => violations.filter((v) => v.file === `src/stores/${f}`)
    const expect = (name, cond, detail) => (cond ? ok(name) : fail(name, detail))

    expect(
      'array field, both hooks missing, is flagged',
      hit('badBoth.ts').length === 1,
      JSON.stringify(violations),
    )
    expect(
      'both-missing violation lists BOTH hook names',
      hit('badBoth.ts')[0]?.missing.toSorted().join(',') === 'merge,migrate',
      JSON.stringify(hit('badBoth.ts')),
    )
    expect(
      'Record field with migrate but no merge is flagged, missing = [merge] only',
      hit('badMergeOnly.ts').length === 1 &&
        hit('badMergeOnly.ts')[0].missing.join(',') === 'merge',
      JSON.stringify(hit('badMergeOnly.ts')),
    )
    expect(
      'Record field with merge but no migrate is flagged, missing = [migrate] only (search-history.ts:173-183 shape)',
      hit('badMigrateOnly.ts').length === 1 &&
        hit('badMigrateOnly.ts')[0].missing.join(',') === 'migrate',
      JSON.stringify(hit('badMigrateOnly.ts')),
    )
    expect(
      'non-scalar store with BOTH hooks is clean',
      hit('goodBoth.ts').length === 0,
      JSON.stringify(hit('goodBoth.ts')),
    )
    expect(
      'single scalar field (string | null), no hooks, is clean — via the interface, not a filename',
      hit('scalarSingle.ts').length === 0,
      JSON.stringify(hit('scalarSingle.ts')),
    )
    expect(
      'single boolean field, no hooks, is clean',
      hit('scalarBoolean.ts').length === 0,
      JSON.stringify(hit('scalarBoolean.ts')),
    )
    expect(
      'TWO scalar fields, no hooks, is clean (not a naive single-key count)',
      hit('scalarMulti.ts').length === 0,
      JSON.stringify(hit('scalarMulti.ts')),
    )
    expect(
      'missing partialize (whole state persisted) is flagged',
      hit('noPartialize.ts').length === 1,
      JSON.stringify(hit('noPartialize.ts')),
    )
    expect(
      'bare unresolved type reference (Date) is conservatively flagged',
      hit('unresolvedType.ts').length === 1,
      JSON.stringify(hit('unresolvedType.ts')),
    )
    expect(
      'partialize delegating to a named helper is conservatively flagged',
      hit('nonInlinePartialize.ts').length === 1,
      JSON.stringify(hit('nonInlinePartialize.ts')),
    )
    expect(
      'reasoned persist-hooks-allow marker suppresses the violation',
      hit('marked.ts').length === 0,
      JSON.stringify(hit('marked.ts')),
    )
    expect(
      'persist-hooks-allow marker with an EMPTY reason does NOT suppress',
      hit('markedNoReason.ts').length === 1,
      JSON.stringify(hit('markedNoReason.ts')),
    )
    expect(
      'two stores in one file: violating store flagged, clean sibling store is not',
      hit('twoStores.ts').length === 1 && hit('twoStores.ts')[0].store === 'first',
      JSON.stringify(violations.filter((v) => v.file === 'src/stores/twoStores.ts')),
    )
    expect(
      'unrelated `persist` identifier (not the zustand shape) does not crash or flag',
      hit('unrelatedPersist.ts').length === 0,
      JSON.stringify(hit('unrelatedPersist.ts')),
    )
    expect(
      '__tests__/ files are not scanned at all',
      !files.some((f) => f.includes('__tests__')) &&
        !violations.some((v) => v.file.includes('__tests__')),
      JSON.stringify({ files, violations }),
    )

    expect(
      'a string containing `/*` above a real persist() call is still flagged (#3993)',
      hit('fakeCommentOpener.ts').length === 1,
      JSON.stringify(hit('fakeCommentOpener.ts')),
    )

    expect(
      'an unlexable file is reported as a scanError (failure), not silently skipped',
      scanErrors.some((e) => e.file === 'src/stores/unterminatedString.ts') &&
        hit('unterminatedString.ts').length === 0,
      JSON.stringify({ scanErrors, hit: hit('unterminatedString.ts') }),
    )

    // ─── prove the guard cannot match its own source or its fixtures ────
    //
    // Scope confinement, not exclusion-list confinement: the scan walks
    // ONLY `storesDir` (here the synthetic `src/stores`), so every file
    // it reports is rooted there — the guard script itself (in
    // `scripts/`) and these very fixtures (written under the OS temp dir
    // for the real run below) are structurally unreachable.
    expect(
      'every scanned file is rooted at src/stores/ (guard cannot reach its own scripts/ source)',
      files.every((f) => f.startsWith('src/stores/')),
      JSON.stringify(files),
    )

    // ─── the live tree ────────────────────────────────────────────────
    const live = analyze({ root: ROOT, storesDir: STORES_DIR })
    expect(
      'the guard scans its own source directory, not the temp fixture tree (no self-exclusion)',
      live.files.every((f) => f.startsWith('src/stores/')) && live.scanned > 0,
      `scanned=${live.scanned}`,
    )
    if (live.violations.length === 0) {
      ok(`the live tree has no non-scalar persist() missing migrate/merge (${live.scanned} files)`)
    } else {
      fail(
        'the live tree has no non-scalar persist() missing migrate/merge',
        JSON.stringify(live.violations),
      )
    }
    if (live.scanErrors.length === 0) {
      ok('the live tree has no file the shared scanner cannot lex')
    } else {
      fail(
        'the live tree has no file the shared scanner cannot lex',
        JSON.stringify(live.scanErrors),
      )
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }

  // ─── CLI-level self-test: real subprocess, real exit code ───────────
  //
  // Everything above drives scanSource()/analyze() directly and never
  // reaches process.exit() — a regression that dropped the exit(1) in
  // runGuard() while leaving analyze() correct would sail through all of
  // it. Spawn the script for real against synthetic trees and assert the
  // actual exit codes.
  //
  // check-persist-hooks.mjs resolves ROOT from its own location
  // (`import.meta.dirname`), not `cwd` — so spawning it with a different
  // `cwd` does NOT change which `src/stores` it scans. Exercising the
  // "src/stores is missing" exit(2) branch therefore requires copying the
  // script itself into a scaffold tree that has a `scripts/` dir but no
  // sibling `src/stores/`, not just spawning it against a different cwd.
  const res0 = spawnSync(process.execPath, [import.meta.filename], { encoding: 'utf8' })
  if (res0.status === 0 && res0.stdout.includes('OK:')) {
    ok('CLI exits 0 against the real repo (matches the live-tree assertion above)')
  } else {
    fail(
      'CLI exits 0 against the real repo',
      `status=${res0.status} stdout=${res0.stdout} stderr=${res0.stderr}`,
    )
  }

  const layoutTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'persist-hooks-layout-'))
  try {
    const layoutScripts = path.join(layoutTmp, 'scripts')
    const layoutLib = path.join(layoutScripts, 'lib')
    fs.mkdirSync(layoutLib, { recursive: true })
    // Deliberately no `src/stores/` created under layoutTmp — that absence
    // is what this assertion exists to catch.
    const layoutScript = path.join(layoutScripts, 'check-persist-hooks.mjs')
    fs.copyFileSync(import.meta.filename, layoutScript)
    // The guard now imports the shared scanner, so the scaffold needs it too
    // or the spawned subprocess fails on ERR_MODULE_NOT_FOUND before it ever
    // reaches the exit(2) this assertion is checking for.
    fs.copyFileSync(
      path.join(import.meta.dirname, 'lib', 'js-scanner.mjs'),
      path.join(layoutLib, 'js-scanner.mjs'),
    )
    const res2 = spawnSync(process.execPath, [layoutScript], { encoding: 'utf8' })
    if (res2.status === 2 && /expected directory not found/.test(res2.stderr)) {
      ok('CLI exits 2 when src/stores is missing (repo layout guard)')
    } else {
      fail(
        'CLI exits 2 when src/stores is missing',
        `status=${res2.status} stdout=${res2.stdout} stderr=${res2.stderr}`,
      )
    }
  } finally {
    fs.rmSync(layoutTmp, { recursive: true, force: true })
  }

  // A regression that drops the trailing `process.exit(1)` in runGuard()
  // (falling through to the `console.log('OK: ...')` success branch)
  // would print the ERROR block to stderr but still exit 0 — every
  // assertion above drives analyze()/scanSource() in-process and would
  // stay green through that regression. Spawn the real CLI against a
  // scaffold tree that DOES contain a violation and assert exit(1).
  const violTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'persist-hooks-violation-'))
  try {
    const violScripts = path.join(violTmp, 'scripts')
    const violLib = path.join(violScripts, 'lib')
    const violStores = path.join(violTmp, 'src', 'stores')
    fs.mkdirSync(violLib, { recursive: true })
    fs.mkdirSync(violStores, { recursive: true })
    fs.writeFileSync(
      path.join(violStores, 'bad.ts'),
      [
        "import { create } from 'zustand'",
        "import { persist } from 'zustand/middleware'",
        'interface BadState { items: string[] }',
        'export const useBad = create<BadState>()(',
        "  persist((_set) => ({ items: [] }), { name: 'bad', partialize: (state) => ({ items: state.items }) }),",
        ')',
      ].join('\n'),
    )
    const violScript = path.join(violScripts, 'check-persist-hooks.mjs')
    fs.copyFileSync(import.meta.filename, violScript)
    // Same as the layout scaffold above: the guard now imports the shared
    // scanner, so this scaffold needs it too.
    fs.copyFileSync(
      path.join(import.meta.dirname, 'lib', 'js-scanner.mjs'),
      path.join(violLib, 'js-scanner.mjs'),
    )
    const res1 = spawnSync(process.execPath, [violScript], { encoding: 'utf8' })
    if (
      res1.status === 1 &&
      /ERROR: persist\(\)/.test(res1.stderr) &&
      !res1.stdout.includes('OK:')
    ) {
      ok('CLI exits 1 (not the OK success path) when a real violation exists')
    } else {
      fail(
        'CLI exits 1 when a real violation exists',
        `status=${res1.status} stdout=${res1.stdout} stderr=${res1.stderr}`,
      )
    }
  } finally {
    fs.rmSync(violTmp, { recursive: true, force: true })
  }

  // A regression that drops the `process.exit(1)` in the scanErrors branch
  // of runGuard() (falling through to the violations check and then, when
  // there happen to be no OTHER violations, all the way to the
  // `console.log('OK: ...')` success branch) would print the ERROR block to
  // stderr but still exit 0. Every assertion above — including the
  // `unterminatedString.ts` fixture — drives analyze()/scanSource()
  // in-process and only inspects the RETURN VALUE's `scanErrors` array; none
  // of them ever calls process.exit() and so none would catch that
  // regression. Spawn the real CLI against a scaffold tree containing ONE
  // fully-compliant store (migrate + merge both present) plus ONE unlexable
  // file and NO other violations, so a regression that falls through to the
  // violations check genuinely finds nothing there and would incorrectly
  // print OK and exit 0. Assert the real exit code is non-zero.
  const scanErrTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'persist-hooks-scanerror-'))
  try {
    const seScripts = path.join(scanErrTmp, 'scripts')
    const seLib = path.join(seScripts, 'lib')
    const seStores = path.join(scanErrTmp, 'src', 'stores')
    fs.mkdirSync(seLib, { recursive: true })
    fs.mkdirSync(seStores, { recursive: true })
    // Fully compliant store — both hooks present, no violation.
    fs.writeFileSync(
      path.join(seStores, 'clean.ts'),
      [
        "import { create } from 'zustand'",
        "import { persist } from 'zustand/middleware'",
        'interface CleanState { items: string[] }',
        'function coerce(p: unknown) { return p as Partial<CleanState> }',
        'export const useClean = create<CleanState>()(',
        '  persist(',
        '    (_set) => ({ items: [] }),',
        '    {',
        "      name: 'clean',",
        '      version: 1,',
        '      partialize: (state) => ({ items: state.items }),',
        '      migrate: (persisted, _version) => coerce(persisted),',
        '      merge: (persisted, current) => ({ ...current, ...coerce(persisted) }),',
        '    },',
        '  ),',
        ')',
      ].join('\n'),
    )
    // Unlexable file with NO persist() call at all, so it contributes
    // nothing to `violations` — its only effect is a scanError.
    fs.writeFileSync(
      path.join(seStores, 'broken.ts'),
      "const bad = 'unterminated string literal, never closes\n",
    )
    const seScript = path.join(seScripts, 'check-persist-hooks.mjs')
    fs.copyFileSync(import.meta.filename, seScript)
    fs.copyFileSync(
      path.join(import.meta.dirname, 'lib', 'js-scanner.mjs'),
      path.join(seLib, 'js-scanner.mjs'),
    )
    const resSE = spawnSync(process.execPath, [seScript], { encoding: 'utf8' })
    if (
      resSE.status === 1 &&
      /could not be scanned unambiguously/.test(resSE.stderr) &&
      !resSE.stdout.includes('OK:')
    ) {
      ok('CLI exits 1 (not OK) when a file cannot be scanned, even with no other violations')
    } else {
      fail(
        'CLI exits 1 when a file cannot be scanned (scanErrors branch), even with no other violations',
        `status=${resSE.status} stdout=${resSE.stdout} stderr=${resSE.stderr}`,
      )
    }
  } finally {
    fs.rmSync(scanErrTmp, { recursive: true, force: true })
  }

  if (failures.length > 0) {
    console.error(`\nself-test: ${failures.length} assertion(s) failed`)
    process.exit(2)
  }
  console.log('self-test: all assertions passed')
}
