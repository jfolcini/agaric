/**
 * Tests for toolbar-config — exported constants and factory functions.
 *
 * Validates:
 *  - Constants (toolbarActiveClass, CODE_LANGUAGES, LANG_SHORT) have expected values
 *  - Factory functions return arrays with the correct length and shape
 *  - Each ToolbarButtonConfig has required fields (icon, label, tip, action)
 *  - Editor-dependent factories call editor chain methods when actions are invoked
 *  - Event-only factories dispatch expected block events
 */

import { describe, expect, it, vi } from 'vitest'
import type { ToolbarButtonConfig } from '../toolbar-config'
import {
  CODE_LANGUAGES,
  createHistoryButtons,
  createMarkToggles,
  createMetadataButtons,
  createRefsAndBlocks,
  createStructureButtons,
  LANG_SHORT,
  toolbarActiveClass,
} from '../toolbar-config'

// ── Mock editor ─────────────────────────────────────────────────────────

const mockRun = vi.fn()
const mockFocus = vi.fn(() => ({
  toggleBold: vi.fn(() => ({ run: mockRun })),
  toggleItalic: vi.fn(() => ({ run: mockRun })),
  toggleCode: vi.fn(() => ({ run: mockRun })),
  toggleStrike: vi.fn(() => ({ run: mockRun })),
  toggleHighlight: vi.fn(() => ({ run: mockRun })),
  toggleBlockquote: vi.fn(() => ({ run: mockRun })),
  insertContent: vi.fn(() => ({ run: mockRun })),
  undo: vi.fn(() => ({ run: mockRun })),
  redo: vi.fn(() => ({ run: mockRun })),
}))
const mockChain = vi.fn(() => ({ focus: mockFocus }))

function makeEditor() {
  return { chain: mockChain } as never
}

// ── Helpers ─────────────────────────────────────────────────────────────

function assertValidConfig(btn: ToolbarButtonConfig): void {
  expect(typeof btn.label).toBe('string')
  expect(btn.label.length).toBeGreaterThan(0)
  expect(typeof btn.tip).toBe('string')
  expect(btn.tip.length).toBeGreaterThan(0)
  expect(typeof btn.action).toBe('function')
  expect(btn.icon).toBeDefined()
}

// ── Constants ───────────────────────────────────────────────────────────

describe('toolbarActiveClass', () => {
  it('contains bg-accent', () => {
    expect(toolbarActiveClass).toContain('bg-accent')
  })
})

describe('CODE_LANGUAGES', () => {
  it('contains 17 languages', () => {
    expect(CODE_LANGUAGES).toHaveLength(17)
  })

  it('includes core languages', () => {
    for (const lang of ['javascript', 'typescript', 'python', 'rust', 'bash', 'sql']) {
      expect(CODE_LANGUAGES).toContain(lang)
    }
  })

  it('entries are all unique', () => {
    expect(new Set(CODE_LANGUAGES).size).toBe(CODE_LANGUAGES.length)
  })
})

describe('LANG_SHORT', () => {
  it('has an entry for every CODE_LANGUAGE', () => {
    for (const lang of CODE_LANGUAGES) {
      expect(LANG_SHORT[lang]).toBeDefined()
      expect(typeof LANG_SHORT[lang]).toBe('string')
    }
  })

  it('maps javascript to JS', () => {
    expect(LANG_SHORT.javascript).toBe('JS')
  })

  it('maps typescript to TS', () => {
    expect(LANG_SHORT.typescript).toBe('TS')
  })
})

// ── createMarkToggles ───────────────────────────────────────────────────

describe('createMarkToggles', () => {
  it('returns 5 buttons', () => {
    const buttons = createMarkToggles(makeEditor())
    expect(buttons).toHaveLength(5)
  })

  it('each button has valid config shape', () => {
    const buttons = createMarkToggles(makeEditor())
    for (const btn of buttons) {
      assertValidConfig(btn)
      expect(btn.activeKey).toBeDefined()
    }
  })

  it('includes bold, italic, code, strikethrough, highlight', () => {
    const buttons = createMarkToggles(makeEditor())
    const labels = buttons.map((b) => b.label)
    expect(labels).toEqual([
      'toolbar.bold',
      'toolbar.italic',
      'toolbar.code',
      'toolbar.strikethrough',
      'toolbar.highlight',
    ])
  })

  it('actions invoke editor chain', () => {
    const editor = makeEditor()
    const buttons = createMarkToggles(editor)
    buttons[0]?.action()
    expect(mockChain).toHaveBeenCalled()
    expect(mockFocus).toHaveBeenCalled()
  })
})

