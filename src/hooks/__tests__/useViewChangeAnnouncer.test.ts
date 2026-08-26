/**
 * Unit tests for useViewChangeAnnouncer (#2944).
 *
 * Isolated coverage of the skip/announce logic described in the hook's
 * own doc comment: first-render skip, same-value skip (dependency never
 * re-fires), `page-editor` skip, and the announced message shape for a
 * genuine view switch. Integration coverage of the three routes that
 * feed `currentView` (palette, sidebar, keyboard shortcut) lives in
 * `CommandPalette.test.tsx` / `App.test.tsx`.
 */

import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useViewChangeAnnouncer } from '@/hooks/useViewChangeAnnouncer'
import { announce } from '@/lib/announcer'
import { i18n, t } from '@/lib/i18n'
import { useNavigationStore } from '@/stores/navigation'

vi.mock('@/lib/announcer', () => ({ announce: vi.fn() }))

beforeEach(() => {
  vi.clearAllMocks()
  useNavigationStore.setState({ currentView: 'journal' })
})

describe('useViewChangeAnnouncer', () => {
  it('does not announce on mount (initial render is not a user-initiated switch)', () => {
    renderHook(() => useViewChangeAnnouncer())
    expect(announce).not.toHaveBeenCalled()
  })

  it('announces the destination view on a genuine switch', () => {
    renderHook(() => useViewChangeAnnouncer())

    act(() => {
      useNavigationStore.setState({ currentView: 'pages' })
    })

    expect(announce).toHaveBeenCalledTimes(1)
    expect(announce).toHaveBeenCalledWith(t('announce.navigatedTo', { view: t('sidebar.pages') }))
  })

  it('does not re-announce for a same-value setView (effect dependency does not re-fire)', () => {
    renderHook(() => useViewChangeAnnouncer())

    act(() => {
      useNavigationStore.getState().setView('journal')
    })

    expect(announce).not.toHaveBeenCalled()
  })

  it('does not announce when switching into page-editor (no single localized name to announce)', () => {
    renderHook(() => useViewChangeAnnouncer())

    act(() => {
      useNavigationStore.setState({ currentView: 'page-editor' })
    })

    expect(announce).not.toHaveBeenCalled()
  })

  it('announces once per distinct switch across multiple transitions', () => {
    renderHook(() => useViewChangeAnnouncer())

    act(() => {
      useNavigationStore.setState({ currentView: 'tags' })
    })
    act(() => {
      useNavigationStore.setState({ currentView: 'trash' })
    })

    expect(announce).toHaveBeenCalledTimes(2)
    expect(announce).toHaveBeenNthCalledWith(
      1,
      t('announce.navigatedTo', { view: t('sidebar.tags') }),
    )
    expect(announce).toHaveBeenNthCalledWith(
      2,
      t('announce.navigatedTo', { view: t('sidebar.trash') }),
    )
  })

  // #4377 — `t` used to reach the effect through a latest-value ref mirror
  // written during render; it now reaches it through `useEffectEvent`. Both
  // exist for the same reason: the effect is keyed on the VIEW alone, so a
  // language change must not re-announce, yet the next genuine switch must
  // announce in the language that is current at that moment — not the one that
  // was current when the hook mounted. Freeze `t` at mount and this fails.
  it('announces in the language current at switch time, not the one current at mount', async () => {
    i18n.addResourceBundle('qa', 'translation', {
      'announce.navigatedTo': 'QA-ANNOUNCED {{view}}',
      'sidebar.pages': 'QA-PAGES',
    })
    const original = i18n.language
    try {
      renderHook(() => useViewChangeAnnouncer())

      await act(async () => {
        await i18n.changeLanguage('qa')
      })
      expect(announce).not.toHaveBeenCalled()

      act(() => {
        useNavigationStore.setState({ currentView: 'pages' })
      })

      expect(announce).toHaveBeenCalledTimes(1)
      expect(announce).toHaveBeenCalledWith('QA-ANNOUNCED QA-PAGES')
    } finally {
      await act(async () => {
        await i18n.changeLanguage(original)
      })
      i18n.removeResourceBundle('qa', 'translation')
    }
  })
})
