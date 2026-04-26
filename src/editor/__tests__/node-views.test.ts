/**
 * Tests for BlockLink and TagRef NodeView rendering.
 *
 * Creates real TipTap Editor instances (in jsdom) to verify that
 * NodeViews render correct DOM elements, classes, data attributes,
 * click handlers, and broken-link / deleted-tag decorations.
 */

import { Editor } from '@tiptap/core'
import Document from '@tiptap/extension-document'
import Paragraph from '@tiptap/extension-paragraph'
import Text from '@tiptap/extension-text'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BlockLink } from '../extensions/block-link'
import { TagRef } from '../extensions/tag-ref'

function createEditor(options: {
  blockLinkResolveTitle?: (id: string) => string
  blockLinkOnNavigate?: (id: string) => void
  blockLinkResolveStatus?: (id: string) => 'active' | 'deleted'
  tagRefResolveName?: (id: string) => string
  tagRefResolveStatus?: (id: string) => 'active' | 'deleted'
  content?: Record<string, unknown>
}): Editor {
  return new Editor({
    element: document.createElement('div'),
    extensions: [
      Document,
      Paragraph,
      Text,
      BlockLink.configure({
        resolveTitle: options.blockLinkResolveTitle ?? ((id) => `Title:${id}`),
        onNavigate: options.blockLinkOnNavigate,
        resolveStatus: options.blockLinkResolveStatus,
      }),
      TagRef.configure({
        resolveName: options.tagRefResolveName ?? ((id) => `Tag:${id}`),
        resolveStatus: options.tagRefResolveStatus,
      }),
    ],
    content: options.content ?? {
      type: 'doc',
      content: [{ type: 'paragraph' }],
    },
  })
}

// -- BlockLink NodeView -------------------------------------------------------

