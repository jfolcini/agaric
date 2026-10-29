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
 * "no missing keys" is the hard, must-pass guard: every literal key found in
 * the scan must exist in the catalog (accounting for i18next plural
 * suffixes). The inverse (catalog keys never referenced) is not checked: dynamic
 * keys built from template literals (`t(\`callout.${type}\`)`) and lookup tables
 * (`{ Today: 'agenda.today' }`, later passed to `t(dynamicVar)`) cannot be
 * resolved by a static regex scan, and a hard-failing version produced 260+
 * false-positive "orphans" even after two rounds of heuristics (#2946: "a flaky
 * guard is worse than none").
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

// ── Plural forms for {{count}}-interpolating keys (#3860) ───────────────

/**
 * `trash.emptyTrashPartial` (and siblings `trash.allPurged`,
 * `trash.allRestored`, …) interpolated `{{count}}` with no `_one`/`_other`
 * plural forms, so a count of 1 rendered the "_other"-shaped English text
 * verbatim ("Removed 1 items…") while the `announce.*` equivalent — which
 * DID carry plural forms — rendered correctly ("Removed 1 item…") for the
 * same user action. See #3860.
 *
 * This catalog uses two valid plural patterns, both of which i18next
 * resolves correctly:
 *   1. An explicit `key_one` / `key_other` pair.
 *   2. A bare `key` doubling as the singular form, with only `key_other`
 *      added alongside it — i18next falls back to the bare key for
 *      count === 1 when no `key_one` variant exists (e.g.
 *      `graph.local.depthOption` / `graph.local.depthOption_other`).
 *
 * The one shape that is wrong for every count is a bare `key` that
 * interpolates `{{count}}` with NO `_other` sibling at all: every count
 * then renders the identical (singular-shaped) string.
 */
function findCountPluralViolations(catalog: Record<string, string>): string[] {
  interface Coverage {
    hasPlain: boolean
    hasOne: boolean
    hasOther: boolean
    interpolatesCount: boolean
  }
  const bases = new Map<string, Coverage>()
  for (const [key, value] of Object.entries(catalog)) {
    const suffix = PLURAL_SUFFIXES.find((s) => key.endsWith(s))
    const base = suffix ? key.slice(0, -suffix.length) : key
    const entry = bases.get(base) ?? {
      hasPlain: false,
      hasOne: false,
      hasOther: false,
      interpolatesCount: false,
    }
    if (!suffix) entry.hasPlain = true
    if (suffix === '_one') entry.hasOne = true
    if (suffix === '_other') entry.hasOther = true
    if (value.includes('{{count}}')) entry.interpolatesCount = true
    bases.set(base, entry)
  }

  const violations: string[] = []
  for (const [base, entry] of bases) {
    if (!entry.interpolatesCount) continue
    const hasSingularForm = entry.hasOne || entry.hasPlain
    if (!(hasSingularForm && entry.hasOther)) {
      violations.push(base)
    }
  }
  return violations.toSorted()
}

/**
 * #3882 drained #3860's original `PRE_EXISTING_COUNT_WITHOUT_PLURAL`
 * allowlist to empty and split it into two lists that couldn't be told
 * apart before: keys that genuinely still need plural forms (shrinks over
 * time, and is capped so it can't silently regrow — see
 * `NOT_YET_FIXED_CEILING` below) and keys that are deliberately exempt,
 * each with a stated reason (grows only when a new key is audited and
 * found not to need plural forms; a reason is mandatory).
 *
 * PRE_EXISTING_COUNT_NOT_YET_FIXED — count-interpolating keys that ARE
 * real "N items" grammar bugs and have not been fixed yet. #3882 fixed
 * every key #3860 left behind (18 of them), so this starts empty. Fixing an
 * entry must delete it from this set in the SAME change — the "no stale
 * entries" test below fails if you forget, same mechanism as #3860.
 */
const PRE_EXISTING_COUNT_NOT_YET_FIXED: ReadonlySet<string> = new Set([])

/**
 * NOT_YET_FIXED_CEILING — the maximum size `PRE_EXISTING_COUNT_NOT_YET_FIXED`
 * may EVER be. This is the ratchet #3882 asked for: nothing stopped a
 * developer from silencing a new violation by quietly appending to the old
 * single allowlist, and a 35-entry array made one more line easy to miss in
 * review. A ceiling constant does not make that impossible — a change to a
 * test file is still just a diff — but it makes the growth a loud, single,
 * self-explanatory line instead of an invisible one, which is what "closing
 * caveat 2" means in a repo where review is the actual enforcement
 * mechanism.
 *
 * Do NOT raise this to make room for a new entry. Fix the plural forms in
 * the same change instead (namespace file + this test file), per #3882's
 * own instructions to #3860. It exists as an escape hatch only for a
 * genuinely blocking reason a reviewer signs off on — that is a decision
 * for code review, not something this file can gate alone.
 */
const NOT_YET_FIXED_CEILING = 0

/**
 * PRE_EXISTING_COUNT_EXEMPT — count-interpolating keys that are NOT grammar
 * bugs, each with the reason it's exempt. Every entry falls into one of
 * four shapes, audited key-by-key against its real call site(s) as part of
 * #3882 (not pre-judged from the key name):
 *
 *  - Manual singular/plural split via a SEPARATE catalog key, chosen by a
 *    ternary at the call site (mirrors i18next's own `_one`/`_other`
 *    selection, just not through i18next's suffix mechanism, so the static
 *    scan below can't see it). The base key here is provably never invoked
 *    with count === 1.
 *  - No inflecting noun: the text is an adjective/participle ("selected")
 *    with no plural form, so it reads correctly at every count already.
 *  - An abbreviated unit ("{{count}}m ago") rather than a spelled-out noun;
 *    abbreviations don't visibly inflect in English.
 *  - The interpolated value is provably never rendered (discarded by the
 *    call site before the text reaches the screen), or is a bare number
 *    with no surrounding word to inflect.
 *
 * New entries need a real reason from this list (or a new, equally
 * concrete one) — "audited and skipped" is not a reason. The "no stale
 * entries" test below also covers this map: if a key's wording changes
 * such that it's no longer count-invariant, remove it here and give it
 * `_one`/`_other` forms instead.
 */
const PRE_EXISTING_COUNT_EXEMPT: Readonly<Record<string, string>> = {
  // Manual split via a separate catalog key, chosen by a call-site ternary.
  'donePanel.header':
    'Singular case handled by the separate "donePanel.headerOne" key; ' +
    'DonePanel.tsx only calls this key when totalCount !== 1.',
  'duePanel.header':
    'Singular case handled by the separate "duePanel.headerOne" key; ' +
    'DuePanel.tsx only calls this key when visibleCount !== 1.',
  'agenda.resultCount':
    'Singular case handled by the separate "agenda.resultOne" key; ' +
    'AgendaResults.tsx only calls this key when blocks.length !== 1.',
  'agendaFilter.filtersApplied':
    'Singular case handled by the separate "agendaFilter.filterAppliedOne" key; ' +
    'AgendaFilterBuilder.tsx only calls this key when filters.length !== 1.',
  'references.header':
    'Singular case handled by the separate "references.headerOne" key; ' +
    'LinkedReferences.tsx only calls this key when totalCount !== 1.',
  'unlinkedRefs.header':
    'Singular/empty cases handled by the separate "unlinkedRefs.headerOne"/' +
    '"unlinkedRefs.headerNone" keys; UnlinkedReferences.tsx only calls this ' +
    'key when totalCount is neither 0 nor 1.',
  'tagFilter.blockMatchOne':
    'Paired with a wholly separate "tagFilter.blockMatchMany" key. ' +
    'TagFilterPanel.tsx ternary-selects between them on resultCount === 1, ' +
    'so despite its {{count}} interpolation this key is only ever invoked ' +
    'with count === 1, where "block matches" is already correct.',
  'tagFilter.blockMatchMany':
    'The count !== 1 counterpart of "tagFilter.blockMatchOne" (see that ' +
    'entry) — only ever invoked with count !== 1.',
  'search.matchCountInGroupPlural':
    'SearchResultGroups.tsx only invokes this key when g.blocks.length !== 1; ' +
    'count === 1 uses the separate, non-interpolating ' +
    '"search.matchCountInGroupSingular" ("1 match") key instead.',
  // No inflecting noun — adjective/participle text, identical at every count.
  'contextMenu.deleteSelected':
    '"{{count}} selected" — "selected" is an adjective with no plural form; ' +
    'the text is grammatically identical for every count.',
  'batch.selectedCount':
    'Same shape as contextMenu.deleteSelected — "{{count}} selected" has no ' + 'noun to inflect.',
  // Abbreviated unit, not a spelled-out noun — doesn't visibly inflect.
  'sidebar.minutesAgo': '"{{count}}m ago" — an abbreviated unit ("m"), not a spelled-out noun.',
  'sidebar.hoursAgo': '"{{count}}h ago" — an abbreviated unit ("h"), not a spelled-out noun.',
  'sidebar.daysAgo': '"{{count}}d ago" — an abbreviated unit ("d"), not a spelled-out noun.',
  // Bare number / interpolated value never actually rendered.
  'references.filtersAppliedBadge':
    'Value is literally "{{count}}" with no surrounding word — this is the ' +
    'visible badge digit only. The accessible name for the same control ' +
    '("references.filtersAppliedAriaLabel") already carries full ' +
    '_one/_other plural forms.',
  'compaction.totalOps':
    "CompactionCard.tsx only consumes `.split(':')[0]` of this string — the " +
    'interpolated count is discarded before render; the actual number ' +
    'renders separately in a <dd>. "operations" here is a fixed category ' +
    'label ("Total operations:"), not a count-agreeing noun.',
  'compaction.eligibleOps':
    'Same pattern as compaction.totalOps — CompactionCard.tsx discards the ' +
    "interpolated value via `.split(':')[0]` and renders the number " +
    'separately.',
}

describe('i18n catalog — plural forms for {{count}}-interpolating keys (#3860, #3882)', () => {
  const catalog = i18n.getResourceBundle('en', 'translation') as Record<string, string>

  it('scan sanity: recognizes both plural patterns used in this catalog', () => {
    // Explicit _one/_other pair (this PR's fix for trash.*).
    expect(catalog['trash.allPurged_one']).toBeDefined()
    expect(catalog['trash.allPurged_other']).toBeDefined()
    // Bare-key-as-singular + _other pair (pre-existing pattern elsewhere).
    expect(catalog['graph.local.depthOption']).toBeDefined()
    expect(catalog['graph.local.depthOption_other']).toBeDefined()
  })

  it('every {{count}}-interpolating key has plural forms, outside the not-yet-fixed/exempt lists', () => {
    const violations = findCountPluralViolations(catalog).filter(
      (base) =>
        !PRE_EXISTING_COUNT_NOT_YET_FIXED.has(base) &&
        !Object.hasOwn(PRE_EXISTING_COUNT_EXEMPT, base),
    )

    if (violations.length > 0) {
      const report = violations.map((k) => `  - "${k}"`).join('\n')
      expect.fail(
        `${violations.length} i18n key(s) interpolate {{count}} without complete plural forms ` +
          `(count === 1 will render the same "_other"-shaped wording, e.g. "1 items"):\n${report}\n` +
          `Add "<key>_one" and "<key>_other" (or a bare "<key>" singular plus "<key>_other") to ` +
          `the namespace file that owns each key, or — if it's genuinely not a grammar bug — add ` +
          `it to PRE_EXISTING_COUNT_EXEMPT with a stated reason.`,
      )
    }
  })

  it('rejects a NEW unexempt {{count}} violation (the guard, exercised directly)', () => {
    // #3882 caveat: demonstrates the detection + filtering pipeline itself
    // catches a fresh violation that is in neither list, independent of
    // whatever the real catalog's current contents happen to be.
    const fakeCatalog = {
      ...catalog,
      'zzGuardTest.newViolation': '{{count}} new thing(s) with no plural forms',
    }
    const violations = findCountPluralViolations(fakeCatalog).filter(
      (base) =>
        !PRE_EXISTING_COUNT_NOT_YET_FIXED.has(base) &&
        !Object.hasOwn(PRE_EXISTING_COUNT_EXEMPT, base),
    )
    expect(violations).toContain('zzGuardTest.newViolation')
  })

  it('PRE_EXISTING_COUNT_NOT_YET_FIXED never grows past its ceiling (#3882 ratchet)', () => {
    expect(PRE_EXISTING_COUNT_NOT_YET_FIXED.size).toBeLessThanOrEqual(NOT_YET_FIXED_CEILING)
  })

  it('PRE_EXISTING_COUNT_NOT_YET_FIXED / PRE_EXISTING_COUNT_EXEMPT have no stale (already-fixed) entries', () => {
    const stillBroken = new Set(findCountPluralViolations(catalog))
    const allListed = [
      ...PRE_EXISTING_COUNT_NOT_YET_FIXED,
      ...Object.keys(PRE_EXISTING_COUNT_EXEMPT),
    ]
    const stale = allListed.filter((base) => !stillBroken.has(base))

    if (stale.length > 0) {
      expect.fail(
        `${stale.length} PRE_EXISTING_COUNT_NOT_YET_FIXED/PRE_EXISTING_COUNT_EXEMPT entries now ` +
          `have complete plural forms — remove them:\n${stale.map((k) => `  - "${k}"`).join('\n')}`,
      )
    }
  })
})

/**
 * #3882 — direct catalog-literal checks for the three plural-form fixes
 * whose call sites can't be pinned by a component render test the way the
 * others in this PR are:
 *
 *  - `blockTree.deletedMessageUndo` / `blockTree.repeatLimitedMessage` are
 *    consumed through `ctx.t`/`notify.success` inside
 *    use-block-multi-select.ts / useSlashCommandProperty.ts, whose existing
 *    test suites stub `ctx.t` to `(key) => key` (deliberately decoupled from
 *    catalog text — see makeSyntheticCtx / use-block-multi-select.test.ts),
 *    so no render of those call sites goes through the real translator.
 *  - `pageBrowser.loadedMorePages` is a live-region announcement gated on an
 *    infinite-scroll length delta inside a component (PageBrowser.tsx) whose
 *    existing test suites are heavily mocked around IPC paging, not around
 *    driving `pages.length` by a controlled delta of exactly 1.
 *
 * These assert the real i18next output against a hardcoded literal (not
 * re-derived via the same t() call), so a catalog regression reddens them
 * the same way the render tests do — just without the DOM in between.
 */
describe('i18n catalog — plural forms, direct literal checks (#3882)', () => {
  it('blockTree.deletedMessageUndo', () => {
    expect(i18n.t('blockTree.deletedMessageUndo', { count: 1 })).toBe(
      'Deleted 1 block — Ctrl+Z to undo',
    )
    expect(i18n.t('blockTree.deletedMessageUndo', { count: 3 })).toBe(
      'Deleted 3 blocks — Ctrl+Z to undo',
    )
  })

  it('blockTree.repeatLimitedMessage', () => {
    expect(i18n.t('blockTree.repeatLimitedMessage', { count: 1 })).toBe(
      'Repeat limited to 1 occurrence',
    )
    expect(i18n.t('blockTree.repeatLimitedMessage', { count: 5 })).toBe(
      'Repeat limited to 5 occurrences',
    )
  })

  it('pageBrowser.loadedMorePages', () => {
    expect(i18n.t('pageBrowser.loadedMorePages', { count: 1 })).toBe('Loaded 1 more page')
    expect(i18n.t('pageBrowser.loadedMorePages', { count: 4 })).toBe('Loaded 4 more pages')
  })
})