// ── createRefsAndBlocks ─────────────────────────────────────────────────

describe('createRefsAndBlocks', () => {
  it('returns 3 buttons', () => {
    const buttons = createRefsAndBlocks(makeEditor())
    expect(buttons).toHaveLength(3)
  })

  it('each button has valid config shape', () => {
    const buttons = createRefsAndBlocks(makeEditor())
    for (const btn of buttons) {
      assertValidConfig(btn)
    }
  })

  it('includes internalLink, insertTag, blockquote', () => {
    const buttons = createRefsAndBlocks(makeEditor())
    const labels = buttons.map((b) => b.label)
    expect(labels).toEqual(['toolbar.internalLink', 'toolbar.insertTag', 'toolbar.blockquote'])
  })
})

// ── createStructureButtons ──────────────────────────────────────────────

describe('createStructureButtons', () => {
  it('returns 3 buttons', () => {
    const buttons = createStructureButtons()
    expect(buttons).toHaveLength(3)
  })

  it('each button has valid config shape', () => {
    const buttons = createStructureButtons()
    for (const btn of buttons) {
      assertValidConfig(btn)
    }
  })

  it('includes orderedList, divider, callout', () => {
    const buttons = createStructureButtons()
    const labels = buttons.map((b) => b.label)
    expect(labels).toEqual(['toolbar.orderedList', 'toolbar.divider', 'toolbar.callout'])
  })

  it('actions dispatch block events', () => {
    const spy = vi.fn()
    document.addEventListener('insert-ordered-list', spy)
    const buttons = createStructureButtons()
    buttons[0]?.action()
    expect(spy).toHaveBeenCalledOnce()
    document.removeEventListener('insert-ordered-list', spy)
  })
})

// ── createMetadataButtons ───────────────────────────────────────────────

describe('createMetadataButtons', () => {
  it('returns 5 buttons', () => {
    const buttons = createMetadataButtons()
    expect(buttons).toHaveLength(5)
  })

  it('each button has valid config shape', () => {
    const buttons = createMetadataButtons()
    for (const btn of buttons) {
      assertValidConfig(btn)
    }
  })

  it('includes insertDate, setDueDate, setScheduledDate, todoToggle, properties', () => {
    const buttons = createMetadataButtons()
    const labels = buttons.map((b) => b.label)
    expect(labels).toEqual([
      'toolbar.insertDate',
      'toolbar.setDueDate',
      'toolbar.setScheduledDate',
      'toolbar.todoToggle',
      'toolbar.properties',
    ])
  })

  it('actions dispatch block events', () => {
    const spy = vi.fn()
    document.addEventListener('open-date-picker', spy)
    const buttons = createMetadataButtons()
    buttons[0]?.action()
    expect(spy).toHaveBeenCalledOnce()
    document.removeEventListener('open-date-picker', spy)
  })
})

// ── createHistoryButtons ────────────────────────────────────────────────

describe('createHistoryButtons', () => {
  it('returns 3 buttons', () => {
    const buttons = createHistoryButtons(makeEditor())
    expect(buttons).toHaveLength(3)
  })

  it('each button has valid config shape', () => {
    const buttons = createHistoryButtons(makeEditor())
    for (const btn of buttons) {
      assertValidConfig(btn)
    }
  })

  it('includes undo, redo, discard', () => {
    const buttons = createHistoryButtons(makeEditor())
    const labels = buttons.map((b) => b.label)
    expect(labels).toEqual(['toolbar.undo', 'toolbar.redo', 'toolbar.discard'])
  })

  it('undo and redo have disabledWhenFalse keys', () => {
    const buttons = createHistoryButtons(makeEditor())
    expect(buttons[0]?.disabledWhenFalse).toBe('canUndo')
    expect(buttons[1]?.disabledWhenFalse).toBe('canRedo')
  })

  it('discard dispatches block event', () => {
    const spy = vi.fn()
    document.addEventListener('discard-block-edit', spy)
    const buttons = createHistoryButtons(makeEditor())
    buttons[2]?.action()
    expect(spy).toHaveBeenCalledOnce()
    document.removeEventListener('discard-block-edit', spy)
  })
})
