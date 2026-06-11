/**
 * Unit tests for `buildActionMenuActions` extracted from
 * CommandPalette.tsx (#751). The `t` translator is stubbed with an
 * identity so the test asserts the action-set SHAPE (ids, ordering,
 * pin/unpin branch, hints) independent of i18n catalog text.
 */

import { describe, expect, it } from 'vitest'

import { buildActionMenuActions } from './action-menu-actions'

// Identity translator — returns the key so assertions can match on the
// translation key directly.
const t = ((key: string) => key) as Parameters<typeof buildActionMenuActions>[2]

describe('buildActionMenuActions', () => {
  it('recent rows expose the full 6-action set with a pin toggle', () => {
    const unpinned = buildActionMenuActions('recent', false, t)
    expect(unpinned.map((a) => a.id)).toEqual([
      'open',
      'open-new-tab',
      'pin',
      'reveal-in-pages',
      'copy-id',
      'remove-from-recents',
    ])

    const pinned = buildActionMenuActions('recent', true, t)
    expect(pinned.map((a) => a.id)).toEqual([
      'open',
      'open-new-tab',
      'unpin',
      'reveal-in-pages',
      'copy-id',
      'remove-from-recents',
    ])
  })

  it('page rows expose open / new-tab / reveal / copy-id', () => {
    const actions = buildActionMenuActions('page', false, t)
    expect(actions.map((a) => a.id)).toEqual(['open', 'open-new-tab', 'reveal-in-pages', 'copy-id'])
  })

  it('block rows swap copy-id for copy-block-link', () => {
    const actions = buildActionMenuActions('block', false, t)
    expect(actions.map((a) => a.id)).toEqual([
      'open',
      'open-new-tab',
      'reveal-in-pages',
      'copy-block-link',
    ])
  })

  it('labels the open action "open page" for block rows and "open" otherwise', () => {
    expect(buildActionMenuActions('block', false, t)[0]?.label).toBe('palette.actionOpenPage')
    expect(buildActionMenuActions('page', false, t)[0]?.label).toBe('palette.actionOpen')
    expect(buildActionMenuActions('recent', false, t)[0]?.label).toBe('palette.actionOpen')
  })

  it('carries the Enter / ⌘Enter hint chips on open / new-tab', () => {
    const [open, newTab] = buildActionMenuActions('page', false, t)
    expect(open?.hint).toBe('↵')
    expect(newTab?.hint).toBe('⌘↵')
  })

  it('the pin label is locale-keyed and flips with the pinned flag', () => {
    expect(buildActionMenuActions('recent', false, t)[2]?.label).toBe('palette.actionPin')
    expect(buildActionMenuActions('recent', true, t)[2]?.label).toBe('palette.actionUnpin')
  })
})
