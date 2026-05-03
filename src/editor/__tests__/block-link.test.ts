/**
 * Tests for the BlockLink extension.
 */

import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BlockLink } from '../extensions/block-link'

describe('BlockLink', () => {
  it('creates an extension with the correct name', () => {
    const ext = BlockLink.configure({})
    expect(ext.name).toBe('block_link')
  })

  it('has a default resolveTitle that truncates the ULID', () => {
    const ext = BlockLink.configure({})
    const result = ext.options.resolveTitle('01ABCDEF1234567890ABCDEF12')
    expect(result).toBe('[[01ABCDEF...]]')
  })

  it('has onNavigate undefined by default', () => {
    const ext = BlockLink.configure({})
    expect(ext.options.onNavigate).toBeUndefined()
  })

  it('has resolveStatus undefined by default', () => {
    const ext = BlockLink.configure({})
    expect(ext.options.resolveStatus).toBeUndefined()
  })

  it('accepts a custom resolveTitle option', () => {
    const resolveTitle = (id: string) => `Page:${id}`
    const ext = BlockLink.configure({ resolveTitle })
    expect(ext.options.resolveTitle('abc')).toBe('Page:abc')
  })

  it('accepts a custom onNavigate option', () => {
    const onNavigate = (_id: string) => {}
    const ext = BlockLink.configure({ resolveTitle: (id) => id, onNavigate })
    expect(ext.options.onNavigate).toBe(onNavigate)
  })
})

describe('BlockLink Backspace re-expand (H-14)', () => {
  it('registers Backspace keyboard shortcut', () => {
    const ext = BlockLink.configure({
      resolveTitle: (id) => `Title:${id}`,
    })
    expect(ext.config.addKeyboardShortcuts).toBeDefined()
  })

  it('uses resolveTitle to get the display name for re-expansion', () => {
    const resolveTitle = (_id: string) => `My Page Title`
    const ext = BlockLink.configure({ resolveTitle })
    // Verify the option is available (keyboard shortcut uses it internally)
    expect(ext.options.resolveTitle('any-id')).toBe('My Page Title')
  })
})

describe('BlockLink broken link recovery (UX-25)', () => {
  /** Helper: invoke the NodeView factory and return the DOM + view object. */
  function createNodeView(options: {
    id: string
    resolveStatus?: (id: string) => 'active' | 'deleted'
    editor?: unknown
    getPos?: () => number
  }) {
    const ext = BlockLink.configure({
      resolveTitle: (id) => `Title:${id}`,
      resolveStatus: options.resolveStatus,
    })

    // The addNodeView config is a function that returns the NodeView factory.
    // biome-ignore lint/complexity/noBannedTypes: test needs dynamic call on TipTap extension config
    const factory = (ext.config.addNodeView as Function)?.call(ext)
    const fakeNode = { type: { name: 'block_link' }, attrs: { id: options.id }, nodeSize: 1 }
    // biome-ignore lint/complexity/noBannedTypes: test needs dynamic call on TipTap NodeView factory
    const view = (factory as Function)({
      node: fakeNode,
      editor: options.editor ?? {},
      getPos: options.getPos ?? (() => 0),
    })
    return { dom: view.dom as HTMLSpanElement, view }
  }

  it('renders broken link with title tooltip', () => {
    const { dom } = createNodeView({
      id: 'DELETED01',
      resolveStatus: () => 'deleted',
    })

    expect(dom.getAttribute('title')).toBe('Broken link or in another space — click to remove')
    expect(dom.classList.contains('block-link-deleted')).toBe(true)
  })

  it('does not set title tooltip on active links', () => {
    const { dom } = createNodeView({
      id: 'ACTIVE01',
      resolveStatus: () => 'active',
    })

    expect(dom.getAttribute('title')).toBeNull()
    expect(dom.classList.contains('block-link-deleted')).toBe(false)
  })

  it('clicking broken link chip calls deleteRange', () => {
    const runFn = vi.fn()
    const deleteRangeFn = vi.fn(() => ({ run: runFn }))
    const focusFn = vi.fn(() => ({ deleteRange: deleteRangeFn }))
    const chainFn = vi.fn(() => ({ focus: focusFn }))
    const mockEditor = { chain: chainFn }

    const pos = 5
    const { dom } = createNodeView({
      id: 'DELETED02',
      resolveStatus: () => 'deleted',
      editor: mockEditor,
      getPos: () => pos,
    })

    dom.click()

    expect(chainFn).toHaveBeenCalled()
    expect(focusFn).toHaveBeenCalled()
    expect(deleteRangeFn).toHaveBeenCalledWith({ from: pos, to: pos + 1 })
    expect(runFn).toHaveBeenCalled()
  })
})

describe('BlockLink broken link a11y + toast feedback (UX-313)', () => {
  /** Helper duplicated from the UX-25 block above (same shape, isolated scope). */
  function createNodeView(options: {
    id: string
    resolveStatus?: (id: string) => 'active' | 'deleted'
    editor?: unknown
    getPos?: () => number
  }) {
    const ext = BlockLink.configure({
      resolveTitle: (id) => `Title:${id}`,
      resolveStatus: options.resolveStatus,
    })
    // biome-ignore lint/complexity/noBannedTypes: test needs dynamic call on TipTap extension config
    const factory = (ext.config.addNodeView as Function)?.call(ext)
    const fakeNode = { type: { name: 'block_link' }, attrs: { id: options.id }, nodeSize: 1 }
    // biome-ignore lint/complexity/noBannedTypes: test needs dynamic call on TipTap NodeView factory
    const view = (factory as Function)({
      node: fakeNode,
      editor: options.editor ?? {},
      getPos: options.getPos ?? (() => 0),
    })
    return { dom: view.dom as HTMLSpanElement, view }
  }

  beforeEach(() => {
    vi.mocked(toast.success).mockClear()
  })

  it('broken link chip exposes the i18n tooltip via both title and aria-label', () => {
    const { dom } = createNodeView({
      id: 'DELETED03',
      resolveStatus: () => 'deleted',
    })

    expect(dom.getAttribute('title')).toBe('Broken link or in another space — click to remove')
    expect(dom.getAttribute('aria-label')).toBe('Broken link or in another space — click to remove')
  })

  it('clicking a broken link chip fires toast.success with the i18n message', () => {
    const runFn = vi.fn()
    const deleteRangeFn = vi.fn(() => ({ run: runFn }))
    const focusFn = vi.fn(() => ({ deleteRange: deleteRangeFn }))
    const chainFn = vi.fn(() => ({ focus: focusFn }))
    const mockEditor = { chain: chainFn }

    const { dom } = createNodeView({
      id: 'DELETED04',
      resolveStatus: () => 'deleted',
      editor: mockEditor,
      getPos: () => 7,
    })

    dom.click()

    expect(runFn).toHaveBeenCalled()
    expect(vi.mocked(toast.success)).toHaveBeenCalledWith('Broken link removed (undo with Ctrl+Z)')
  })
})
