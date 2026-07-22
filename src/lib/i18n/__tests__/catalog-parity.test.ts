/**
 * #2946 — exhaustive missing-key guard for the i18n catalog.
 *
 * `src/lib/__tests__/i18n.test.ts` only checks a hand-curated list of ~80
 * keys, so a `t('some.new.key', { defaultValue: '...' })` call site can ship
 * with no matching catalog entry (see #2917) and nothing fails. This suite
 * statically scans every `.ts`/`.tsx` file under `src/` for string-literal
 * `t('...')` / `translate('...')` first-arguments and asserts each one
 * resolves against the SAME merged `en.translation` resource the app uses
 * at runtime (imported from `@/lib/i18n`, not re-implemented here).
 *
 * Two tests:
 *  - "no missing keys" — hard, must-pass. Every literal key found in the
 *    scan must exist in the catalog (accounting for i18next plural
 *    suffixes). This is the reliable regression guard #2946 asks for.
 *  - "no orphan keys" — soft/informational. The inverse (catalog keys never
 *    referenced) is measurably noisy in this codebase: dynamic keys built
 *    from template literals (`t(\`callout.${type}\`)`) and lookup tables
 *    (`{ Today: 'agenda.today' }`, later passed to `t(dynamicVar)`) can't be
 *    resolved by a static regex scan. A hard-failing version of this check
 *    was prototyped and produced 260+ false-positive "orphans" even after
 *    two rounds of heuristics — see the comment on `KNOWN_DYNAMIC_PREFIXES`
 *    below. Per #2946's own guidance ("a flaky guard is worse than none"),
 *    this is kept informational: it reports candidates via console.info but
 *    never fails the suite.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { i18n } from '@/lib/i18n'

// vitest's happy-dom environment rewrites `import.meta.url` to an http://
// URL, so `fileURLToPath(import.meta.url)` throws at collection time in some
// run modes. The test runner's cwd is always the project root, so resolve
// the scan root from there instead (same pattern as
// keyboard-config-rebindable-drift.test.ts).
const SRC_ROOT = join(process.cwd(), 'src')

// Directories/files to skip while walking `src/`.
function shouldSkipDir(name: string): boolean {
  return name === '__tests__' || name === 'node_modules'
}

function isScannableFile(name: string): boolean {
  if (!/\.(ts|tsx)$/.test(name)) return false
  if (name.endsWith('.d.ts')) return false
  if (/\.(test|spec)\.(ts|tsx)$/.test(name)) return false
  return true
}

function collectSourceFiles(dir: string, out: string[]): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (shouldSkipDir(entry.name)) continue
      collectSourceFiles(p, out)
    } else if (isScannableFile(entry.name)) {
      out.push(p)
    }
  }
  return out
}

// The i18n catalog source files themselves (`src/lib/i18n/*.ts`) are the
// definitions, not call sites — they contain no `t(...)` calls, but are
// excluded explicitly per the issue's instructions rather than relying on
// that incidentally being true.
function isCatalogSourceFile(path: string): boolean {
  return path.replace(/\\/g, '/').includes('/lib/i18n/')
}

/**
 * Strip `//` and `/* *\/` comments from source text before scanning, while
 * leaving string/template literal contents untouched (so nested calls like
 * `` `${t('foo')}` `` are still found, and so a `//` inside a URL string
 * isn't mistaken for a line comment). Without this, JSDoc examples like
 * `t('agenda.noPriority')` in a comment produce false "missing key" hits
 * for keys that were never a real call site (measured: 3 false positives
 * on this codebase before comment-stripping was added).
 */
