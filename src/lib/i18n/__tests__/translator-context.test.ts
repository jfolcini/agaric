/**
 * Every English catalog key carries translator context (#6750).
 *
 * A translator sees a key and its English text, which is often ambiguous
 * ("Open", "Daily", "Clear"). So every key sits in a group — a run of lines
 * with no blank line — that has a `// Translators:` comment saying where the
 * string appears, what kind of text it is, and what its placeholders hold.
 * `docs/TRANSLATING.md` explains how to write one.
 *
 * The scan is line-based over the oxfmt-formatted namespace files. It fails
 * closed: the keys it finds must be exactly the merged English catalog, so a
 * file it cannot read is a failure, never "nothing to check".
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { i18n } from '@/lib/i18n'
import { DEFAULT_LOCALE } from '@/lib/i18n/locales'

// The runner's cwd is the project root (see catalog-parity.test.ts).
const CATALOG_DIR = join(process.cwd(), 'src', 'lib', 'i18n')
const NOT_A_NAMESPACE = new Set(['index.ts', 'locales.ts', 'set-locale.ts'])

const OBJECT_START = /^export const \w+: Record<string, string> = \{$/
const KEY_LINE = /^\s*'([^']+)':/
const CONTEXT_LINE = /^\s*\/\/ Translators: \S/

interface Scan {
  keys: string[]
  uncovered: string[]
}

function scan(source: string): Scan {
  const keys: string[] = []
  const uncovered: string[] = []
  let inObject = false
  let covered = false
  for (const line of source.split('\n')) {
    if (!inObject) {
      inObject = OBJECT_START.test(line)
      continue
    }
    if (line === '}') break
    if (line.trim() === '') covered = false
    else if (CONTEXT_LINE.test(line)) covered = true
    else {
      const key = KEY_LINE.exec(line)?.[1]
      if (key === undefined) continue
      keys.push(key)
      if (!covered) uncovered.push(key)
    }
  }
  return { keys, uncovered }
}

const files = readdirSync(CATALOG_DIR).filter(
  (name) => name.endsWith('.ts') && !NOT_A_NAMESPACE.has(name),
)
const scans = files.map((name) =>
  Object.assign(scan(readFileSync(join(CATALOG_DIR, name), 'utf8')), { name }),
)

describe('translator context in the English catalog', () => {
  it('scans exactly the keys of the merged English catalog', () => {
    const en = i18n.getResourceBundle(DEFAULT_LOCALE, 'translation') as Record<string, string>
    expect(scans.flatMap((s) => s.keys).toSorted()).toEqual(Object.keys(en).toSorted())
  })

  it.each(scans)('$name gives every key a // Translators: note', ({ name, uncovered }) => {
    if (uncovered.length === 0) return
    const list = uncovered.map((key) => `  - ${key}`).join('\n')
    expect.fail(
      `${uncovered.length} key(s) in src/lib/i18n/${name} have no "// Translators:" comment in ` +
        `their group (a run of lines with no blank line). Say where the string appears, what ` +
        `kind of text it is and what its placeholders hold — see docs/TRANSLATING.md:\n${list}`,
    )
  })

  it('reports a key whose group has no note (the scan, exercised directly)', () => {
    const source = [
      'export const demo: Record<string, string> = {',
      '  // Translators: a covered group.',
      "  'demo.covered': 'Covered',",
      '',
      '  // A developer note is not translator context.',
      "  'demo.uncovered': 'Uncovered',",
      '}',
    ].join('\n')
    expect(scan(source)).toEqual({
      keys: ['demo.covered', 'demo.uncovered'],
      uncovered: ['demo.uncovered'],
    })
  })
})
