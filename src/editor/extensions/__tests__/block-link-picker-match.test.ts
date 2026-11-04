/**
 * #5160 N4 — the `[[text]]` input rule's match over the picker's items, the
 * editor's half of the one resolution rule the backend applies
 * (`LinkMatches::find` in markdown.rs): exact full title, then a
 * case-insensitive title, then an alias, else create; where several pages
 * match, the lowest id (#6278). Before this the rule compared the namespace
 * LEAF, so typing the full title of an existing `Project/Roadmap` created a
 * twin (E10).
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { matchBlockLinkItem } from '@/editor/extensions/block-link-picker'
import type { PickerItem } from '@/editor/SuggestionList'

const page = (id: string, title: string): PickerItem => ({
  id,
  label: title.split('/').at(-1) ?? title,
  title,
})
const alias = (id: string, title: string, aliasText: string): PickerItem => ({
  id,
  label: `${title} (alias: ${aliasText})`,
  isAlias: true,
  aliasText,
})
const create: PickerItem = { id: '__create__', label: 'whatever', isCreate: true }

describe('matchBlockLinkItem', () => {
  it('matches an existing namespaced page by its full title, so no twin is created', () => {
    const items = [page('P1', 'Project/Roadmap'), page('P2', 'Roadmap'), create]
    expect(matchBlockLinkItem(items, 'Project/Roadmap')?.id).toBe('P1')
    expect(matchBlockLinkItem(items, 'Roadmap')?.id).toBe('P2')
  })

  it('takes the exact spelling over a case variant, and a unique case variant over nothing', () => {
    const items = [page('P1', 'Foo'), page('P2', 'foo'), page('P3', 'Bar'), create]
    expect(matchBlockLinkItem(items, 'Foo')?.id).toBe('P1')
    expect(matchBlockLinkItem(items, 'foo')?.id).toBe('P2')
    expect(matchBlockLinkItem(items, 'BAR')?.id).toBe('P3')
  })

  it('matches a typed NFD name to the NFC page, and an NFD alias, as paste does (#6097)', () => {
    const nfc = 'Caf\u00E9'
    const nfd = 'Cafe\u0301'
    expect(matchBlockLinkItem([page('P1', nfc), create], nfd)?.id).toBe('P1')
    expect(matchBlockLinkItem([page('P1', nfc), create], nfd.toUpperCase())?.id).toBe('P1')
    expect(matchBlockLinkItem([alias('A1', 'Coffee', nfc), create], nfd)?.id).toBe('A1')
  })

  it('links the lowest id of a case tie instead of creating (#6278)', () => {
    const items = [page('P2', 'Foo'), page('P1', 'foo'), create]
    expect(matchBlockLinkItem(items, 'FOO')?.id).toBe('P1')
  })

  it('links the lowest id of two pages of the same exact title too (#6278)', () => {
    const items = [page('P2', 'Foo'), page('P1', 'Foo'), create]
    expect(matchBlockLinkItem(items, 'Foo')?.id).toBe('P1')
  })

  it('resolves an exact alias after the titles, never a prefix-only alias hit', () => {
    const items = [alias('P9', 'Roadmap', 'rm'), page('P1', 'Rm Notes'), create]
    expect(matchBlockLinkItem(items, 'RM')?.id).toBe('P9')
    expect(matchBlockLinkItem(items, 'r')).toBeUndefined()
  })

  it('returns undefined, which creates, when no title or alias matches', () => {
    expect(matchBlockLinkItem([page('P1', 'Foo'), create], 'Brand New')).toBeUndefined()
  })
})

interface PageNameFoldCase {
  name: string
  title: string
  link: string
  resolves: boolean
}

interface PageTieCase {
  name: string
  pages: Array<{ id: string; title: string; aliases?: string[] }>
  link: string
  holder: string
}

const { pageNameFoldCases, pageTieCases } = JSON.parse(
  readFileSync(
    path.resolve(import.meta.dirname, '../../../../conformance/reference-tokens.vectors.json'),
    'utf8',
  ),
) as { pageNameFoldCases: PageNameFoldCase[]; pageTieCases: PageTieCase[] }

// #6052, #6278 — the rows `page_name_fold_vectors_pin_which_titles_a_link_names` reads in Rust.
describe('matchBlockLinkItem folds a page name as the backend does (#6278)', () => {
  it.each(pageNameFoldCases.map((row) => [row.name, row] as const))('%s', (_name, row) => {
    const found = matchBlockLinkItem([page('P1', row.title), create], row.link)
    expect(found?.id === 'P1').toBe(row.resolves)
  })
})

// #6278 — the rows `page_tie_vectors_pin_the_lowest_id_as_the_page_a_shared_name_links`
// reads in Rust.
describe('matchBlockLinkItem takes the lowest id of a name pages share (#6278)', () => {
  it.each(pageTieCases.map((row) => [row.name, row] as const))('%s', (_name, row) => {
    const items = row.pages.flatMap((p) => [
      page(p.id, p.title),
      ...(p.aliases ?? []).map((a) => alias(p.id, p.title, a)),
    ])
    expect(matchBlockLinkItem([...items, create], row.link)?.id).toBe(row.holder)
  })
})
