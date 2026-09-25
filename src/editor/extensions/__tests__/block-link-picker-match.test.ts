/**
 * #5160 N4 — the `[[text]]` input rule's match over the picker's items, the
 * editor's half of the one resolution rule the backend applies
 * (`LinkMatches::find` in markdown.rs): exact full title, then a unique
 * case-insensitive title, then a unique alias, else create; a case tie stays
 * text. Before this the rule compared the namespace LEAF, so typing the full
 * title of an existing `Project/Roadmap` created a twin (E10).
 */

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

  it('never guesses a case tie: null keeps the text as typed instead of creating', () => {
    const items = [page('P1', 'Foo'), page('P2', 'foo'), create]
    expect(matchBlockLinkItem(items, 'FOO')).toBeNull()
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
