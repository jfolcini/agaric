import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  configKeyToTipTap,
  DEFAULT_SHORTCUTS,
  findConflicts,
  getCurrentShortcuts,
  getCustomOverrides,
  getShortcutKeys,
  matchesShortcutBinding,
  resetAllShortcuts,
  resetShortcut,
  setCustomShortcut,
} from '../keyboard-config'

vi.mock('../logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

import { logger } from '../logger'

const mockedLogger = vi.mocked(logger)

const STORAGE_KEY = 'agaric-keyboard-shortcuts'

beforeEach(() => {
  localStorage.clear()
})

describe('keyboard-config', () => {
  it('DEFAULT_SHORTCUTS has entries', () => {
    expect(DEFAULT_SHORTCUTS.length).toBeGreaterThan(0)
    // Verify every entry has required fields with the expected shape
    for (const s of DEFAULT_SHORTCUTS) {
      // ids are camelCase identifiers (e.g. 'prevBlock', 'priority1')
      expect(s.id).toMatch(/^[a-z][a-zA-Z0-9]*$/)
      // keys are human-readable bindings (e.g. 'Ctrl + Shift + E', 'Escape')
      expect(s.keys).toMatch(/\S/)
      // category is always under the 'keyboard.category.' namespace
      expect(s.category).toMatch(/^keyboard\.category\./)
      // description is a dotted i18n key; most start with 'keyboard.', a few
      // (graph zoom shortcuts) live under 'graph.' — both are valid namespaces.
      expect(s.description).toMatch(/^[a-z][a-zA-Z0-9]*\.[a-zA-Z][a-zA-Z0-9]*$/)
    }
  })

  it('DEFAULT_SHORTCUTS has unique ids', () => {
    const ids = DEFAULT_SHORTCUTS.map((s) => s.id)
    const uniqueIds = new Set(ids)
    expect(uniqueIds.size).toBe(ids.length)
  })

  it('DEFAULT_SHORTCUTS includes exportPageMarkdown with correct defaults', () => {
    const shortcut = DEFAULT_SHORTCUTS.find((s) => s.id === 'exportPageMarkdown')
    expect(shortcut).toBeDefined()
    expect(shortcut?.keys).toBe('Ctrl + Shift + E')
    // BUG-30: handler is page-editor-scoped, not global
    expect(shortcut?.category).toBe('keyboard.category.pageEditor')
    expect(shortcut?.description).toBe('keyboard.exportPageMarkdown')
    expect(shortcut?.condition).toBe('keyboard.condition.inPageEditor')
  })

  it('DEFAULT_SHORTCUTS includes zoomOut (UX-214) under blockTree', () => {
    const shortcut = DEFAULT_SHORTCUTS.find((s) => s.id === 'zoomOut')
    expect(shortcut).toBeDefined()
    expect(shortcut?.keys).toBe('Escape')
    expect(shortcut?.category).toBe('keyboard.category.blockTree')
    expect(shortcut?.description).toBe('keyboard.zoomOut')
    expect(shortcut?.condition).toBe('keyboard.condition.whenZoomed')
  })

  it('DEFAULT_SHORTCUTS includes gotoConflicts (UX-216) under global', () => {
    const shortcut = DEFAULT_SHORTCUTS.find((s) => s.id === 'gotoConflicts')
    expect(shortcut).toBeDefined()
    expect(shortcut?.keys).toBe('Alt + C')
    expect(shortcut?.category).toBe('keyboard.category.global')
    expect(shortcut?.description).toBe('keyboard.gotoConflicts')
  })

  it('gotoConflicts does not collide with any existing (keys, category) pair', () => {
    const gotoConflictsKeys = 'Alt + C'
    const dupes = DEFAULT_SHORTCUTS.filter(
      (s) => s.keys === gotoConflictsKeys && s.category === 'keyboard.category.global',
    )
    // Only gotoConflicts itself should match
    expect(dupes).toHaveLength(1)
    expect(dupes[0]?.id).toBe('gotoConflicts')
  })

  it('matchesShortcutBinding resolves Alt+C to gotoConflicts', () => {
    expect(
      matchesShortcutBinding(
        { altKey: true, ctrlKey: false, metaKey: false, shiftKey: false, key: 'c' },
        'gotoConflicts',
      ),
    ).toBe(true)
    // Plain "c" must NOT match
    expect(
      matchesShortcutBinding(
        { altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, key: 'c' },
        'gotoConflicts',
      ),
    ).toBe(false)
  })

  it('matchesShortcutBinding resolves Escape to zoomOut', () => {
    expect(
      matchesShortcutBinding(
        { altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, key: 'Escape' },
        'zoomOut',
      ),
    ).toBe(true)
    // Escape with modifiers must NOT match
    expect(
      matchesShortcutBinding(
        { altKey: false, ctrlKey: true, metaKey: false, shiftKey: false, key: 'Escape' },
        'zoomOut',
      ),
    ).toBe(false)
  })

  it('getCustomOverrides returns empty when nothing stored', () => {
    expect(getCustomOverrides()).toEqual({})
  })

  it('getCustomOverrides returns parsed JSON', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ prevBlock: 'Ctrl + P' }))
    expect(getCustomOverrides()).toEqual({ prevBlock: 'Ctrl + P' })
  })

  it('getCustomOverrides returns empty on invalid JSON', () => {
    localStorage.setItem(STORAGE_KEY, 'not json{{{')
    expect(getCustomOverrides()).toEqual({})
  })

  it('setCustomShortcut stores override', () => {
    setCustomShortcut('prevBlock', 'Ctrl + P')
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')
    expect(stored).toEqual({ prevBlock: 'Ctrl + P' })
  })

  it('setCustomShortcut removes override when set to default', () => {
    // First set a custom override
    setCustomShortcut('prevBlock', 'Ctrl + P')
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')).toEqual({ prevBlock: 'Ctrl + P' })

    // Now set it back to the default
    const defaultKeys = DEFAULT_SHORTCUTS.find((s) => s.id === 'prevBlock')?.keys ?? ''
    setCustomShortcut('prevBlock', defaultKeys)
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')
    expect(stored.prevBlock).toBeUndefined()
  })

  it('getShortcutKeys returns default when no override', () => {
    const defaultKeys = DEFAULT_SHORTCUTS.find((s) => s.id === 'prevBlock')?.keys
    expect(getShortcutKeys('prevBlock')).toBe(defaultKeys)
  })

  it('getShortcutKeys returns override when set', () => {
    setCustomShortcut('prevBlock', 'Ctrl + P')
    expect(getShortcutKeys('prevBlock')).toBe('Ctrl + P')
  })

  it('getShortcutKeys returns empty string for unknown id', () => {
    expect(getShortcutKeys('nonexistent')).toBe('')
  })

  it('getCurrentShortcuts returns all shortcuts with isCustom=false by default', () => {
    const current = getCurrentShortcuts()
    expect(current.length).toBe(DEFAULT_SHORTCUTS.length)
    for (const s of current) {
      expect(s.isCustom).toBe(false)
    }
  })

  it('getCurrentShortcuts marks custom as isCustom=true', () => {
    setCustomShortcut('prevBlock', 'Ctrl + P')
    const current = getCurrentShortcuts()
    const prev = current.find((s) => s.id === 'prevBlock')
    expect(prev?.isCustom).toBe(true)
    expect(prev?.keys).toBe('Ctrl + P')

    // Non-customized should remain false
    const next = current.find((s) => s.id === 'nextBlock')
    expect(next?.isCustom).toBe(false)
  })

  it('resetShortcut removes single override', () => {
    setCustomShortcut('prevBlock', 'Ctrl + P')
    setCustomShortcut('nextBlock', 'Ctrl + N')

    resetShortcut('prevBlock')

    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')
    expect(stored.prevBlock).toBeUndefined()
    expect(stored.nextBlock).toBe('Ctrl + N')
  })

  it('resetAllShortcuts clears localStorage', () => {
    setCustomShortcut('prevBlock', 'Ctrl + P')
    setCustomShortcut('nextBlock', 'Ctrl + N')

    resetAllShortcuts()

    expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
  })

  it('resetAllShortcuts is safe as no-op when localStorage is empty', () => {
    // Ensure no custom overrides exist
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull()

    // Should not throw and should return gracefully
    expect(() => resetAllShortcuts()).not.toThrow()

    // localStorage remains empty
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
    // Shortcuts still return defaults
    expect(getCustomOverrides()).toEqual({})
  })

  it('findConflicts returns known Backspace conflict for defaults (different conditions, same keys+category)', () => {
    // Backspace appears twice in editing (deleteBlock & mergeWithPrevious) with different conditions,
    // however findConflicts checks by keys+category, so they appear as a conflict.
    const conflicts = findConflicts()
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]?.keys).toBe('Backspace')
    expect(conflicts[0]?.category).toBe('keyboard.category.editing')
    expect(conflicts[0]?.ids).toContain('deleteBlock')
    expect(conflicts[0]?.ids).toContain('mergeWithPrevious')
  })

  it('findConflicts detects actual conflict when custom shortcut duplicates another', () => {
    // Set prevBlock to same keys as nextBlock in the same category
    const nextDefault = DEFAULT_SHORTCUTS.find((s) => s.id === 'nextBlock')
    setCustomShortcut('prevBlock', nextDefault?.keys ?? '')

    const conflicts = findConflicts()
    const navConflict = conflicts.find(
      (c) => c.ids.includes('prevBlock') && c.ids.includes('nextBlock'),
    )
    expect(navConflict).toBeDefined()
    expect(navConflict?.keys).toBe(nextDefault?.keys)
    expect(navConflict?.category).toBe('keyboard.category.navigation')
  })

  it('findConflicts detects conflict when two shortcuts are both set to the same custom key', () => {
    // Set two editing shortcuts to the same brand-new key combo
    setCustomShortcut('indentBlock', 'Ctrl + Shift + X')
    setCustomShortcut('dedentBlock', 'Ctrl + Shift + X')

    const conflicts = findConflicts()
    const editingConflict = conflicts.find(
      (c) => c.ids.includes('indentBlock') && c.ids.includes('dedentBlock'),
    )
    expect(editingConflict).toBeDefined()
    expect(editingConflict?.keys).toBe('Ctrl + Shift + X')
    expect(editingConflict?.category).toBe('keyboard.category.editing')
  })

  it('handles localStorage.setItem throwing (setCustomShortcut)', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceeded')
    })

    // Should not throw
    expect(() => setCustomShortcut('prevBlock', 'Ctrl + P')).not.toThrow()
    expect(mockedLogger.warn).toHaveBeenCalledWith(
      'KeyboardConfig',
      'failed to save keyboard shortcut override',
    )

    vi.restoreAllMocks()
  })

  it('handles localStorage.setItem throwing (resetShortcut)', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceeded')
    })

    expect(() => resetShortcut('prevBlock')).not.toThrow()
    expect(mockedLogger.warn).toHaveBeenCalledWith(
      'KeyboardConfig',
      'failed to reset keyboard shortcut',
    )

    vi.restoreAllMocks()
  })

  it('handles localStorage.removeItem throwing (resetAllShortcuts)', () => {
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('SecurityError')
    })

    expect(() => resetAllShortcuts()).not.toThrow()
    expect(mockedLogger.warn).toHaveBeenCalledWith(
      'KeyboardConfig',
      'failed to reset all keyboard shortcuts',
    )

    vi.restoreAllMocks()
  })

  describe('Block Tree shortcuts (F-38)', () => {
    const blockTreeIds = [
      'openDatePicker',
      'openPropertiesDrawer',
      'heading1',
      'heading2',
      'heading3',
      'heading4',
      'heading5',
      'heading6',
    ]

    it('all 8 block tree shortcuts exist in DEFAULT_SHORTCUTS', () => {
      for (const id of blockTreeIds) {
        const shortcut = DEFAULT_SHORTCUTS.find((s) => s.id === id)
        expect(shortcut, `shortcut "${id}" should exist`).toBeDefined()
        expect(shortcut?.category).toBe('keyboard.category.blockTree')
      }
    })

    it('openDatePicker defaults to Ctrl + Shift + D', () => {
      const s = DEFAULT_SHORTCUTS.find((s) => s.id === 'openDatePicker')
      expect(s?.keys).toBe('Ctrl + Shift + D')
    })

    it('openPropertiesDrawer defaults to Ctrl + Shift + P', () => {
      const s = DEFAULT_SHORTCUTS.find((s) => s.id === 'openPropertiesDrawer')
      expect(s?.keys).toBe('Ctrl + Shift + P')
    })

    it('heading1-6 default to Ctrl + 1 through Ctrl + 6', () => {
      for (let level = 1; level <= 6; level++) {
        const s = DEFAULT_SHORTCUTS.find((s) => s.id === `heading${level}`)
        expect(s?.keys).toBe(`Ctrl + ${level}`)
      }
    })
  })

  describe('Tab bar shortcut — closeTabOnFocus (F-38 Phase 4)', () => {
    it('closeTabOnFocus exists in DEFAULT_SHORTCUTS', () => {
      const shortcut = DEFAULT_SHORTCUTS.find((s) => s.id === 'closeTabOnFocus')
      expect(shortcut).toBeDefined()
    })

    it('closeTabOnFocus has correct category', () => {
      const shortcut = DEFAULT_SHORTCUTS.find((s) => s.id === 'closeTabOnFocus')
      expect(shortcut?.category).toBe('keyboard.category.tabs')
    })

    it('closeTabOnFocus has correct default keys', () => {
      const shortcut = DEFAULT_SHORTCUTS.find((s) => s.id === 'closeTabOnFocus')
      expect(shortcut?.keys).toBe('Delete / Backspace')
    })

    it('closeTabOnFocus has correct description and condition', () => {
      const shortcut = DEFAULT_SHORTCUTS.find((s) => s.id === 'closeTabOnFocus')
      expect(shortcut?.description).toBe('keyboard.closeTabOnFocus')
      expect(shortcut?.condition).toBe('keyboard.condition.tabFocused')
    })
  })

  describe('Journal shortcut — createJournalBlock (F-38 Phase 4)', () => {
    it('createJournalBlock exists in DEFAULT_SHORTCUTS', () => {
      const shortcut = DEFAULT_SHORTCUTS.find((s) => s.id === 'createJournalBlock')
      expect(shortcut).toBeDefined()
    })

    it('createJournalBlock has correct category', () => {
      const shortcut = DEFAULT_SHORTCUTS.find((s) => s.id === 'createJournalBlock')
      expect(shortcut?.category).toBe('keyboard.category.journal')
    })

    it('createJournalBlock has correct default keys', () => {
      const shortcut = DEFAULT_SHORTCUTS.find((s) => s.id === 'createJournalBlock')
      expect(shortcut?.keys).toBe('Enter / n')
    })

    it('createJournalBlock has correct description and condition', () => {
      const shortcut = DEFAULT_SHORTCUTS.find((s) => s.id === 'createJournalBlock')
      expect(shortcut?.description).toBe('keyboard.createJournalBlock')
      expect(shortcut?.condition).toBe('keyboard.condition.emptyDaily')
    })
  })

  describe('List Selection shortcuts (F-38 Phase 3)', () => {
    const listSelectionIds = ['listToggleSelection', 'listSelectAll', 'listClearSelection']

    it('all 3 list selection shortcuts exist in DEFAULT_SHORTCUTS', () => {
      for (const id of listSelectionIds) {
        const shortcut = DEFAULT_SHORTCUTS.find((s) => s.id === id)
        expect(shortcut, `shortcut "${id}" should exist`).toBeDefined()
        expect(shortcut?.category).toBe('keyboard.category.listSelection')
      }
    })

    it('listToggleSelection defaults to Space', () => {
      const s = DEFAULT_SHORTCUTS.find((s) => s.id === 'listToggleSelection')
      expect(s?.keys).toBe('Space')
      expect(s?.description).toBe('keyboard.listToggleSelection')
      expect(s?.condition).toBe('keyboard.condition.listItemFocused')
    })

    it('listSelectAll defaults to Ctrl + A', () => {
      const s = DEFAULT_SHORTCUTS.find((s) => s.id === 'listSelectAll')
      expect(s?.keys).toBe('Ctrl + A')
      expect(s?.description).toBe('keyboard.listSelectAll')
    })

    it('listClearSelection defaults to Escape', () => {
      const s = DEFAULT_SHORTCUTS.find((s) => s.id === 'listClearSelection')
      expect(s?.keys).toBe('Escape')
      expect(s?.description).toBe('keyboard.listClearSelection')
      expect(s?.condition).toBe('keyboard.condition.hasSelection')
    })

    it('old hist* selection IDs no longer exist', () => {
      expect(DEFAULT_SHORTCUTS.find((s) => s.id === 'histToggleSelection')).toBeUndefined()
      expect(DEFAULT_SHORTCUTS.find((s) => s.id === 'histSelectAll')).toBeUndefined()
      expect(DEFAULT_SHORTCUTS.find((s) => s.id === 'histClearSelection')).toBeUndefined()
    })
  })

  describe('matchesShortcutBinding', () => {
    function fakeEvent(
      key: string,
      opts: Partial<{
        ctrlKey: boolean
        metaKey: boolean
        shiftKey: boolean
        altKey: boolean
      }> = {},
    ): Pick<KeyboardEvent, 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey' | 'key'> {
      return {
        key,
        ctrlKey: opts.ctrlKey ?? false,
        metaKey: opts.metaKey ?? false,
        shiftKey: opts.shiftKey ?? false,
        altKey: opts.altKey ?? false,
      }
    }

    it('matches Ctrl+Shift+D for openDatePicker', () => {
      expect(
        matchesShortcutBinding(fakeEvent('D', { ctrlKey: true, shiftKey: true }), 'openDatePicker'),
      ).toBe(true)
      expect(
        matchesShortcutBinding(fakeEvent('d', { ctrlKey: true, shiftKey: true }), 'openDatePicker'),
      ).toBe(true)
    })

    it('matches Meta+Shift+D for openDatePicker (macOS)', () => {
      expect(
        matchesShortcutBinding(fakeEvent('D', { metaKey: true, shiftKey: true }), 'openDatePicker'),
      ).toBe(true)
    })

    it('does not match Ctrl+D (missing Shift) for openDatePicker', () => {
      expect(matchesShortcutBinding(fakeEvent('D', { ctrlKey: true }), 'openDatePicker')).toBe(
        false,
      )
    })

    it('matches Ctrl+1 through Ctrl+6 for heading shortcuts', () => {
      for (let level = 1; level <= 6; level++) {
        expect(
          matchesShortcutBinding(fakeEvent(String(level), { ctrlKey: true }), `heading${level}`),
        ).toBe(true)
      }
    })

    it('does not match Ctrl+Shift+1 for heading1 (shift not in binding)', () => {
      expect(
        matchesShortcutBinding(fakeEvent('1', { ctrlKey: true, shiftKey: true }), 'heading1'),
      ).toBe(false)
    })

    it('returns false for non-matching event', () => {
      expect(matchesShortcutBinding(fakeEvent('x', { ctrlKey: true }), 'openDatePicker')).toBe(
        false,
      )
    })

    it('returns false for unknown shortcut id', () => {
      expect(
        matchesShortcutBinding(fakeEvent('D', { ctrlKey: true, shiftKey: true }), 'nonexistent'),
      ).toBe(false)
    })

    it('matches Ctrl+Shift+P for openPropertiesDrawer', () => {
      expect(
        matchesShortcutBinding(
          fakeEvent('p', { ctrlKey: true, shiftKey: true }),
          'openPropertiesDrawer',
        ),
      ).toBe(true)
    })

    it('respects custom overrides', () => {
      setCustomShortcut('openDatePicker', 'Ctrl + Shift + X')
      expect(
        matchesShortcutBinding(fakeEvent('x', { ctrlKey: true, shiftKey: true }), 'openDatePicker'),
      ).toBe(true)
      expect(
        matchesShortcutBinding(fakeEvent('d', { ctrlKey: true, shiftKey: true }), 'openDatePicker'),
      ).toBe(false)
    })

    it('matches Space key for listToggleSelection', () => {
      expect(matchesShortcutBinding(fakeEvent(' '), 'listToggleSelection')).toBe(true)
    })

    it('does not match Space with modifiers for listToggleSelection', () => {
      expect(matchesShortcutBinding(fakeEvent(' ', { ctrlKey: true }), 'listToggleSelection')).toBe(
        false,
      )
    })

    it('matches Ctrl+A for listSelectAll', () => {
      expect(matchesShortcutBinding(fakeEvent('a', { ctrlKey: true }), 'listSelectAll')).toBe(true)
    })

    it('matches Escape for listClearSelection', () => {
      expect(matchesShortcutBinding(fakeEvent('Escape'), 'listClearSelection')).toBe(true)
    })

    it('does not match Escape with modifiers for listClearSelection', () => {
      expect(
        matchesShortcutBinding(fakeEvent('Escape', { ctrlKey: true }), 'listClearSelection'),
      ).toBe(false)
    })
  })

  describe('Editor Formatting shortcuts (F-38 Phase 1)', () => {
    const editorFormattingIds = [
      'inlineCode',
      'strikethrough',
      'highlight',
      'codeBlock',
      'priority1',
      'priority2',
      'priority3',
      'linkPopover',
      'backspaceChip',
    ]

    it('all 9 editor formatting shortcuts exist in DEFAULT_SHORTCUTS', () => {
      for (const id of editorFormattingIds) {
        const shortcut = DEFAULT_SHORTCUTS.find((s) => s.id === id)
        expect(shortcut, `shortcut "${id}" should exist`).toBeDefined()
        expect(shortcut?.category).toBe('keyboard.category.editorFormatting')
      }
    })

    it('inlineCode defaults to Ctrl + E', () => {
      const s = DEFAULT_SHORTCUTS.find((s) => s.id === 'inlineCode')
      expect(s?.keys).toBe('Ctrl + E')
    })

    it('strikethrough defaults to Ctrl + Shift + X (BUG-31)', () => {
      // BUG-31: must match TipTap StarterKit's `Mod-Shift-X` default AND
      // the tooltip string in `i18n.ts` — previously drifted to
      // `Ctrl + Shift + S` which was unreachable.
      const s = DEFAULT_SHORTCUTS.find((s) => s.id === 'strikethrough')
      expect(s?.keys).toBe('Ctrl + Shift + X')
    })

    it('highlight defaults to Ctrl + Shift + H', () => {
      const s = DEFAULT_SHORTCUTS.find((s) => s.id === 'highlight')
      expect(s?.keys).toBe('Ctrl + Shift + H')
    })

    it('codeBlock defaults to Ctrl + Shift + C', () => {
      const s = DEFAULT_SHORTCUTS.find((s) => s.id === 'codeBlock')
      expect(s?.keys).toBe('Ctrl + Shift + C')
    })

    it('priority1 defaults to Ctrl + Shift + 1', () => {
      const s = DEFAULT_SHORTCUTS.find((s) => s.id === 'priority1')
      expect(s?.keys).toBe('Ctrl + Shift + 1')
    })

    it('priority2 defaults to Ctrl + Shift + 2', () => {
      const s = DEFAULT_SHORTCUTS.find((s) => s.id === 'priority2')
      expect(s?.keys).toBe('Ctrl + Shift + 2')
    })

    it('priority3 defaults to Ctrl + Shift + 3', () => {
      const s = DEFAULT_SHORTCUTS.find((s) => s.id === 'priority3')
      expect(s?.keys).toBe('Ctrl + Shift + 3')
    })

    it('linkPopover defaults to Ctrl + K', () => {
      const s = DEFAULT_SHORTCUTS.find((s) => s.id === 'linkPopover')
      expect(s?.keys).toBe('Ctrl + K')
    })

    it('backspaceChip defaults to Backspace with afterChip condition', () => {
      const s = DEFAULT_SHORTCUTS.find((s) => s.id === 'backspaceChip')
      expect(s?.keys).toBe('Backspace')
      expect(s?.condition).toBe('keyboard.condition.afterChip')
    })
  })

  describe('Suggestion Popup shortcuts (F-38 Phase 1)', () => {
    const suggestionIds = ['suggestionClose', 'suggestionPassSpace', 'suggestionAutocomplete']

    it('all 3 suggestion popup shortcuts exist in DEFAULT_SHORTCUTS', () => {
      for (const id of suggestionIds) {
        const shortcut = DEFAULT_SHORTCUTS.find((s) => s.id === id)
        expect(shortcut, `shortcut "${id}" should exist`).toBeDefined()
        expect(shortcut?.category).toBe('keyboard.category.suggestionPopup')
        expect(shortcut?.condition).toBe('keyboard.condition.popupOpen')
      }
    })

    it('suggestionClose defaults to Escape', () => {
      const s = DEFAULT_SHORTCUTS.find((s) => s.id === 'suggestionClose')
      expect(s?.keys).toBe('Escape')
    })

    it('suggestionPassSpace defaults to Space', () => {
      const s = DEFAULT_SHORTCUTS.find((s) => s.id === 'suggestionPassSpace')
      expect(s?.keys).toBe('Space')
    })

    it('suggestionAutocomplete defaults to Tab', () => {
      const s = DEFAULT_SHORTCUTS.find((s) => s.id === 'suggestionAutocomplete')
      expect(s?.keys).toBe('Tab')
    })
  })

  describe('configKeyToTipTap', () => {
    it('converts Ctrl + E to Mod-e', () => {
      expect(configKeyToTipTap('Ctrl + E')).toBe('Mod-e')
    })

    it('converts Ctrl + Shift + S to Mod-Shift-s', () => {
      expect(configKeyToTipTap('Ctrl + Shift + S')).toBe('Mod-Shift-s')
    })

    it('converts Ctrl + K to Mod-k', () => {
      expect(configKeyToTipTap('Ctrl + K')).toBe('Mod-k')
    })

    it('converts Ctrl + Shift + H to Mod-Shift-h', () => {
      expect(configKeyToTipTap('Ctrl + Shift + H')).toBe('Mod-Shift-h')
    })

    it('converts Ctrl + Shift + C to Mod-Shift-c', () => {
      expect(configKeyToTipTap('Ctrl + Shift + C')).toBe('Mod-Shift-c')
    })

    it('converts Ctrl + Shift + 1 to Mod-Shift-1', () => {
      expect(configKeyToTipTap('Ctrl + Shift + 1')).toBe('Mod-Shift-1')
    })

    it('converts single key Backspace to backspace', () => {
      expect(configKeyToTipTap('Backspace')).toBe('backspace')
    })

    it('converts Alt + T to Alt-t', () => {
      expect(configKeyToTipTap('Alt + T')).toBe('Alt-t')
    })
  })

  // ── BUG-18: graph zoom + arrow normalization + ` / ` alternatives ──

  describe('Graph zoom shortcuts (BUG-18)', () => {
    it('graphZoomIn exists with `+ / =` default in global category', () => {
      const s = DEFAULT_SHORTCUTS.find((s) => s.id === 'graphZoomIn')
      expect(s).toBeDefined()
      expect(s?.keys).toBe('+ / =')
      expect(s?.category).toBe('keyboard.category.global')
      expect(s?.description).toBe('graph.zoomIn')
    })

    it('graphZoomOut exists with `-` default in global category', () => {
      const s = DEFAULT_SHORTCUTS.find((s) => s.id === 'graphZoomOut')
      expect(s).toBeDefined()
      expect(s?.keys).toBe('-')
      expect(s?.category).toBe('keyboard.category.global')
      expect(s?.description).toBe('graph.zoomOut')
    })

    it('graphZoomReset exists with `0` default in global category', () => {
      const s = DEFAULT_SHORTCUTS.find((s) => s.id === 'graphZoomReset')
      expect(s).toBeDefined()
      expect(s?.keys).toBe('0')
      expect(s?.category).toBe('keyboard.category.global')
      expect(s?.description).toBe('graph.zoomReset')
    })

    it('graphZoomIn matches both `+` and `=` via alternative splitting', () => {
      // `+` — typical US layout produces `e.key === '+'` with Shift pressed
      expect(
        matchesShortcutBinding(
          { altKey: false, ctrlKey: false, metaKey: false, shiftKey: true, key: '+' },
          'graphZoomIn',
        ),
      ).toBe(true)
      // `+` — some layouts produce `+` without shift
      expect(
        matchesShortcutBinding(
          { altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, key: '+' },
          'graphZoomIn',
        ),
      ).toBe(true)
      // `=` — unshifted on US layout
      expect(
        matchesShortcutBinding(
          { altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, key: '=' },
          'graphZoomIn',
        ),
      ).toBe(true)
    })

    it('graphZoomOut matches `-`', () => {
      expect(
        matchesShortcutBinding(
          { altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, key: '-' },
          'graphZoomOut',
        ),
      ).toBe(true)
    })

    it('graphZoomReset matches `0` only without Ctrl', () => {
      expect(
        matchesShortcutBinding(
          { altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, key: '0' },
          'graphZoomReset',
        ),
      ).toBe(true)
      // Ctrl+0 is NOT graphZoomReset (different binding)
      expect(
        matchesShortcutBinding(
          { altKey: false, ctrlKey: true, metaKey: false, shiftKey: false, key: '0' },
          'graphZoomReset',
        ),
      ).toBe(false)
    })

    it('graphZoomIn does not match arbitrary keys', () => {
      expect(
        matchesShortcutBinding(
          { altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, key: 'x' },
          'graphZoomIn',
        ),
      ).toBe(false)
    })

    it('rebinding graphZoomIn to Ctrl+Shift+Z takes effect', () => {
      setCustomShortcut('graphZoomIn', 'Ctrl + Shift + Z')
      // New binding fires
      expect(
        matchesShortcutBinding(
          { altKey: false, ctrlKey: true, metaKey: false, shiftKey: true, key: 'z' },
          'graphZoomIn',
        ),
      ).toBe(true)
      // Old defaults do NOT fire after rebind
      expect(
        matchesShortcutBinding(
          { altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, key: '+' },
          'graphZoomIn',
        ),
      ).toBe(false)
      expect(
        matchesShortcutBinding(
          { altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, key: '=' },
          'graphZoomIn',
        ),
      ).toBe(false)
    })
  })

  // BUG-18 post-review: narrow the isSymbolKey whitelist to only +?@= so that
  // rebinding to non-Shift-produced symbols (e.g. [, ], ;, ') keeps strict
  // Shift matching.
  describe('Symbol-key shift relaxation is narrow (BUG-18)', () => {
    it('`[` binding requires exact shift state (no shift)', () => {
      setCustomShortcut('graphZoomIn', '[')
      // Without shift matches
      expect(
        matchesShortcutBinding(
          { altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, key: '[' },
          'graphZoomIn',
        ),
      ).toBe(true)
      // With shift does NOT match (key would be `{` on US anyway, but guard
      // against a layout where Shift+[ still yields `[`).
      expect(
        matchesShortcutBinding(
          { altKey: false, ctrlKey: false, metaKey: false, shiftKey: true, key: '[' },
          'graphZoomIn',
        ),
      ).toBe(false)
    })

    it('`]` binding requires exact shift state (no shift)', () => {
      setCustomShortcut('graphZoomIn', ']')
      expect(
        matchesShortcutBinding(
          { altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, key: ']' },
          'graphZoomIn',
        ),
      ).toBe(true)
      expect(
        matchesShortcutBinding(
          { altKey: false, ctrlKey: false, metaKey: false, shiftKey: true, key: ']' },
          'graphZoomIn',
        ),
      ).toBe(false)
    })

    it('`@` binding IS shift-relaxed (Shift+2 → `@` on US layout)', () => {
      setCustomShortcut('graphZoomIn', '@')
      // Shift-produced @ must match
      expect(
        matchesShortcutBinding(
          { altKey: false, ctrlKey: false, metaKey: false, shiftKey: true, key: '@' },
          'graphZoomIn',
        ),
      ).toBe(true)
      // AltGr-produced @ (on DE keyboard, no Shift) must also match
      expect(
        matchesShortcutBinding(
          { altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, key: '@' },
          'graphZoomIn',
        ),
      ).toBe(true)
    })

    it('`?` binding IS shift-relaxed (Shift+/ → `?` on US layout)', () => {
      setCustomShortcut('graphZoomIn', '?')
      expect(
        matchesShortcutBinding(
          { altKey: false, ctrlKey: false, metaKey: false, shiftKey: true, key: '?' },
          'graphZoomIn',
        ),
      ).toBe(true)
      expect(
        matchesShortcutBinding(
          { altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, key: '?' },
          'graphZoomIn',
        ),
      ).toBe(true)
    })
  })

  describe('Arrow key normalization (BUG-18)', () => {
    it('`Alt + ←` matches ArrowLeft with altKey', () => {
      expect(
        matchesShortcutBinding(
          { altKey: true, ctrlKey: false, metaKey: false, shiftKey: false, key: 'ArrowLeft' },
          'prevDayWeekMonth',
        ),
      ).toBe(true)
    })

    it('`Alt + →` matches ArrowRight with altKey', () => {
      expect(
        matchesShortcutBinding(
          { altKey: true, ctrlKey: false, metaKey: false, shiftKey: false, key: 'ArrowRight' },
          'nextDayWeekMonth',
        ),
      ).toBe(true)
    })

    it('ArrowLeft without altKey does NOT match prevDayWeekMonth', () => {
      expect(
        matchesShortcutBinding(
          { altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, key: 'ArrowLeft' },
          'prevDayWeekMonth',
        ),
      ).toBe(false)
    })

    it('`Alt + T` matches both `t` and `T` for goToToday', () => {
      expect(
        matchesShortcutBinding(
          { altKey: true, ctrlKey: false, metaKey: false, shiftKey: false, key: 't' },
          'goToToday',
        ),
      ).toBe(true)
      expect(
        matchesShortcutBinding(
          { altKey: true, ctrlKey: false, metaKey: false, shiftKey: false, key: 'T' },
          'goToToday',
        ),
      ).toBe(true)
    })
  })

  describe('Global shortcut rebinding (BUG-18)', () => {
    it('rebinding focusSearch to Ctrl+Shift+Q fires on new binding and not on old', () => {
      // Default Ctrl+F fires
      expect(
        matchesShortcutBinding(
          { altKey: false, ctrlKey: true, metaKey: false, shiftKey: false, key: 'f' },
          'focusSearch',
        ),
      ).toBe(true)

      setCustomShortcut('focusSearch', 'Ctrl + Shift + Q')

      // New binding fires
      expect(
        matchesShortcutBinding(
          { altKey: false, ctrlKey: true, metaKey: false, shiftKey: true, key: 'q' },
          'focusSearch',
        ),
      ).toBe(true)
      // Old Ctrl+F does NOT fire after rebind
      expect(
        matchesShortcutBinding(
          { altKey: false, ctrlKey: true, metaKey: false, shiftKey: false, key: 'f' },
          'focusSearch',
        ),
      ).toBe(false)
    })

    it('rebinding createNewPage to Ctrl+Alt+M fires on new binding and not on old', () => {
      setCustomShortcut('createNewPage', 'Ctrl + Alt + M')
      expect(
        matchesShortcutBinding(
          { altKey: true, ctrlKey: true, metaKey: false, shiftKey: false, key: 'm' },
          'createNewPage',
        ),
      ).toBe(true)
      expect(
        matchesShortcutBinding(
          { altKey: false, ctrlKey: true, metaKey: false, shiftKey: false, key: 'n' },
          'createNewPage',
        ),
      ).toBe(false)
    })
  })

  describe('Tab shortcut bindings (BUG-18)', () => {
    it('Ctrl+Tab matches nextTab', () => {
      expect(
        matchesShortcutBinding(
          { altKey: false, ctrlKey: true, metaKey: false, shiftKey: false, key: 'Tab' },
          'nextTab',
        ),
      ).toBe(true)
    })

    it('Ctrl+Shift+Tab matches previousTab', () => {
      expect(
        matchesShortcutBinding(
          { altKey: false, ctrlKey: true, metaKey: false, shiftKey: true, key: 'Tab' },
          'previousTab',
        ),
      ).toBe(true)
    })

    it('Ctrl+Tab does NOT match previousTab (shift not pressed)', () => {
      expect(
        matchesShortcutBinding(
          { altKey: false, ctrlKey: true, metaKey: false, shiftKey: false, key: 'Tab' },
          'previousTab',
        ),
      ).toBe(false)
    })

    it('Ctrl+Shift+Tab does NOT match nextTab (more specific binding)', () => {
      expect(
        matchesShortcutBinding(
          { altKey: false, ctrlKey: true, metaKey: false, shiftKey: true, key: 'Tab' },
          'nextTab',
        ),
      ).toBe(false)
    })

    it('Ctrl+T matches openInNewTab', () => {
      expect(
        matchesShortcutBinding(
          { altKey: false, ctrlKey: true, metaKey: false, shiftKey: false, key: 't' },
          'openInNewTab',
        ),
      ).toBe(true)
    })

    it('Ctrl+W matches closeActiveTab', () => {
      expect(
        matchesShortcutBinding(
          { altKey: false, ctrlKey: true, metaKey: false, shiftKey: false, key: 'w' },
          'closeActiveTab',
        ),
      ).toBe(true)
    })

    it('rebinding openInNewTab to Ctrl+Alt+T fires on new binding and not on old', () => {
      setCustomShortcut('openInNewTab', 'Ctrl + Alt + T')
      expect(
        matchesShortcutBinding(
          { altKey: true, ctrlKey: true, metaKey: false, shiftKey: false, key: 't' },
          'openInNewTab',
        ),
      ).toBe(true)
      // Old plain Ctrl+T no longer fires
      expect(
        matchesShortcutBinding(
          { altKey: false, ctrlKey: true, metaKey: false, shiftKey: false, key: 't' },
          'openInNewTab',
        ),
      ).toBe(false)
    })
  })

  describe('Journal shortcut rebinding (BUG-18)', () => {
    it('rebinding prevDayWeekMonth to Ctrl+PageUp fires on new and not old', () => {
      // Default Alt+← fires
      expect(
        matchesShortcutBinding(
          { altKey: true, ctrlKey: false, metaKey: false, shiftKey: false, key: 'ArrowLeft' },
          'prevDayWeekMonth',
        ),
      ).toBe(true)

      setCustomShortcut('prevDayWeekMonth', 'Ctrl + PageUp')

      // New binding fires
      expect(
        matchesShortcutBinding(
          { altKey: false, ctrlKey: true, metaKey: false, shiftKey: false, key: 'PageUp' },
          'prevDayWeekMonth',
        ),
      ).toBe(true)
      // Old Alt+← does not fire
      expect(
        matchesShortcutBinding(
          { altKey: true, ctrlKey: false, metaKey: false, shiftKey: false, key: 'ArrowLeft' },
          'prevDayWeekMonth',
        ),
      ).toBe(false)
    })

    it('rebinding goToToday to Ctrl+Home fires on new and not on Alt+T', () => {
      setCustomShortcut('goToToday', 'Ctrl + Home')
      expect(
        matchesShortcutBinding(
          { altKey: false, ctrlKey: true, metaKey: false, shiftKey: false, key: 'Home' },
          'goToToday',
        ),
      ).toBe(true)
      expect(
        matchesShortcutBinding(
          { altKey: true, ctrlKey: false, metaKey: false, shiftKey: false, key: 't' },
          'goToToday',
        ),
      ).toBe(false)
    })
  })

  describe('` / ` alternative splitting (BUG-18)', () => {
    it('custom `/` alternatives match either side', () => {
      setCustomShortcut('focusSearch', 'Ctrl + F / Ctrl + Shift + F')
      expect(
        matchesShortcutBinding(
          { altKey: false, ctrlKey: true, metaKey: false, shiftKey: false, key: 'f' },
          'focusSearch',
        ),
      ).toBe(true)
      expect(
        matchesShortcutBinding(
          { altKey: false, ctrlKey: true, metaKey: false, shiftKey: true, key: 'f' },
          'focusSearch',
        ),
      ).toBe(true)
    })
  })
})
