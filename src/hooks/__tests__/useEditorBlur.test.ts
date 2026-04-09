/**
 * Tests for useEditorBlur hook.
 *
 * Validates:
 *  - Happy path: blur when focus moves outside portals triggers edit
 *  - Portal guard: blur when relatedTarget is inside a portal does NOT trigger edit
 *  - Portal guard: blur when a visible portal is in the DOM does NOT trigger edit
 *  - Split: blur with multi-paragraph content triggers splitBlock
 *  - Stale: blur after editor moved to a different block is ignored
 *  - No active block: blur with no active block is ignored
 *  - New-block early persist: saves typed content for empty originalMarkdown
 *  - discardDraft is called after successful unmount with changes
 */

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EDITOR_PORTAL_SELECTORS, useEditorBlur } from '../useEditorBlur'

// Mock shouldSplitOnBlur from use-roving-editor
const mockShouldSplitOnBlur = vi.fn((md: string) => md.includes('\n'))
vi.mock('../../editor/use-roving-editor', () => ({
  shouldSplitOnBlur: (...args: unknown[]) => mockShouldSplitOnBlur(...(args as [string])),
}))

/** Create a minimal mock roving editor handle for the hook. */
function makeRovingEditor(
  overrides: Partial<{
    activeBlockId: string | null
    originalMarkdown: string
    getMarkdown: () => string | null
    unmount: () => string | null
  }> = {},
) {
  return {
    activeBlockId: overrides.activeBlockId ?? null,
    originalMarkdown: overrides.originalMarkdown ?? 'existing content',
    getMarkdown: overrides.getMarkdown ?? vi.fn<() => string | null>(() => null),
    unmount: overrides.unmount ?? vi.fn<() => string | null>(() => null),
  }
}

/** Create a minimal React.FocusEvent-like object for the hook's handleBlur. */
function makeFocusEvent(relatedTarget: HTMLElement | null = null) {
  return { relatedTarget } as unknown as React.FocusEvent
}

