import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
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
    // Verify every entry has required fields
    for (const s of DEFAULT_SHORTCUTS) {
      expect(s.id).toBeTruthy()
      expect(s.keys).toBeTruthy()
      expect(s.category).toBeTruthy()
      expect(s.description).toBeTruthy()
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
    expect(shortcut?.category).toBe('keyboard.category.global')
    expect(shortcut?.description).toBe('keyboard.exportPageMarkdown')
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
  })
})