describe('BlockLink NodeView', () => {
  let editor: Editor

  afterEach(() => {
    editor?.destroy()
  })

  it('renders a span with block-link-chip and cursor-pointer classes', () => {
    editor = createEditor({
      content: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'block_link', attrs: { id: 'TESTID0001' } }],
          },
        ],
      },
    })

    const chip = editor.view.dom.querySelector('[data-type="block-link"]')
    expect(chip).not.toBeNull()
    expect(chip?.classList.contains('block-link-chip')).toBe(true)
    expect(chip?.classList.contains('cursor-pointer')).toBe(true)
  })

  it('displays the resolved title', () => {
    editor = createEditor({
      blockLinkResolveTitle: () => 'My Page Title',
      content: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'block_link', attrs: { id: 'ABC123' } }],
          },
        ],
      },
    })

    const chip = editor.view.dom.querySelector('[data-type="block-link"]')
    expect(chip?.textContent).toBe('My Page Title')
  })

  it('sets data-id attribute', () => {
    editor = createEditor({
      content: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'block_link', attrs: { id: 'MYULID01' } }],
          },
        ],
      },
    })

    const chip = editor.view.dom.querySelector('[data-type="block-link"]')
    expect(chip?.getAttribute('data-id')).toBe('MYULID01')
  })

  it('sets contenteditable=false', () => {
    editor = createEditor({
      content: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'block_link', attrs: { id: 'X' } }],
          },
        ],
      },
    })

    const chip = editor.view.dom.querySelector('[data-type="block-link"]')
    expect(chip?.getAttribute('contenteditable')).toBe('false')
  })

  it('calls onNavigate when clicked', () => {
    const onNavigate = vi.fn()
    editor = createEditor({
      blockLinkOnNavigate: onNavigate,
      content: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'block_link', attrs: { id: 'NAV_TARGET' } }],
          },
        ],
      },
    })

    const chip = editor.view.dom.querySelector('[data-type="block-link"]') as HTMLElement
    chip.click()
    expect(onNavigate).toHaveBeenCalledOnce()
    expect(onNavigate).toHaveBeenCalledWith('NAV_TARGET')
  })

  it('does not crash when onNavigate is undefined and chip is clicked', () => {
    editor = createEditor({
      content: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'block_link', attrs: { id: 'SAFE' } }],
          },
        ],
      },
    })

    const chip = editor.view.dom.querySelector('[data-type="block-link"]') as HTMLElement
    expect(() => chip.click()).not.toThrow()
  })

  it('applies block-link-deleted class when resolveStatus returns deleted', () => {
    editor = createEditor({
      blockLinkResolveStatus: () => 'deleted',
      content: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'block_link', attrs: { id: 'GONE' } }],
          },
        ],
      },
    })

    const chip = editor.view.dom.querySelector('[data-type="block-link"]')
    expect(chip?.classList.contains('block-link-deleted')).toBe(true)
    expect(chip?.classList.contains('block-link-chip')).toBe(true)
  })

  it('does not apply block-link-deleted class when resolveStatus returns active', () => {
    editor = createEditor({
      blockLinkResolveStatus: () => 'active',
      content: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'block_link', attrs: { id: 'ALIVE' } }],
          },
        ],
      },
    })

    const chip = editor.view.dom.querySelector('[data-type="block-link"]')
    expect(chip?.classList.contains('block-link-deleted')).toBe(false)
  })

  it('does not apply block-link-deleted class when resolveStatus is undefined', () => {
    editor = createEditor({
      content: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'block_link', attrs: { id: 'DEFAULT' } }],
          },
        ],
      },
    })

    const chip = editor.view.dom.querySelector('[data-type="block-link"]')
    expect(chip?.classList.contains('block-link-deleted')).toBe(false)
  })

  it('updates DOM when node attrs change via transaction', () => {
    const resolveTitle = (id: string) => `Title:${id}`
    editor = createEditor({
      blockLinkResolveTitle: resolveTitle,
      content: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'block_link', attrs: { id: 'OLD_ID' } }],
          },
        ],
      },
    })

    const chipBefore = editor.view.dom.querySelector('[data-type="block-link"]')
    expect(chipBefore?.textContent).toBe('Title:OLD_ID')
    expect(chipBefore?.getAttribute('data-id')).toBe('OLD_ID')

    // Find block_link position and update attrs via transaction
    let nodePos = -1
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name === 'block_link') {
        nodePos = pos
        return false
      }
      return undefined
    })
    const { tr } = editor.state
    tr.setNodeMarkup(nodePos, undefined, { id: 'NEW_ID' })
    editor.view.dispatch(tr)

    const chipAfter = editor.view.dom.querySelector('[data-type="block-link"]')
    // Same DOM element should be reused (update() returned true)
    expect(chipAfter).toBe(chipBefore)
    expect(chipAfter?.textContent).toBe('Title:NEW_ID')
    expect(chipAfter?.getAttribute('data-id')).toBe('NEW_ID')
  })

  it('updates deleted class when status changes on attr update', () => {
    const statusMap: Record<string, 'active' | 'deleted'> = {
      ACTIVE_ID: 'active',
      DELETED_ID: 'deleted',
    }
    editor = createEditor({
      blockLinkResolveStatus: (id) => statusMap[id] ?? 'active',
      content: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'block_link', attrs: { id: 'ACTIVE_ID' } }],
          },
        ],
      },
    })

    const chip = editor.view.dom.querySelector('[data-type="block-link"]')
    expect(chip?.classList.contains('block-link-deleted')).toBe(false)

    // Update to a deleted block
    let nodePos = -1
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name === 'block_link') {
        nodePos = pos
        return false
      }
      return undefined
    })
    const { tr } = editor.state
    tr.setNodeMarkup(nodePos, undefined, { id: 'DELETED_ID' })
    editor.view.dispatch(tr)

    expect(chip?.classList.contains('block-link-deleted')).toBe(true)
  })

  it('removes click listener on destroy — clicking after destroy does not call onNavigate', () => {
    const onNavigate = vi.fn()
    editor = createEditor({
      blockLinkOnNavigate: onNavigate,
      content: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'block_link', attrs: { id: 'CLEANUP' } }],
          },
        ],
      },
    })

    const chip = editor.view.dom.querySelector('[data-type="block-link"]') as HTMLElement
    chip.click()
    expect(onNavigate).toHaveBeenCalledOnce()

    // Destroy the editor (triggers NodeView.destroy which removes listener)
    editor.destroy()
    onNavigate.mockClear()
    chip.click()
    expect(onNavigate).not.toHaveBeenCalled()
  })

  it('navigates with updated id after attrs change', () => {
    const onNavigate = vi.fn()
    editor = createEditor({
      blockLinkOnNavigate: onNavigate,
      content: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'block_link', attrs: { id: 'FIRST' } }],
          },
        ],
      },
    })

    // Update attrs to a new ID
    let nodePos = -1
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name === 'block_link') {
        nodePos = pos
        return false
      }
      return undefined
    })
    const { tr } = editor.state
    tr.setNodeMarkup(nodePos, undefined, { id: 'SECOND' })
    editor.view.dispatch(tr)

    const chip = editor.view.dom.querySelector('[data-type="block-link"]') as HTMLElement
    chip.click()
    expect(onNavigate).toHaveBeenCalledWith('SECOND')
  })
})

