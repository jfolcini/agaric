import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { nameKey, tagOfPageTitle, tagPageTitle } from '@/lib/name-tokens'

interface NameKeyCase {
  name: string
  input: string
  key: string
}

const { nameKeyCases } = JSON.parse(
  readFileSync(
    path.resolve(import.meta.dirname, '../../../conformance/reference-tokens.vectors.json'),
    'utf8',
  ),
) as { nameKeyCases: NameKeyCase[] }

// #6278 — the rows `name_key_matches_the_shared_vectors` reads in Rust.
describe('nameKey folds a name as the backend does', () => {
  it('reads the shared vectors', () => {
    expect(nameKeyCases.length).toBeGreaterThan(0)
  })

  it.each(nameKeyCases.map((row) => [row.name, row] as const))('%s', (_name, row) => {
    expect(nameKey(row.input)).toBe(row.key)
  })
})

// #6755 — the rows `tag_of_page_title_reads_the_name_after_the_path_in_any_case`
// pins in Rust (`agaric-core/src/tag_norm.rs`).
describe("a tag's page title", () => {
  it.each([
    ['Tag/x', 'x'],
    [' tAG/projects/web ', 'projects/web'],
    ['Tag/', ''],
    ['Tag', null],
    ['Tags/x', null],
    ['Notes/Tag/x', null],
    ['Tagé', null],
  ])('reads the tag of %j as %j', (title, tag) => {
    expect(tagOfPageTitle(title)).toBe(tag)
  })

  it('is the tag name under the path, trimmed', () => {
    expect(tagPageTitle(' projects/web ')).toBe('Tag/projects/web')
    expect(tagOfPageTitle(tagPageTitle('x'))).toBe('x')
  })
})
