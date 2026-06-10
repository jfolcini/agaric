// @vitest-environment jsdom
// PEND-37: same Storage-prototype-spy pattern as useBlockCollapse /
// useLocalStoragePreference — pin to jsdom until the spies target the
// instance directly.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  configKeyToTipTap,
  DEFAULT_SHORTCUTS,
  findConflicts,
  getCurrentShortcuts,
  getCustomOverrides,
  getShortcutKeys,
  matchesShortcutBinding,
  normalizeBinding,
  resetAllShortcuts,
  resetShortcut,
  setCustomShortcut,
  toAriaKeyshortcuts,
  validateBindingInput,
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

afterEach(() => {
  vi.restoreAllMocks()
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

  describe('toAriaKeyshortcuts (#216 C2)', () => {
    it('normalises modifiers and strips key whitespace to canonical tokens', () => {
      expect(toAriaKeyshortcuts('Ctrl + E')).toBe('Control+E')
      expect(toAriaKeyshortcuts('Ctrl + Shift + S')).toBe('Control+Shift+S')
      expect(toAriaKeyshortcuts('Ctrl + Shift + Arrow Up')).toBe('Control+Shift+ArrowUp')
    })

    it('maps Cmd/⌘ → Meta and Opt/Option → Alt', () => {
      expect(toAriaKeyshortcuts('Cmd + B')).toBe('Meta+B')
      expect(toAriaKeyshortcuts('⌘ + K')).toBe('Meta+K')
      expect(toAriaKeyshortcuts('Opt + Enter')).toBe('Alt+Enter')
    })

    it('returns empty string for an empty binding', () => {
      expect(toAriaKeyshortcuts('')).toBe('')
    })
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

  it('findConflicts does NOT flag Backspace defaults with different conditions (UX-394)', () => {
    // Backspace appears twice in editing (deleteBlock & mergeWithPrevious) with
    // different conditions (onEmptyBlock vs atStartOfBlock). Per UX-394,
    // findConflicts now respects the `condition` field, so these are NOT
    // conflicts — they fire under disjoint editor states.
    const conflicts = findConflicts()
    expect(conflicts).toHaveLength(0)
  })

  it('findConflicts does NOT flag prevBlock/nextBlock when rebound to the same keys (different conditions)', () => {
    // prevBlock fires only at the start of a block; nextBlock fires only at the
    // end. They have different defined conditions, so even when bound to the
    // same key they cannot fire together — UX-394 expects no conflict here.
    const nextDefault = DEFAULT_SHORTCUTS.find((s) => s.id === 'nextBlock')
    setCustomShortcut('prevBlock', nextDefault?.keys ?? '')

    const conflicts = findConflicts()
    const navConflict = conflicts.find(
      (c) => c.ids.includes('prevBlock') && c.ids.includes('nextBlock'),
    )
    expect(navConflict).toBeUndefined()
  })

  it('findConflicts detects actual conflict when custom shortcut duplicates another (both unconditional)', () => {
    // saveBlock and indentBlock both have NO condition, so they are wildcards
    // and fire unconditionally on the same (keys, category). Setting saveBlock
    // to indentBlock's default keys should surface a real conflict.
    const indentDefault = DEFAULT_SHORTCUTS.find((s) => s.id === 'indentBlock')
    setCustomShortcut('saveBlock', indentDefault?.keys ?? '')

    const conflicts = findConflicts()
    const editingConflict = conflicts.find(
      (c) => c.ids.includes('saveBlock') && c.ids.includes('indentBlock'),
    )
    expect(editingConflict).toBeDefined()
    expect(editingConflict?.keys).toBe(indentDefault?.keys)
    expect(editingConflict?.category).toBe('keyboard.category.editing')
  })

  it('findConflicts flags two wildcard shortcuts on same (keys, category) — UX-394 Pass 1', () => {
    // indentBlock and dedentBlock both have NO condition. Bind them to the
    // same brand-new key combo: wildcard×wildcard → conflict.
    setCustomShortcut('indentBlock', 'Ctrl + Alt + W')
    setCustomShortcut('dedentBlock', 'Ctrl + Alt + W')

    const conflicts = findConflicts()
    const c = conflicts.find((x) => x.ids.includes('indentBlock') && x.ids.includes('dedentBlock'))
    expect(c).toBeDefined()
    expect(c?.keys).toBe('Ctrl + Alt + W')
    expect(c?.category).toBe('keyboard.category.editing')
  })

  it('findConflicts flags wildcard×conditioned cross-conflict on same (keys, category) — UX-394 Pass 2', () => {
    // indentBlock has no condition (wildcard); mergeWithPrevious has condition
    // `atStartOfBlock`. Rebinding indentBlock to 'Backspace' puts a wildcard
    // alongside a conditioned binding on the same (keys, category) — wildcard
    // fires unconditionally, so it collides with the conditioned binding.
    setCustomShortcut('indentBlock', 'Backspace')

    const conflicts = findConflicts()
    const c = conflicts.find(
      (x) => x.ids.includes('indentBlock') && x.ids.includes('mergeWithPrevious'),
    )
    expect(c).toBeDefined()
    expect(c?.keys).toBe('Backspace')
    expect(c?.category).toBe('keyboard.category.editing')
  })

  it('findConflicts does NOT flag two conditioned shortcuts with different conditions on same (keys, category) — UX-394', () => {
    // deleteBlock (onEmptyBlock) and mergeWithPrevious (atStartOfBlock) share
    // keys+category but have disjoint defined conditions. They never fire
    // together, so they must NOT be reported as a conflict.
    const conflicts = findConflicts()
    const c = conflicts.find(
      (x) => x.ids.includes('deleteBlock') && x.ids.includes('mergeWithPrevious'),
    )
    expect(c).toBeUndefined()
  })

  // ── #754 Pass 3: cross-category conflicts between always-on listeners ──

  it('findConflicts flags a cross-category collision between two always-on listeners (#754)', () => {
    // goToToday (journal listener) rebound onto paletteOpen's chord
    // (global listener). Both listeners run on every keystroke, so the
    // two bindings race — previously unflagged because the grouping was
    // (keys, category).
    setCustomShortcut('goToToday', 'Ctrl + K')

    const conflicts = findConflicts()
    const c = conflicts.find((x) => x.ids.includes('goToToday') && x.ids.includes('paletteOpen'))
    expect(c).toBeDefined()
    expect(c?.keys).toBe('Ctrl + K')
  })

  it('findConflicts pass 3 matches individual chord alternatives (#754)', () => {
    // createNewPage (global, wildcard) rebound to ONE alternative of
    // redoLastUndoneOp's 'Ctrl + Y / Ctrl + Shift + Z' (undoRedo,
    // conditioned). Wildcard × conditioned across always-on categories
    // → flagged, keyed on the shared chord.
    setCustomShortcut('createNewPage', 'Ctrl + Shift + Z')

    const conflicts = findConflicts()
    const c = conflicts.find(
      (x) => x.ids.includes('createNewPage') && x.ids.includes('redoLastUndoneOp'),
    )
    expect(c).toBeDefined()
    expect(c?.keys).toBe('Ctrl + Shift + Z')
  })

  it('findConflicts pass 3 does NOT flag disjoint defined conditions across categories (#754)', () => {
    // findInPageNext (global, condition findInPageOpen) rebound onto
    // closeActiveTab's chord (tabs, condition desktopOnly). Both
    // conditions are defined and differ → assumed disjoint, not flagged
    // (UX-394 rule carried over to pass 3).
    setCustomShortcut('findInPageNext', 'Ctrl + W')

    const conflicts = findConflicts()
    const c = conflicts.find(
      (x) => x.ids.includes('findInPageNext') && x.ids.includes('closeActiveTab'),
    )
    expect(c).toBeUndefined()
  })

  it('findConflicts pass 3 ignores editor-scoped categories (documented benign default pairs)', () => {
    // runLastCommand (global) and collapseExpand (editing) share
    // 'Ctrl + .' by design — the editing listener only fires with a
    // focused block, exactly when runLastCommand bails. Editor-scoped
    // categories are outside the always-on set, so the pair stays
    // unflagged (and the defaults stay conflict-free, asserted above).
    const conflicts = findConflicts()
    const c = conflicts.find(
      (x) => x.ids.includes('runLastCommand') && x.ids.includes('collapseExpand'),
    )
    expect(c).toBeUndefined()
  })

  it('findConflicts pass 3 covers the page-editor document listener (#754)', () => {
    // PageHeader installs a document-level keydown for exportPageMarkdown
    // whenever a page is open — it races the always-on listeners exactly
    // like the global/journal/spaces/tabs/undoRedo set. createNewPage
    // (global, wildcard) rebound onto its chord must be flagged.
    setCustomShortcut('createNewPage', 'Ctrl + Shift + E')

    const conflicts = findConflicts()
    const c = conflicts.find(
      (x) => x.ids.includes('createNewPage') && x.ids.includes('exportPageMarkdown'),
    )
    expect(c).toBeDefined()
    expect(c?.keys).toBe('Ctrl + Shift + E')
  })

  // ── #754: getCustomOverrides parse cache ────────────────────────────

  it('getCustomOverrides parses the blob once across repeated calls (#754 cache)', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ indentBlock: 'Ctrl + Alt + P' }))
    const parseSpy = vi.spyOn(JSON, 'parse')

    expect(getCustomOverrides()).toEqual({ indentBlock: 'Ctrl + Alt + P' })
    expect(getCustomOverrides()).toEqual({ indentBlock: 'Ctrl + Alt + P' })
    expect(getCustomOverrides()).toEqual({ indentBlock: 'Ctrl + Alt + P' })

    expect(parseSpy).toHaveBeenCalledTimes(1)
    parseSpy.mockRestore()
  })

  it('getCustomOverrides cache self-invalidates on a direct localStorage write (#754)', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ indentBlock: 'Ctrl + Alt + 1' }))
    expect(getCustomOverrides()).toEqual({ indentBlock: 'Ctrl + Alt + 1' })

    // Bypass setCustomShortcut entirely — e.g. another tab's write.
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ dedentBlock: 'Ctrl + Alt + 2' }))
    expect(getCustomOverrides()).toEqual({ dedentBlock: 'Ctrl + Alt + 2' })
  })

  it('a failed setCustomShortcut write does not corrupt the cached overrides (#754)', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ indentBlock: 'Ctrl + Alt + 3' }))
    expect(getCustomOverrides()).toEqual({ indentBlock: 'Ctrl + Alt + 3' })

    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceeded')
    })
    setCustomShortcut('dedentBlock', 'Ctrl + Alt + 4')
    vi.restoreAllMocks()

    // The write never landed; the cached view must still mirror storage.
    expect(getCustomOverrides()).toEqual({ indentBlock: 'Ctrl + Alt + 3' })
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

    it('strikethrough defaults to Ctrl + Shift + S (#211 P2-11)', () => {
      // #211 P2-11: rebound from the low-mnemonic `Ctrl+Shift+X` to
      // `Ctrl+Shift+S`. `StrikeWithShortcut` keeps `Ctrl+Shift+X` as a
      // hardcoded legacy alias for one release, so the old chord still works
      // even though the catalog (display + tooltip) now advertises `S`.
      const s = DEFAULT_SHORTCUTS.find((s) => s.id === 'strikethrough')
      expect(s?.keys).toBe('Ctrl + Shift + S')
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
      // PEND-52 — the default focusSearch binding is now Ctrl+Shift+F.
      // (Ctrl+F was reclaimed for the in-page find toolbar.)
      expect(
        matchesShortcutBinding(
          { altKey: false, ctrlKey: true, metaKey: false, shiftKey: true, key: 'f' },
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
      // Old Ctrl+Shift+F does NOT fire after rebind
      expect(
        matchesShortcutBinding(
          { altKey: false, ctrlKey: true, metaKey: false, shiftKey: true, key: 'f' },
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

  // ── #723 — validator/matcher tokenizer unification ──────────────────────

  describe('#723 — user-typed override formats are normalised and honoured', () => {
    function ev(
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

    it('setCustomShortcut normalises unspaced "Ctrl+E" to canonical form and the matcher honours it', () => {
      setCustomShortcut('focusSearch', 'Ctrl+E')
      expect(getCustomOverrides()['focusSearch']).toBe('Ctrl + E')
      expect(matchesShortcutBinding(ev('e', { ctrlKey: true }), 'focusSearch')).toBe(true)
      // The old default must no longer fire.
      expect(
        matchesShortcutBinding(ev('f', { ctrlKey: true, shiftKey: true }), 'focusSearch'),
      ).toBe(false)
    })

    it('setting the default chord in a non-canonical format removes the override', () => {
      // inlineCode default is `Ctrl + E`; typing it as `Ctrl+E` must be
      // recognised as the default, not stored as a phantom customisation.
      setCustomShortcut('inlineCode', 'Ctrl+E')
      expect(getCustomOverrides()['inlineCode']).toBeUndefined()
      expect(matchesShortcutBinding(ev('e', { ctrlKey: true }), 'inlineCode')).toBe(true)
    })

    it.each([
      ['Cmd + K', 'Ctrl + K', 'k'],
      ['Command + K', 'Ctrl + K', 'k'],
      ['Control + E', 'Ctrl + E', 'e'],
      ['Mod + K', 'Ctrl + K', 'k'],
    ])('modifier alias %s normalises to %s and fires', (typed, stored, key) => {
      setCustomShortcut('focusSearch', typed)
      expect(getCustomOverrides()['focusSearch']).toBe(stored)
      expect(matchesShortcutBinding(ev(key, { ctrlKey: true }), 'focusSearch')).toBe(true)
      expect(matchesShortcutBinding(ev(key, { metaKey: true }), 'focusSearch')).toBe(true)
    })

    it('"Meta + K" requires the modifier — plain K must NOT fire (inverted semantics fixed)', () => {
      setCustomShortcut('focusSearch', 'Meta + K')
      expect(getCustomOverrides()['focusSearch']).toBe('Ctrl + K')
      expect(matchesShortcutBinding(ev('k'), 'focusSearch')).toBe(false)
      expect(matchesShortcutBinding(ev('k', { metaKey: true }), 'focusSearch')).toBe(true)
      expect(matchesShortcutBinding(ev('k', { ctrlKey: true }), 'focusSearch')).toBe(true)
    })

    it('separator variants "Ctrl-Shift-E" and "Ctrl Shift E" normalise identically', () => {
      setCustomShortcut('focusSearch', 'Ctrl-Shift-E')
      expect(getCustomOverrides()['focusSearch']).toBe('Ctrl + Shift + E')
      setCustomShortcut('focusSearch', 'Ctrl Shift E')
      expect(getCustomOverrides()['focusSearch']).toBe('Ctrl + Shift + E')
      expect(
        matchesShortcutBinding(ev('E', { ctrlKey: true, shiftKey: true }), 'focusSearch'),
      ).toBe(true)
    })

    it('legacy non-canonical overrides already saved in localStorage are honoured', () => {
      // Saved by a pre-#723 build: the validator accepted these formats but
      // the old matcher could not parse them (dead bindings). The unified
      // parser must bring them back to life without a migration.
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ focusSearch: 'Ctrl+G', paletteOpen: 'Cmd + L' }),
      )
      expect(matchesShortcutBinding(ev('g', { ctrlKey: true }), 'focusSearch')).toBe(true)
      expect(matchesShortcutBinding(ev('l', { metaKey: true }), 'paletteOpen')).toBe(true)
    })

    it('a key that is literally `+` or `-` still round-trips', () => {
      setCustomShortcut('graphZoomIn', 'Ctrl + +')
      expect(getCustomOverrides()['graphZoomIn']).toBe('Ctrl + +')
      expect(
        matchesShortcutBinding(ev('+', { ctrlKey: true, shiftKey: true }), 'graphZoomIn'),
      ).toBe(true)
      setCustomShortcut('graphZoomOut', 'Ctrl--')
      expect(getCustomOverrides()['graphZoomOut']).toBe('Ctrl + -')
      expect(matchesShortcutBinding(ev('-', { ctrlKey: true }), 'graphZoomOut')).toBe(true)
    })

    it.each([
      // The exact glyph set `formatChordTokens` renders (⌃⇧⌘⌥) — users copy
      // these back into the Settings input, so every one must parse as a
      // modifier instead of being silently saved as a dead key token.
      ['⌘ + K', 'Ctrl + K', 'k', { ctrlKey: true }],
      ['⌘K', 'Ctrl + K', 'k', { metaKey: true }],
      ['⌃ + B', 'Ctrl + B', 'b', { ctrlKey: true }],
      ['⌥ + E', 'Alt + E', 'e', { altKey: true }],
      ['⇧ + F3', 'Shift + F3', 'F3', { shiftKey: true }],
      ['⇧⌘K', 'Ctrl + Shift + K', 'k', { ctrlKey: true, shiftKey: true }],
    ] as const)('mac modifier glyph %s normalises to %s and fires', (typed, stored, key, mods) => {
      setCustomShortcut('focusSearch', typed)
      expect(getCustomOverrides()['focusSearch']).toBe(stored)
      expect(matchesShortcutBinding(ev(key, mods), 'focusSearch')).toBe(true)
    })

    it('a bare modifier glyph is rejected as modifier-only, not saved as a key', () => {
      expect(validateBindingInput('⇧')).toBe('modifierOnly')
      expect(validateBindingInput('⌘ + ')).toBe('modifierOnly')
    })

    it('normalisation is a no-op for every catalog default (no phantom overrides)', () => {
      for (const s of DEFAULT_SHORTCUTS) {
        setCustomShortcut(s.id, s.keys)
        expect(
          getCustomOverrides()[s.id],
          `default keys for "${s.id}" must round-trip without creating an override`,
        ).toBeUndefined()
      }
    })

    it('normalizeBinding preserves ` / ` alternatives', () => {
      expect(normalizeBinding('Ctrl+F / Cmd + Shift + F')).toBe('Ctrl + F / Ctrl + Shift + F')
    })

    describe('validateBindingInput (shared with the Settings tab)', () => {
      it('rejects empty input', () => {
        expect(validateBindingInput('')).toBe('empty')
        expect(validateBindingInput('   ')).toBe('empty')
      })

      it('rejects modifier-only input in any accepted format', () => {
        expect(validateBindingInput('Ctrl + Shift')).toBe('modifierOnly')
        expect(validateBindingInput('Ctrl+Shift')).toBe('modifierOnly')
        expect(validateBindingInput('Ctrl')).toBe('modifierOnly')
        expect(validateBindingInput('Cmd')).toBe('modifierOnly')
        expect(validateBindingInput('Ctrl +')).toBe('modifierOnly')
      })

      it('accepts everything the matcher can honour', () => {
        expect(validateBindingInput('Ctrl + E')).toBeNull()
        expect(validateBindingInput('Ctrl+E')).toBeNull()
        expect(validateBindingInput('Mod + K')).toBeNull()
        expect(validateBindingInput('?')).toBeNull()
        expect(validateBindingInput('j / k')).toBeNull()
        expect(validateBindingInput('Ctrl + Shift + Arrow Up')).toBeNull()
      })

      it('rejects a modifier-only alternative inside a ` / ` list', () => {
        expect(validateBindingInput('Ctrl + E / Shift')).toBe('modifierOnly')
      })
    })
  })

  // ── #724 — formerly hardcoded listeners now consume the config ──────────

  describe('#724 — rebinding is honoured for formerly hardcoded shortcuts', () => {
    function ev(
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

    it('showShortcuts: default `?` matches regardless of shift, but not with Ctrl/Alt', () => {
      expect(matchesShortcutBinding(ev('?', { shiftKey: true }), 'showShortcuts')).toBe(true)
      expect(matchesShortcutBinding(ev('?'), 'showShortcuts')).toBe(true)
      // Ctrl+Shift+/ produces `?` on US layouts — must NOT fire the default.
      expect(
        matchesShortcutBinding(ev('?', { ctrlKey: true, shiftKey: true }), 'showShortcuts'),
      ).toBe(false)
      expect(matchesShortcutBinding(ev('?', { altKey: true }), 'showShortcuts')).toBe(false)
    })

    it('showShortcuts: rebind fires on the new chord and not on `?`', () => {
      setCustomShortcut('showShortcuts', 'Ctrl + /')
      expect(matchesShortcutBinding(ev('/', { ctrlKey: true }), 'showShortcuts')).toBe(true)
      expect(matchesShortcutBinding(ev('?', { shiftKey: true }), 'showShortcuts')).toBe(false)
    })

    it('toggleSidebar: default Ctrl+B / Cmd+B matches, plain b does not', () => {
      expect(matchesShortcutBinding(ev('b', { ctrlKey: true }), 'toggleSidebar')).toBe(true)
      expect(matchesShortcutBinding(ev('b', { metaKey: true }), 'toggleSidebar')).toBe(true)
      expect(matchesShortcutBinding(ev('b'), 'toggleSidebar')).toBe(false)
    })

    it('toggleSidebar: rebind fires on the new chord and not on Ctrl+B', () => {
      setCustomShortcut('toggleSidebar', 'Ctrl + Shift + L')
      expect(
        matchesShortcutBinding(ev('l', { ctrlKey: true, shiftKey: true }), 'toggleSidebar'),
      ).toBe(true)
      expect(matchesShortcutBinding(ev('b', { ctrlKey: true }), 'toggleSidebar')).toBe(false)
    })

    it('undoLastPageOp: Ctrl+Z fires, Ctrl+Shift+Z does not (redo chord)', () => {
      expect(matchesShortcutBinding(ev('z', { ctrlKey: true }), 'undoLastPageOp')).toBe(true)
      expect(
        matchesShortcutBinding(ev('z', { ctrlKey: true, shiftKey: true }), 'undoLastPageOp'),
      ).toBe(false)
    })

    it('redoLastUndoneOp: both default alternatives fire (Ctrl+Y, Ctrl+Shift+Z)', () => {
      expect(matchesShortcutBinding(ev('y', { ctrlKey: true }), 'redoLastUndoneOp')).toBe(true)
      expect(
        matchesShortcutBinding(ev('z', { ctrlKey: true, shiftKey: true }), 'redoLastUndoneOp'),
      ).toBe(true)
      expect(
        matchesShortcutBinding(ev('Z', { ctrlKey: true, shiftKey: true }), 'redoLastUndoneOp'),
      ).toBe(true)
    })

    it('undo/redo rebinds fire on the new chord and not on the defaults', () => {
      setCustomShortcut('undoLastPageOp', 'Ctrl + Alt + Z')
      expect(
        matchesShortcutBinding(ev('z', { ctrlKey: true, altKey: true }), 'undoLastPageOp'),
      ).toBe(true)
      expect(matchesShortcutBinding(ev('z', { ctrlKey: true }), 'undoLastPageOp')).toBe(false)

      setCustomShortcut('redoLastUndoneOp', 'Ctrl + Alt + Y')
      expect(
        matchesShortcutBinding(ev('y', { ctrlKey: true, altKey: true }), 'redoLastUndoneOp'),
      ).toBe(true)
      expect(matchesShortcutBinding(ev('y', { ctrlKey: true }), 'redoLastUndoneOp')).toBe(false)
    })

    it('findInPageNext / findInPagePrev: F3 and Shift+F3 are disjoint', () => {
      expect(matchesShortcutBinding(ev('F3'), 'findInPageNext')).toBe(true)
      expect(matchesShortcutBinding(ev('F3', { shiftKey: true }), 'findInPageNext')).toBe(false)
      expect(matchesShortcutBinding(ev('F3', { shiftKey: true }), 'findInPagePrev')).toBe(true)
      expect(matchesShortcutBinding(ev('F3'), 'findInPagePrev')).toBe(false)
    })

    it('findInPageNext: rebind fires on the new chord and not on F3', () => {
      setCustomShortcut('findInPageNext', 'Ctrl + G')
      expect(matchesShortcutBinding(ev('g', { ctrlKey: true }), 'findInPageNext')).toBe(true)
      expect(matchesShortcutBinding(ev('F3'), 'findInPageNext')).toBe(false)
    })

    it('selectAllBlocks / clearSelection: defaults fire, rebinds are honoured', () => {
      expect(matchesShortcutBinding(ev('a', { ctrlKey: true }), 'selectAllBlocks')).toBe(true)
      expect(matchesShortcutBinding(ev('Escape'), 'clearSelection')).toBe(true)
      expect(matchesShortcutBinding(ev('Escape', { ctrlKey: true }), 'clearSelection')).toBe(false)

      setCustomShortcut('selectAllBlocks', 'Ctrl + Shift + A')
      expect(
        matchesShortcutBinding(ev('a', { ctrlKey: true, shiftKey: true }), 'selectAllBlocks'),
      ).toBe(true)
      expect(matchesShortcutBinding(ev('a', { ctrlKey: true }), 'selectAllBlocks')).toBe(false)
    })

    it('cycleTaskState / collapseExpand: defaults fire, rebinds are honoured', () => {
      expect(matchesShortcutBinding(ev('Enter', { ctrlKey: true }), 'cycleTaskState')).toBe(true)
      expect(matchesShortcutBinding(ev('.', { metaKey: true }), 'collapseExpand')).toBe(true)

      setCustomShortcut('cycleTaskState', 'Alt + Enter')
      expect(matchesShortcutBinding(ev('Enter', { altKey: true }), 'cycleTaskState')).toBe(true)
      expect(matchesShortcutBinding(ev('Enter', { ctrlKey: true }), 'cycleTaskState')).toBe(false)
    })

    it('moveBlockUp / indentBlock: spelled-out `Arrow Up` key names match real ArrowUp events', () => {
      // The catalog stores `Ctrl + Shift + Arrow Up` — `normalizeKey` must
      // collapse the internal space so it equals `KeyboardEvent.key === 'ArrowUp'`.
      expect(
        matchesShortcutBinding(ev('ArrowUp', { ctrlKey: true, shiftKey: true }), 'moveBlockUp'),
      ).toBe(true)
      expect(
        matchesShortcutBinding(ev('ArrowRight', { ctrlKey: true, shiftKey: true }), 'indentBlock'),
      ).toBe(true)
      // Without the modifiers, no match.
      expect(matchesShortcutBinding(ev('ArrowUp'), 'moveBlockUp')).toBe(false)
    })

    it('moveBlockUp: rebind fires on the new chord and not on the default', () => {
      setCustomShortcut('moveBlockUp', 'Alt + Arrow Up')
      expect(matchesShortcutBinding(ev('ArrowUp', { altKey: true }), 'moveBlockUp')).toBe(true)
      expect(
        matchesShortcutBinding(ev('ArrowUp', { ctrlKey: true, shiftKey: true }), 'moveBlockUp'),
      ).toBe(false)
    })

    it('histRevertSelected: Enter fires by default; rebind is honoured', () => {
      expect(matchesShortcutBinding(ev('Enter'), 'histRevertSelected')).toBe(true)
      setCustomShortcut('histRevertSelected', 'r')
      expect(matchesShortcutBinding(ev('r'), 'histRevertSelected')).toBe(true)
      expect(matchesShortcutBinding(ev('Enter'), 'histRevertSelected')).toBe(false)
    })
  })
})