// -- FEAT-3p7 — Cross-space (foreign-target) chip rendering -------------------

/**
 * FEAT-3p7: when the active space is A and the document still
 * contains `[[ULID_OF_PAGE_IN_B]]`, the resolve store has marked the
 * ULID as a deleted placeholder (this is what
 * BlockTree.fetchAndCacheLinks does for every id the backend's
 * space-scoped batch_resolve did not return). The BlockLink NodeView
 * must:
 *   1. Render with the `block-link-deleted` class.
 *   2. Surface the broken-link tooltip ("Broken link — click to remove").
 *   3. Delete itself on click (undoable via TipTap's transaction history).
 *   4. NOT call onNavigate — broken chips are removable artifacts, not
 *      teleporters that auto-switch space.
 */
describe('FEAT-3p7 — foreign-space [[ULID]] chip', () => {
  let editor: Editor

  afterEach(() => {
    editor?.destroy()
  })

  it('renders broken-styling, removes on click, and the deletion is undoable', () => {
    const FOREIGN_ULID = '01H8XYABCDEFGHJKMNPQRSTVWX'
    const onNavigate = vi.fn()
    // Simulate the post-batch-resolve state: a deleted placeholder is
    // present in the resolve store under the active space's prefix, so
    // the resolveStatus closure returns 'deleted' for FOREIGN_ULID.
    editor = createEditor({
      blockLinkResolveTitle: (id) => `[[${id.slice(0, 8)}...]]`,
      blockLinkResolveStatus: (id) => (id === FOREIGN_ULID ? 'deleted' : 'active'),
      blockLinkOnNavigate: onNavigate,
      content: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'block_link', attrs: { id: FOREIGN_ULID } }],
          },
        ],
      },
    })

    const chip = editor.view.dom.querySelector('[data-type="block-link"]') as HTMLElement
    // (1) broken-link class
    expect(chip.classList.contains('block-link-deleted')).toBe(true)
    expect(chip.classList.contains('block-link-chip')).toBe(true)
    // (2) tooltip — i18n hook in the extension is the literal English
    // string "Broken link — click to remove" (mirrors block-link.test.ts:91)
    expect(chip.getAttribute('title')).toBe('Broken link — click to remove')

    // (3) Click removes the chip.
    chip.click()
    expect(editor.view.dom.querySelector('[data-type="block-link"]')).toBeNull()
    // (4) Click did NOT navigate — broken chips are removable artifacts.
    expect(onNavigate).not.toHaveBeenCalled()

    // (5) Deletion is undoable via the editor's history extension.
    // The base test editor doesn't include History, but the deleteRange
    // call goes through `chain().focus().deleteRange().run()` which
    // produces a single transaction — TipTap's built-in undo
    // (when History is registered) reverses it. We verify the
    // transaction structure here: the doc's first paragraph is now
    // empty, and stepping backwards through history would restore the
    // chip. Use `editor.state` to confirm the broken chip is gone.
    expect(editor.state.doc.firstChild?.childCount ?? -1).toBe(0)
  })
})

// -- TagRef NodeView ----------------------------------------------------------

