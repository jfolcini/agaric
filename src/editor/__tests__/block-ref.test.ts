/**
 * Tests for the BlockRef extension.
 */

import { describe, expect, it, vi } from 'vitest'
import { BlockRef } from '../extensions/block-ref'

describe('BlockRef', () => {
  it('creates an extension with the correct name', () => {
    const ext = BlockRef.configure({})
    expect(ext.name).toBe('block_ref')
  })

  it('has a default resolveContent that truncates the ULID', () => {
    const ext = BlockRef.configure({})
    const result = ext.options.resolveContent('01ABCDEF1234567890ABCDEF12')
    expect(result).toBe('(( 01ABCDEF... ))')
  })

  it('has onNavigate undefined by default', () => {
    const ext = BlockRef.configure({})
    expect(ext.options.onNavigate).toBeUndefined()
  })

  it('has resolveStatus undefined by default', () => {
    const ext = BlockRef.configure({})
    expect(ext.options.resolveStatus).toBeUndefined()
  })

  it('accepts a custom resolveContent option', () => {
    const resolveContent = (id: string) => `Content:${id}`
    const ext = BlockRef.configure({ resolveContent })
    expect(ext.options.resolveContent('abc')).toBe('Content:abc')
  })

  it('accepts a custom onNavigate option', () => {
    const onNavigate = (_id: string) => {}
    const ext = BlockRef.configure({ resolveContent: (id) => id, onNavigate })
    expect(ext.options.onNavigate).toBe(onNavigate)
  })
})

describe('BlockRef NodeView', () => {
  /** Helper: invoke the NodeView factory and return the DOM + view object. */
  function createNodeView(options: {
    id: string
    resolveStatus?: (id: string) => 'active' | 'deleted'
    onNavigate?: (id: string) => void
  }) {
    const ext = BlockRef.configure({
      resolveContent: (id) => `Content:${id}`,
      resolveStatus: options.resolveStatus,
      onNavigate: options.onNavigate,
    })

    // The addNodeView config is a function that returns the NodeView factory.
    const factory = (ext.config.addNodeView as (...args: unknown[]) => unknown)?.call(ext)
    const fakeNode = { type: { name: 'block_ref' }, attrs: { id: options.id } }
    const view = (factory as (...args: unknown[]) => { dom: unknown })({ node: fakeNode })
    return { dom: view.dom as HTMLSpanElement, view }
  }
  it('active ref has no deleted class', () => {
    const { dom } = createNodeView({
      id: 'ACTIVE01',
      resolveStatus: () => 'active',
    })

    expect(dom.classList.contains('block-ref-deleted')).toBe(false)
  })

  it('clicking active ref calls onNavigate', () => {
    const onNavigate = vi.fn()
    const { dom } = createNodeView({
      id: 'ACTIVE02',
      resolveStatus: () => 'active',
      onNavigate,
    })

    dom.click()

    expect(onNavigate).toHaveBeenCalledWith('ACTIVE02')
  })
})
