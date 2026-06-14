/**
 * #724 drift test — pins the Settings-tab rebindable inventory against the
 * shortcuts that are ACTUALLY consumed through the keyboard config.
 *
 * The Settings tab offers an edit affordance for every catalog entry whose
 * `rebindable` flag is not `false`. A rebind is only honoured when the
 * consumption site reads the binding through `matchesShortcutBinding` /
 * `getShortcutKeys` (directly or via a `binding:` dispatch-table entry).
 * This test scans `src/` for those consumption sites and asserts a strict
 * 1:1 mapping:
 *
 *  - every entry presented as rebindable IS consumed through the config
 *    (no "rebind saved but the old key still fires" regressions), and
 *  - every `rebindable: false` entry is NOT consumed through the config
 *    (if someone routes it later, the flag must be lifted so users regain
 *    the affordance).
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { DEFAULT_SHORTCUTS } from '../keyboard-config'

// vitest's happy-dom environment rewrites `import.meta.url` to an http://
// URL, so fileURLToPath(import.meta.url) throws at collection time in some
// run modes (notably the pre-commit hook). The test runner's cwd is always
// the project root, so resolve the scan root from there instead.
const SRC_ROOT = join(process.cwd(), 'src')

function collectSourceFiles(dir: string, out: string[]): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue
      collectSourceFiles(p, out)
    } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\./.test(entry.name)) {
      out.push(p)
    }
  }
  return out
}

/** Literal id passed to the matcher: `matchesShortcutBinding(e, 'zoomOut')`. */
const LITERAL_MATCH = /matchesShortcutBinding\([^,)]*,\s*'([A-Za-z0-9]+)'/g
/** Template id with a numeric suffix: `matchesShortcutBinding(e, \`heading${level}\`)`. */
const TEMPLATE_MATCH = /matchesShortcutBinding\([^,)]*,\s*`([A-Za-z0-9]+)\$\{/g
/** Literal id read through storage: `getShortcutKeys('closeTabOnFocus')`. */
const LITERAL_KEYS = /getShortcutKeys\(\s*'([A-Za-z0-9]+)'\s*\)/g
/**
 * Literal id consumed via the #789 TipTap keymap helper:
 * `tipTapShortcutMap('underline', …)`. Same contract as `getShortcutKeys` —
 * the helper reads the binding through `getShortcutKeys` internally and
 * expands ` / ` alternatives into multiple keymap entries.
 */
const LITERAL_TIPTAP_MAP = /tipTapShortcutMap\(\s*'([A-Za-z0-9]+)'/g
/** Dispatch-table entries (`JOURNAL_SHORTCUTS` / `TAB_SHORTCUTS`): `binding: 'goToToday'`. */
const BINDING_FIELD = /\bbinding:\s*'([A-Za-z0-9]+)'/g

function extractConsumedIds(): Set<string> {
  const catalogIds = new Set(DEFAULT_SHORTCUTS.map((s) => s.id))
  const consumed = new Set<string>()
  const templatePrefixes = new Set<string>()

  for (const file of collectSourceFiles(SRC_ROOT, [])) {
    const text = readFileSync(file, 'utf8')
    for (const re of [LITERAL_MATCH, LITERAL_KEYS, LITERAL_TIPTAP_MAP, BINDING_FIELD]) {
      for (const m of text.matchAll(re)) {
        const id = m[1] as string
        if (catalogIds.has(id)) consumed.add(id)
      }
    }
    for (const m of text.matchAll(TEMPLATE_MATCH)) {
      templatePrefixes.add(m[1] as string)
    }
  }

  // Expand template prefixes (`heading${level}`, `switchSpace${n}`) against
  // the catalog: every id of the form `<prefix><digits>` is consumed.
  for (const prefix of templatePrefixes) {
    for (const id of catalogIds) {
      if (id.startsWith(prefix) && /^\d+$/.test(id.slice(prefix.length))) {
        consumed.add(id)
      }
    }
  }
  return consumed
}

describe('#724 — rebindable catalog inventory matches actual config consumption', () => {
  const consumed = extractConsumedIds()

  it('every entry the Settings tab offers for rebinding is consumed through the config', () => {
    for (const s of DEFAULT_SHORTCUTS) {
      if (s.rebindable === false) continue
      expect(
        consumed.has(s.id),
        `"${s.id}" is presented as rebindable in Settings but no consumption site routes it ` +
          `through matchesShortcutBinding/getShortcutKeys — a saved rebind would be dead. ` +
          `Route the listener through the config or mark the entry \`rebindable: false\`.`,
      ).toBe(true)
    }
  })

  it('every rebindable:false entry is NOT consumed through the config', () => {
    for (const s of DEFAULT_SHORTCUTS) {
      if (s.rebindable !== false) continue
      expect(
        consumed.has(s.id),
        `"${s.id}" is marked rebindable: false but IS consumed through the config — ` +
          `lift the flag so users get the edit affordance back.`,
      ).toBe(false)
    }
  })

  it('sanity: the scan found a realistic number of consumed ids', () => {
    // Guard against the regexes silently rotting (e.g. a rename of
    // matchesShortcutBinding) and the suite passing vacuously.
    expect(consumed.size).toBeGreaterThan(30)
  })
})