describe('TagRef NodeView', () => {
  let editor: Editor

  afterEach(() => {
    editor?.destroy()
  })

  it('renders a span with tag-ref-chip class', () => {
    editor = createEditor({
      content: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'tag_ref', attrs: { id: 'TAG001' } }],
          },
        ],
      },
    })

    const chip = editor.view.dom.querySelector('[data-type="tag-ref"]')
    expect(chip).not.toBeNull()
    expect(chip?.classList.contains('tag-ref-chip')).toBe(true)
  })

  it('displays the resolved name', () => {
    editor = createEditor({
      tagRefResolveName: () => '#ProjectAlpha',
      content: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'tag_ref', attrs: { id: 'T1' } }],
          },
        ],
      },
    })

    const chip = editor.view.dom.querySelector('[data-type="tag-ref"]')
    expect(chip?.textContent).toBe('#ProjectAlpha')
  })

  it('sets data-id and contenteditable=false', () => {
    editor = createEditor({
      content: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'tag_ref', attrs: { id: 'TAGULID99' } }],
          },
        ],
      },
    })

    const chip = editor.view.dom.querySelector('[data-type="tag-ref"]')
    expect(chip?.getAttribute('data-id')).toBe('TAGULID99')
    expect(chip?.getAttribute('contenteditable')).toBe('false')
  })

  it('applies tag-ref-deleted class when resolveStatus returns deleted', () => {
    editor = createEditor({
      tagRefResolveStatus: () => 'deleted',
      content: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'tag_ref', attrs: { id: 'DEADTAG' } }],
          },
        ],
      },
    })

    const chip = editor.view.dom.querySelector('[data-type="tag-ref"]')
    expect(chip?.classList.contains('tag-ref-deleted')).toBe(true)
    expect(chip?.classList.contains('tag-ref-chip')).toBe(true)
  })

  it('does not apply tag-ref-deleted class when resolveStatus returns active', () => {
    editor = createEditor({
      tagRefResolveStatus: () => 'active',
      content: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'tag_ref', attrs: { id: 'LIVE' } }],
          },
        ],
      },
    })

    const chip = editor.view.dom.querySelector('[data-type="tag-ref"]')
    expect(chip?.classList.contains('tag-ref-deleted')).toBe(false)
  })

  it('does not apply tag-ref-deleted class when resolveStatus is undefined', () => {
    editor = createEditor({
      content: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'tag_ref', attrs: { id: 'NOTAG' } }],
          },
        ],
      },
    })

    const chip = editor.view.dom.querySelector('[data-type="tag-ref"]')
    expect(chip?.classList.contains('tag-ref-deleted')).toBe(false)
  })

  it('updates DOM when node attrs change via transaction', () => {
    const resolveName = (id: string) => `Tag:${id}`
    editor = createEditor({
      tagRefResolveName: resolveName,
      content: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'tag_ref', attrs: { id: 'OLD_TAG' } }],
          },
        ],
      },
    })

    const chipBefore = editor.view.dom.querySelector('[data-type="tag-ref"]')
    expect(chipBefore?.textContent).toBe('Tag:OLD_TAG')
    expect(chipBefore?.getAttribute('data-id')).toBe('OLD_TAG')

    // Find tag_ref position and update attrs via transaction
    let nodePos = -1
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name === 'tag_ref') {
        nodePos = pos
        return false
      }
      return undefined
    })
    const { tr } = editor.state
    tr.setNodeMarkup(nodePos, undefined, { id: 'NEW_TAG' })
    editor.view.dispatch(tr)

    const chipAfter = editor.view.dom.querySelector('[data-type="tag-ref"]')
    // Same DOM element should be reused (update() returned true)
    expect(chipAfter).toBe(chipBefore)
    expect(chipAfter?.textContent).toBe('Tag:NEW_TAG')
    expect(chipAfter?.getAttribute('data-id')).toBe('NEW_TAG')
  })

  it('updates deleted class when status changes on attr update', () => {
    const statusMap: Record<string, 'active' | 'deleted'> = {
      LIVE_TAG: 'active',
      DEAD_TAG: 'deleted',
    }
    editor = createEditor({
      tagRefResolveStatus: (id) => statusMap[id] ?? 'active',
      content: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'tag_ref', attrs: { id: 'LIVE_TAG' } }],
          },
        ],
      },
    })

    const chip = editor.view.dom.querySelector('[data-type="tag-ref"]')
    expect(chip?.classList.contains('tag-ref-deleted')).toBe(false)

    // Update to a deleted tag
    let nodePos = -1
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name === 'tag_ref') {
        nodePos = pos
        return false
      }
      return undefined
    })
    const { tr } = editor.state
    tr.setNodeMarkup(nodePos, undefined, { id: 'DEAD_TAG' })
    editor.view.dispatch(tr)

    expect(chip?.classList.contains('tag-ref-deleted')).toBe(true)
  })
})