function stripComments(src: string): string {
  let out = ''
  let i = 0
  const n = src.length
  let inLineComment = false
  let inBlockComment = false
  let inString: string | null = null
  while (i < n) {
    const c = src[i]
    const c2 = i + 1 < n ? src[i + 1] : ''
    if (inLineComment) {
      if (c === '\n') {
        inLineComment = false
        out += c
      }
      i++
      continue
    }
    if (inBlockComment) {
      if (c === '*' && c2 === '/') {
        inBlockComment = false
        i += 2
        continue
      }
      if (c === '\n') out += c
      i++
      continue
    }
    if (inString) {
      out += c
      if (c === '\\') {
        out += c2
        i += 2
        continue
      }
      if (c === inString) inString = null
      i++
      continue
    }
    if (c === '/' && c2 === '/') {
      inLineComment = true
      i += 2
      continue
    }
    if (c === '/' && c2 === '*') {
      inBlockComment = true
      i += 2
      continue
    }
    if (c === "'" || c === '"' || c === '`') {
      inString = c
      out += c
      i++
      continue
    }
    out += c
    i++
  }
  return out
}

// Matches `t(...)` and `translate(...)` calls (the two names used to invoke
// i18next's translator across this codebase — see `useTranslation()`
// destructuring and `import { t as translate } from '@/lib/i18n'`).
// `\b` before the callee name means `i18n.t(...)` and `ctx.t(...)` also
// match (boundary between `.` and `t`), which is intentional — those are
// real call sites. Only a plain single- or double-quoted string
// immediately following the paren counts as a literal key; template
// literals, identifiers, and member expressions (dynamic keys) are
// intentionally NOT matched.
const CALL_RE = /\b(?:translate|t)\(\s*(['"])((?:\\.|(?!\1).)*)\1/g

interface KeyUsage {
  key: string
  files: Set<string>
}

function scanLiteralKeyUsages(): Map<string, KeyUsage> {
  const usages = new Map<string, KeyUsage>()
  const files = collectSourceFiles(SRC_ROOT, []).filter((f) => !isCatalogSourceFile(f))
  for (const file of files) {
    const raw = readFileSync(file, 'utf8')
    const text = stripComments(raw)
    for (const m of text.matchAll(CALL_RE)) {
      const key = m[2]
      if (key === undefined) continue
      const relFile = file.slice(SRC_ROOT.length + 1)
      const existing = usages.get(key)
      if (existing) {
        existing.files.add(relFile)
      } else {
        usages.set(key, { key, files: new Set([relFile]) })
      }
    }
  }
  return usages
}

const PLURAL_SUFFIXES = ['_one', '_other', '_zero', '_few', '_many', '_two']

function keyExistsInCatalog(key: string, catalog: Record<string, string>): boolean {
  if (key in catalog) return true
  return PLURAL_SUFFIXES.some((suf) => `${key}${suf}` in catalog)
}

/**
 * KNOWN_MISSING — allowlist for catalog keys that genuinely resolve to
 * nothing at the time this guard was introduced, so a real (not-yet-fixed)
 * gap doesn't block landing the guard itself.
 *
 * Measured at introduction (after the #2917 fix for `history.foreignOp` and
 * `search.filterHelper.dateInvalid`): EMPTY. Every literal `t()`/
 * `translate()` key found by the scan resolves in the merged catalog.
 * Left as an explicit empty array (rather than omitted) so a future
 * regression has an obvious place to go if it needs a temporary escape
 * hatch — each entry must carry a TODO with an issue reference.
 */
const KNOWN_MISSING: ReadonlySet<string> = new Set([])

describe('i18n catalog parity — missing keys (#2946)', () => {
  const catalog = i18n.getResourceBundle('en', 'translation') as Record<string, string>
  const usages = scanLiteralKeyUsages()

  it('scan sanity: found a realistic number of literal t() call sites', () => {
    // Guards against the regex silently rotting (e.g. a rename of the `t`/
    // `translate` convention) and every other test in this file passing
    // vacuously because the scan found nothing.
    expect(usages.size).toBeGreaterThan(500)
  })

  it('every literal t()/translate() key resolves in the merged English catalog', () => {
    const missing = [...usages.values()].filter(
      (u) => !keyExistsInCatalog(u.key, catalog) && !KNOWN_MISSING.has(u.key),
    )

    if (missing.length > 0) {
      const report = missing
        .map((u) => `  - "${u.key}"  (used in: ${[...u.files].toSorted().join(', ')})`)
        .join('\n')
      expect.fail(
        `${missing.length} i18n key(s) are referenced via t()/translate() but are not defined ` +
          `in the merged catalog (src/lib/i18n/*.ts). Add each key to the namespace file that ` +
          `owns its first dotted segment:\n${report}`,
      )
    }
  })
})

// ── Orphan keys (informational, non-failing) ────────────────────────────

/**
 * Prefixes for key families that are always constructed dynamically
 * (template literals or lookup tables), so the static scan above never
 * records a literal usage for their individual members even though they
 * are genuinely referenced at runtime. Compiled by hand from the call
 * sites that build keys this way (e.g. `t(\`callout.${type}\`)` in
 * editor-toolbar/CalloutTypeSelector.tsx). Not exhaustive — this list only
 * feeds the informational report below, never a failing assertion.
 */
const KNOWN_DYNAMIC_PREFIXES = [
  'advancedQuery.aggregate.op.',
  'advancedQuery.aggregate.target.',
  'advancedQuery.sort.column.',
  'advancedQuery.group.',
  'callout.',
  'pageBrowser.filter.blockType.',
  'pageBrowser.filter.lastEdited.',
  'filter.dimension.',
  'queryBuilder.readable.op.',
  'queryBuilder.mode.',
  'queryBuilder.type.',
  'graph.filter.statusValue.',
  'graph.filter.priorityValue.',
  'graph.filter.',
  'history.opTypeDescription.',
  'pairing.ordinal.',
  'contextMenu.turnIntoType.',
]

function baseKey(key: string): string {
  const suffix = PLURAL_SUFFIXES.find((s) => key.endsWith(s))
  return suffix ? key.slice(0, -suffix.length) : key
}

describe('i18n catalog parity — orphan keys (informational)', () => {
  it('reports catalog keys with no detected literal or table-value reference', () => {
    const catalog = i18n.getResourceBundle('en', 'translation') as Record<string, string>
    const usages = scanLiteralKeyUsages()
    const usedBaseKeys = new Set([...usages.keys()].map(baseKey))

    // Second, broader signal: a lookup table like
    // `{ Today: 'agenda.today' }` (AgendaResults.tsx) references a key as a
    // plain string literal without going through a `t(...)` call at that
    // site — the key travels through a variable to a later `t(dynamicVar)`
    // call. Treat ANY quoted string literal in the codebase that exactly
    // matches a catalog key as a usage signal too, to cut down noise.
    const anyStringLiteral = new Set<string>()
    const STRING_LITERAL_RE = /(['"])((?:\\.|(?!\1).)*)\1/g
    for (const file of collectSourceFiles(SRC_ROOT, [])) {
      if (isCatalogSourceFile(file)) continue
      const text = stripComments(readFileSync(file, 'utf8'))
      for (const m of text.matchAll(STRING_LITERAL_RE)) {
        if (m[2] !== undefined) anyStringLiteral.add(m[2])
      }
    }

    const orphans = Object.keys(catalog).filter((key) => {
      const b = baseKey(key)
      if (usedBaseKeys.has(b)) return false
      if (anyStringLiteral.has(key) || anyStringLiteral.has(b)) return false
      if (KNOWN_DYNAMIC_PREFIXES.some((prefix) => key.startsWith(prefix))) return false
      return true
    })

    if (orphans.length > 0) {
      console.info(
        `[catalog-parity] ${orphans.length} catalog key(s) have no detected reference ` +
          `(informational only — static scanning of dynamically-constructed keys is unreliable, ` +
          `see the file header comment). Sample:\n${orphans
            .slice(0, 25)
            .map((k) => `  - "${k}"`)
            .join('\n')}`,
      )
    }

    // Sanity only: the scan itself must have run and the catalog must be
    // non-empty. This test intentionally never fails on the orphan count —
    // a flaky "no orphans" guard was measured to be worse than no guard at
    // all in this codebase (260+ false positives after two heuristics).
    expect(Object.keys(catalog).length).toBeGreaterThan(0)
  })
})
