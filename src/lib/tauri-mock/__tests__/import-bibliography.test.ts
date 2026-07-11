/**
 * #1454 — `import_bibliography` mock handler.
 *
 * The handler is a DELIBERATE APPROXIMATION (see its doc comment in
 * `../handlers.ts`): it parses nothing and derives the entry count trivially
 * (BibTeX `@type{` prefixes / CSL-JSON array length). These tests pin that
 * simulation — counts, page creation + space stamping, auto-detect, and the
 * `AppError`-shaped validation rejection (#2463 error-shape parity) — NOT the
 * real parsing contract, which is owned by the Rust tests.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import { isAppError, isValidation } from '../../app-error'
import { dispatch } from '../handlers'
import { blocks, makeBlock, properties } from '../seed'

const SPACE = 'SPACE_PERSONAL'

interface ImportBibliographyResult {
  pages_created: number
  entries_skipped: number
  properties_set: number
  warnings: string[]
}

function importBibliography(
  content: string,
  format: string | null,
  spaceId: string,
): ImportBibliographyResult {
  return dispatch('import_bibliography', { content, format, spaceId }) as ImportBibliographyResult
}

beforeEach(() => {
  blocks.clear()
  properties.clear()
})

describe('import_bibliography mock handler', () => {
  it('counts BibTeX entries by @type{ prefix and creates one page each', () => {
    const bib =
      '@article{knuth1984, title={Literate Programming}}\n' +
      '@book{skiena2008, title={The Algorithm Design Manual}}\n'

    const result = importBibliography(bib, 'bibtex', SPACE)

    expect(result.pages_created).toBe(2)
    expect(result.entries_skipped).toBe(0)
    // Trivial simulation: one properties_set per created page (space stamp).
    expect(result.properties_set).toBe(2)
    // The dev-preview warning documenting the simplification is always there.
    expect(result.warnings.length).toBeGreaterThan(0)

    // One placeholder page per entry, stamped into the target space.
    const pages = [...blocks.values()].filter((b) => b['block_type'] === 'page')
    expect(pages).toHaveLength(2)
    for (const page of pages) {
      const spaceProp = properties.get(page['id'] as string)?.get('space')
      expect(spaceProp?.['value_ref']).toBe(SPACE)
    }
  })

  it('counts CSL-JSON entries by array length', () => {
    const csl = JSON.stringify([
      { id: 'a', type: 'article-journal', title: 'A' },
      { id: 'b', type: 'book', title: 'B' },
      { id: 'c', type: 'chapter', title: 'C' },
    ])

    const result = importBibliography(csl, 'csl-json', SPACE)

    expect(result.pages_created).toBe(3)
    expect([...blocks.values()].filter((b) => b['block_type'] === 'page')).toHaveLength(3)
  })

  it('falls back to 0 entries for malformed or non-array JSON', () => {
    const malformed = importBibliography('{not json', 'csl-json', SPACE)
    expect(malformed.pages_created).toBe(0)
    expect(malformed.warnings).toContain('no bibliography entries detected in the file')

    const nonArray = importBibliography('{"id":"solo"}', 'csl-json', SPACE)
    expect(nonArray.pages_created).toBe(0)
  })

  it('auto-detects the format when format is null', () => {
    // Leading `@` → BibTeX counting.
    const bib = importBibliography('@misc{x, note={y}}', null, SPACE)
    expect(bib.pages_created).toBe(1)

    // Anything else → CSL-JSON counting.
    const csl = importBibliography('[{"id":"a"},{"id":"b"}]', null, SPACE)
    expect(csl.pages_created).toBe(2)
  })

  it('accepts a space id that exists as a block in the mock DB', () => {
    const spaceId = '00000000000000000000SPACEB'
    blocks.set(spaceId, makeBlock(spaceId, 'page', 'Work', null, 0))

    const result = importBibliography('@misc{x, note={y}}', 'bibtex', spaceId)

    expect(result.pages_created).toBe(1)
    const page = [...blocks.values()].find((b) => b['content'] === 'Reference 1')
    expect(properties.get(page?.['id'] as string)?.get('space')?.['value_ref']).toBe(spaceId)
  })

  it('rejects an unknown space id with an AppError-shaped validation error (#2463)', () => {
    let thrown: unknown
    try {
      importBibliography('@misc{x, note={y}}', 'bibtex', '00000000000000000000NOSPACE')
    } catch (err) {
      thrown = err
    }

    expect(isAppError(thrown)).toBe(true)
    expect(isValidation(thrown)).toBe(true)
    expect((thrown as { message: string }).message).toBe(
      'space_id does not refer to a live space block',
    )
    // Nothing was created on the failure path.
    expect(blocks.size).toBe(0)
  })
})