describe('useEditorBlur', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockShouldSplitOnBlur.mockImplementation((md: string) => md.includes('\n'))
  })

  afterEach(() => {
    // Clean up any portal elements left in the DOM
    for (const sel of EDITOR_PORTAL_SELECTORS) {
      for (const el of document.querySelectorAll(sel)) {
        el.remove()
      }
    }
  })

  // ── EDITOR_PORTAL_SELECTORS constant ─────────────────────────────────

  describe('EDITOR_PORTAL_SELECTORS', () => {
    it('is exported and contains at least 5 entries', () => {
      expect(Array.isArray(EDITOR_PORTAL_SELECTORS)).toBe(true)
      expect(EDITOR_PORTAL_SELECTORS.length).toBeGreaterThanOrEqual(5)
    })

    it('includes expected selectors', () => {
      expect(EDITOR_PORTAL_SELECTORS).toContain('.suggestion-popup')
      expect(EDITOR_PORTAL_SELECTORS).toContain('.date-picker-popup')
      expect(EDITOR_PORTAL_SELECTORS).toContain('[data-radix-popper-content-wrapper]')
      expect(EDITOR_PORTAL_SELECTORS).toContain('.block-context-menu')
    })
  })

  // ── Happy path: blur triggers edit ──────────────────────────────────

  describe('happy path', () => {
    it('unmounts and saves when content changed', () => {
      const mockUnmount = vi.fn<() => string | null>(() => 'updated text')
      const mockEdit = vi.fn()
      const mockSetFocused = vi.fn()
      const mockDiscardDraft = vi.fn()

      const roving = makeRovingEditor({
        activeBlockId: 'B1',
        unmount: mockUnmount,
      })

      const { result } = renderHook(() =>
        useEditorBlur({
          rovingEditor: roving,
          blockId: 'B1',
          edit: mockEdit,
          splitBlock: vi.fn(),
          setFocused: mockSetFocused,
          discardDraft: mockDiscardDraft,
        }),
      )

      act(() => {
        result.current.handleBlur(makeFocusEvent())
      })

      expect(mockUnmount).toHaveBeenCalledOnce()
      expect(mockEdit).toHaveBeenCalledWith('B1', 'updated text')
      expect(mockDiscardDraft).toHaveBeenCalledOnce()
      expect(mockSetFocused).toHaveBeenCalledWith(null)
    })

    it('does not save when content is unchanged (unmount returns null)', () => {
      const mockUnmount = vi.fn<() => string | null>(() => null)
      const mockEdit = vi.fn()
      const mockSetFocused = vi.fn()
      const mockDiscardDraft = vi.fn()

      const roving = makeRovingEditor({
        activeBlockId: 'B1',
        unmount: mockUnmount,
      })

      const { result } = renderHook(() =>
        useEditorBlur({
          rovingEditor: roving,
          blockId: 'B1',
          edit: mockEdit,
          splitBlock: vi.fn(),
          setFocused: mockSetFocused,
          discardDraft: mockDiscardDraft,
        }),
      )

      act(() => {
        result.current.handleBlur(makeFocusEvent())
      })

      expect(mockUnmount).toHaveBeenCalledOnce()
      expect(mockEdit).not.toHaveBeenCalled()
      expect(mockDiscardDraft).not.toHaveBeenCalled()
      expect(mockSetFocused).toHaveBeenCalledWith(null)
    })
  })

  // ── Portal guard ───────────────────────────────────────────────────

  describe('portal guard', () => {
    it('does not unmount when relatedTarget is inside a portal selector', () => {
      const mockUnmount = vi.fn<() => string | null>(() => 'changed')
      const mockEdit = vi.fn()

      const roving = makeRovingEditor({
        activeBlockId: 'B1',
        unmount: mockUnmount,
      })

      const { result } = renderHook(() =>
        useEditorBlur({
          rovingEditor: roving,
          blockId: 'B1',
          edit: mockEdit,
          splitBlock: vi.fn(),
          setFocused: vi.fn(),
          discardDraft: vi.fn(),
        }),
      )

      // Simulate relatedTarget being inside a suggestion popup
      const popup = document.createElement('div')
      popup.classList.add('suggestion-popup')
      const btn = document.createElement('button')
      popup.appendChild(btn)
      document.body.appendChild(popup)

      act(() => {
        result.current.handleBlur(makeFocusEvent(btn))
      })

      expect(mockUnmount).not.toHaveBeenCalled()
      expect(mockEdit).not.toHaveBeenCalled()
    })

    it('does not unmount when a visible portal element is in the DOM', () => {
      const mockUnmount = vi.fn<() => string | null>(() => 'changed')
      const mockEdit = vi.fn()

      const roving = makeRovingEditor({
        activeBlockId: 'B1',
        unmount: mockUnmount,
      })

      const { result } = renderHook(() =>
        useEditorBlur({
          rovingEditor: roving,
          blockId: 'B1',
          edit: mockEdit,
          splitBlock: vi.fn(),
          setFocused: vi.fn(),
          discardDraft: vi.fn(),
        }),
      )

      // Simulate a visible Radix popover in the DOM
      const portal = document.createElement('div')
      portal.setAttribute('data-radix-popper-content-wrapper', '')
      ;(portal as unknown as { checkVisibility: () => boolean }).checkVisibility = () => true
      document.body.appendChild(portal)

      act(() => {
        result.current.handleBlur(makeFocusEvent())
      })

      expect(mockUnmount).not.toHaveBeenCalled()
      expect(mockEdit).not.toHaveBeenCalled()
    })

    it('unmounts when portal elements exist but are hidden', () => {
      const mockUnmount = vi.fn<() => string | null>(() => 'changed')
      const mockEdit = vi.fn()

      const roving = makeRovingEditor({
        activeBlockId: 'B1',
        unmount: mockUnmount,
      })

      const { result } = renderHook(() =>
        useEditorBlur({
          rovingEditor: roving,
          blockId: 'B1',
          edit: mockEdit,
          splitBlock: vi.fn(),
          setFocused: vi.fn(),
          discardDraft: vi.fn(),
        }),
      )

      // Simulate a hidden Radix popover in the DOM
      const portal = document.createElement('div')
      portal.setAttribute('data-radix-popper-content-wrapper', '')
      ;(portal as unknown as { checkVisibility: () => boolean }).checkVisibility = () => false
      document.body.appendChild(portal)

      act(() => {
        result.current.handleBlur(makeFocusEvent())
      })

      expect(mockUnmount).toHaveBeenCalledOnce()
      expect(mockEdit).toHaveBeenCalledWith('B1', 'changed')
    })
  })

  // ── Split ──────────────────────────────────────────────────────────

  describe('split', () => {
    it('calls splitBlock when content has multiple paragraphs', () => {
      const multiParagraph = 'paragraph one\n\nparagraph two'
      mockShouldSplitOnBlur.mockReturnValue(true)

      const mockUnmount = vi.fn(() => multiParagraph)
      const mockEdit = vi.fn()
      const mockSplitBlock = vi.fn()

      const roving = makeRovingEditor({
        activeBlockId: 'B1',
        unmount: mockUnmount,
      })

      const { result } = renderHook(() =>
        useEditorBlur({
          rovingEditor: roving,
          blockId: 'B1',
          edit: mockEdit,
          splitBlock: mockSplitBlock,
          setFocused: vi.fn(),
          discardDraft: vi.fn(),
        }),
      )

      act(() => {
        result.current.handleBlur(makeFocusEvent())
      })

      expect(mockShouldSplitOnBlur).toHaveBeenCalledWith(multiParagraph)
      expect(mockSplitBlock).toHaveBeenCalledWith('B1', multiParagraph)
      expect(mockEdit).not.toHaveBeenCalled()
    })

    it('calls edit (not split) for a code block with internal newlines', () => {
      const codeBlock = '```js\nconst a = 1\nconst b = 2\n```'
      mockShouldSplitOnBlur.mockReturnValue(false)

      const mockUnmount = vi.fn(() => codeBlock)
      const mockEdit = vi.fn()
      const mockSplitBlock = vi.fn()

      const roving = makeRovingEditor({
        activeBlockId: 'B1',
        unmount: mockUnmount,
      })

      const { result } = renderHook(() =>
        useEditorBlur({
          rovingEditor: roving,
          blockId: 'B1',
          edit: mockEdit,
          splitBlock: mockSplitBlock,
          setFocused: vi.fn(),
          discardDraft: vi.fn(),
        }),
      )

      act(() => {
        result.current.handleBlur(makeFocusEvent())
      })

      expect(mockShouldSplitOnBlur).toHaveBeenCalledWith(codeBlock)
      expect(mockEdit).toHaveBeenCalledWith('B1', codeBlock)
      expect(mockSplitBlock).not.toHaveBeenCalled()
    })
  })

  // ── Stale blur ─────────────────────────────────────────────────────

  describe('stale blur', () => {
    it('ignores blur when editor has moved to a different block', () => {
      const mockUnmount = vi.fn<() => string | null>(() => 'changed')
      const mockEdit = vi.fn()
      const mockSetFocused = vi.fn()

      const roving = makeRovingEditor({
        activeBlockId: 'OTHER_BLOCK',
        unmount: mockUnmount,
      })

      const { result } = renderHook(() =>
        useEditorBlur({
          rovingEditor: roving,
          blockId: 'B1',
          edit: mockEdit,
          splitBlock: vi.fn(),
          setFocused: mockSetFocused,
          discardDraft: vi.fn(),
        }),
      )

      act(() => {
        result.current.handleBlur(makeFocusEvent())
      })

      expect(mockUnmount).not.toHaveBeenCalled()
      expect(mockEdit).not.toHaveBeenCalled()
      expect(mockSetFocused).not.toHaveBeenCalled()
    })

    it('ignores blur when no active block', () => {
      const mockUnmount = vi.fn()
      const mockEdit = vi.fn()
      const mockSetFocused = vi.fn()

      const roving = makeRovingEditor({
        activeBlockId: null,
        unmount: mockUnmount,
      })

      const { result } = renderHook(() =>
        useEditorBlur({
          rovingEditor: roving,
          blockId: 'B1',
          edit: mockEdit,
          splitBlock: vi.fn(),
          setFocused: mockSetFocused,
          discardDraft: vi.fn(),
        }),
      )

      act(() => {
        result.current.handleBlur(makeFocusEvent())
      })

      expect(mockUnmount).not.toHaveBeenCalled()
      expect(mockEdit).not.toHaveBeenCalled()
      expect(mockSetFocused).not.toHaveBeenCalled()
    })
  })

  // ── New block early persist ────────────────────────────────────────

  describe('new block early persist', () => {
    it('saves new block content before portal check', () => {
      const mockGetMarkdown = vi.fn(() => 'typed text')
      const mockUnmount = vi.fn<() => string | null>(() => null)
      const mockEdit = vi.fn()

      const roving = makeRovingEditor({
        activeBlockId: 'B1',
        unmount: mockUnmount,
        getMarkdown: mockGetMarkdown,
        originalMarkdown: '',
      })

      // Add a visible popup to trigger portal guard (early return after persist)
      const popup = document.createElement('div')
      popup.classList.add('suggestion-popup')
      ;(popup as unknown as { checkVisibility: () => boolean }).checkVisibility = () => true
      document.body.appendChild(popup)

      const { result } = renderHook(() =>
        useEditorBlur({
          rovingEditor: roving,
          blockId: 'B1',
          edit: mockEdit,
          splitBlock: vi.fn(),
          setFocused: vi.fn(),
          discardDraft: vi.fn(),
        }),
      )

      act(() => {
        result.current.handleBlur(makeFocusEvent())
      })

      // Early persist should have fired
      expect(mockGetMarkdown).toHaveBeenCalled()
      expect(mockEdit).toHaveBeenCalledWith('B1', 'typed text')
      // But editor stays mounted because portal is visible
      expect(mockUnmount).not.toHaveBeenCalled()
    })

    it('does not early-save when block had existing content', () => {
      const mockGetMarkdown = vi.fn(() => 'updated')
      const mockEdit = vi.fn()

      const roving = makeRovingEditor({
        activeBlockId: 'B1',
        getMarkdown: mockGetMarkdown,
        originalMarkdown: 'original',
      })

      // Add a visible popup to trigger portal guard (early return)
      const popup = document.createElement('div')
      popup.classList.add('suggestion-popup')
      ;(popup as unknown as { checkVisibility: () => boolean }).checkVisibility = () => true
      document.body.appendChild(popup)

      const { result } = renderHook(() =>
        useEditorBlur({
          rovingEditor: roving,
          blockId: 'B1',
          edit: mockEdit,
          splitBlock: vi.fn(),
          setFocused: vi.fn(),
          discardDraft: vi.fn(),
        }),
      )

      act(() => {
        result.current.handleBlur(makeFocusEvent())
      })

      // originalMarkdown is not empty, so early-save guard should NOT fire
      expect(mockGetMarkdown).not.toHaveBeenCalled()
      expect(mockEdit).not.toHaveBeenCalled()
    })
  })

  // ── discardDraft ───────────────────────────────────────────────────

  describe('discardDraft', () => {
    it('calls discardDraft after unmount with changes', () => {
      const mockUnmount = vi.fn(() => 'changed text')
      const mockDiscardDraft = vi.fn()

      const roving = makeRovingEditor({
        activeBlockId: 'B1',
        unmount: mockUnmount,
      })

      const { result } = renderHook(() =>
        useEditorBlur({
          rovingEditor: roving,
          blockId: 'B1',
          edit: vi.fn(),
          splitBlock: vi.fn(),
          setFocused: vi.fn(),
          discardDraft: mockDiscardDraft,
        }),
      )

      act(() => {
        result.current.handleBlur(makeFocusEvent())
      })

      expect(mockDiscardDraft).toHaveBeenCalledOnce()
    })

    it('does not call discardDraft when content is unchanged', () => {
      const mockUnmount = vi.fn<() => string | null>(() => null)
      const mockDiscardDraft = vi.fn()

      const roving = makeRovingEditor({
        activeBlockId: 'B1',
        unmount: mockUnmount,
      })

      const { result } = renderHook(() =>
        useEditorBlur({
          rovingEditor: roving,
          blockId: 'B1',
          edit: vi.fn(),
          splitBlock: vi.fn(),
          setFocused: vi.fn(),
          discardDraft: mockDiscardDraft,
        }),
      )

      act(() => {
        result.current.handleBlur(makeFocusEvent())
      })

      expect(mockDiscardDraft).not.toHaveBeenCalled()
    })
  })

  // ── Call ordering ──────────────────────────────────────────────────

  describe('call ordering', () => {
    it('calls edit before setFocused(null) so store is updated before unmount', () => {
      const callOrder: string[] = []
      const mockEdit = vi.fn(() => callOrder.push('edit'))
      const mockSetFocused = vi.fn(() => callOrder.push('setFocused'))
      const mockUnmount = vi.fn<() => string | null>(() => 'updated text')

      const roving = makeRovingEditor({
        activeBlockId: 'B1',
        unmount: mockUnmount,
      })

      const { result } = renderHook(() =>
        useEditorBlur({
          rovingEditor: roving,
          blockId: 'B1',
          edit: mockEdit,
          splitBlock: vi.fn(),
          setFocused: mockSetFocused,
          discardDraft: vi.fn(),
        }),
      )

      act(() => {
        result.current.handleBlur(makeFocusEvent())
      })

      expect(callOrder).toEqual(['edit', 'setFocused'])
    })

    it('calls splitBlock before setFocused(null) when content has newlines', () => {
      const callOrder: string[] = []
      const mockSplitBlock = vi.fn(() => callOrder.push('splitBlock'))
      const mockSetFocused = vi.fn(() => callOrder.push('setFocused'))
      const mockUnmount = vi.fn(() => 'line1\nline2')

      const roving = makeRovingEditor({
        activeBlockId: 'B1',
        unmount: mockUnmount,
      })

      const { result } = renderHook(() =>
        useEditorBlur({
          rovingEditor: roving,
          blockId: 'B1',
          edit: vi.fn(),
          splitBlock: mockSplitBlock,
          setFocused: mockSetFocused,
          discardDraft: vi.fn(),
        }),
      )

      act(() => {
        result.current.handleBlur(makeFocusEvent())
      })

      expect(callOrder).toEqual(['splitBlock', 'setFocused'])
    })
  })
})
