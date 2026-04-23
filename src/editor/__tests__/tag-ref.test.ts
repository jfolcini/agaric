/**
 * Tests for the TagRef extension.
 */

import { Editor } from '@tiptap/core'
import Document from '@tiptap/extension-document'
import Paragraph from '@tiptap/extension-paragraph'
import Text from '@tiptap/extension-text'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TagRef } from '../extensions/tag-ref'

describe('TagRef', () => {
  it('creates an extension with the correct name', () => {
    const ext = TagRef.configure({})
    expect(ext.name).toBe('tag_ref')
  })

  it('has a default resolveName that truncates the ULID', () => {
    const ext = TagRef.configure({})
    const result = ext.options.resolveName('01ABCDEF1234567890ABCDEF12')
    expect(result).toBe('#01ABCDEF...')
  })

  it('has resolveStatus undefined by default', () => {
    const ext = TagRef.configure({})
    expect(ext.options.resolveStatus).toBeUndefined()
  })

  it('has onClick undefined by default', () => {
    const ext = TagRef.configure({})
    expect(ext.options.onClick).toBeUndefined()
  })

  it('accepts a custom resolveName option', () => {
    const resolveName = (id: string) => `Tag:${id}`
    const ext = TagRef.configure({ resolveName })
    expect(ext.options.resolveName('abc')).toBe('Tag:abc')
  })

  it('accepts a custom resolveStatus option', () => {
    const resolveStatus = () => 'deleted' as const
    const ext = TagRef.configure({ resolveName: (id) => id, resolveStatus })
    expect(ext.options.resolveStatus).toBe(resolveStatus)
  })

  it('accepts a custom onClick option', () => {
    const onClick = () => {}
    const ext = TagRef.configure({ resolveName: (id) => id, onClick })
    expect(ext.options.onClick).toBe(onClick)
  })
})

describe('TagRef Backspace re-expand (H-14)', () => {
  it('registers Backspace keyboard shortcut', () => {
    const ext = TagRef.configure({
      resolveName: (id) => `Name:${id}`,
    })
    expect(ext.config.addKeyboardShortcuts).toBeDefined()
  })

  it('uses resolveName to get the display name for re-expansion', () => {
    const resolveName = (_id: string) => `My Tag Name`
    const ext = TagRef.configure({ resolveName })
    // Verify the option is available (keyboard shortcut uses it internally)
    expect(ext.options.resolveName('any-id')).toBe('My Tag Name')
  })
})

// -- TagRef NodeView click behaviour (UX-249) --------------------------------

describe('TagRef NodeView click activation (UX-249)', () => {
  let editor: Editor

  afterEach(() => {
    editor?.destroy()
  })

  function createEditor(options: {
    onClick?: (id: string) => void
    content?: Record<string, unknown>
  }): Editor {
    return new Editor({
      element: document.createElement('div'),
      extensions: [
        Document,
        Paragraph,
        Text,
        TagRef.configure({
          resolveName: (id: string) => `#${id}`,
          ...(options.onClick ? { onClick: options.onClick } : {}),
        }),
      ],
      content: options.content ?? {
        type: 'doc',
        content: [{ type: 'paragraph' }],
      },
    })
  }

  it('click on the NodeView dom fires onClick with the current tag id', () => {
    const onClick = vi.fn()
    editor = createEditor({
      onClick,
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

    const chip = editor.view.dom.querySelector('[data-type="tag-ref"]') as HTMLElement
    expect(chip).not.toBeNull()
    chip.click()
    expect(onClick).toHaveBeenCalledTimes(1)
    expect(onClick).toHaveBeenCalledWith('TAG001')
  })

  it('Enter keydown on the chip fires onClick', () => {
    const onClick = vi.fn()
    editor = createEditor({
      onClick,
      content: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'tag_ref', attrs: { id: 'ENTERTAG' } }],
          },
        ],
      },
    })

    const chip = editor.view.dom.querySelector('[data-type="tag-ref"]') as HTMLElement
    chip.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(onClick).toHaveBeenCalledTimes(1)
    expect(onClick).toHaveBeenCalledWith('ENTERTAG')
  })

  it('Space keydown on the chip fires onClick', () => {
    const onClick = vi.fn()
    editor = createEditor({
      onClick,
      content: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'tag_ref', attrs: { id: 'SPACETAG' } }],
          },
        ],
      },
    })

    const chip = editor.view.dom.querySelector('[data-type="tag-ref"]') as HTMLElement
    chip.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }))
    expect(onClick).toHaveBeenCalledTimes(1)
    expect(onClick).toHaveBeenCalledWith('SPACETAG')
  })

  it('other keys do not fire onClick', () => {
    const onClick = vi.fn()
    editor = createEditor({
      onClick,
      content: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'tag_ref', attrs: { id: 'KEYTAG' } }],
          },
        ],
      },
    })

    const chip = editor.view.dom.querySelector('[data-type="tag-ref"]') as HTMLElement
    chip.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }))
    chip.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(onClick).not.toHaveBeenCalled()
  })

  it('sets role=link and tabIndex=0 when onClick is provided', () => {
    editor = createEditor({
      onClick: () => {},
      content: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'tag_ref', attrs: { id: 'ROLETAG' } }],
          },
        ],
      },
    })

    const chip = editor.view.dom.querySelector('[data-type="tag-ref"]') as HTMLElement
    expect(chip.getAttribute('role')).toBe('link')
    expect(chip.getAttribute('tabindex')).toBe('0')
  })

  it('does NOT set role/tabIndex when onClick is absent (plain decoration)', () => {
    editor = createEditor({
      content: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'tag_ref', attrs: { id: 'PLAINTAG' } }],
          },
        ],
      },
    })

    const chip = editor.view.dom.querySelector('[data-type="tag-ref"]') as HTMLElement
    expect(chip.getAttribute('role')).toBeNull()
    expect(chip.getAttribute('tabindex')).toBeNull()
  })

  it('click is a no-op when onClick is undefined (chip stays inert)', () => {
    editor = createEditor({
      content: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'tag_ref', attrs: { id: 'INERT' } }],
          },
        ],
      },
    })

    const chip = editor.view.dom.querySelector('[data-type="tag-ref"]') as HTMLElement
    // Should not throw.
    expect(() => chip.click()).not.toThrow()
  })

  it('click after node id update uses the new id', () => {
    const onClick = vi.fn()
    editor = createEditor({
      onClick,
      content: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'tag_ref', attrs: { id: 'FIRSTID' } }],
          },
        ],
      },
    })

    // Update attrs to a new ID so NodeView.update() runs render() with the
    // new id — verifying that the outer-closure listener still picks up the
    // current id on subsequent clicks.
    let nodePos = -1
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name === 'tag_ref') {
        nodePos = pos
        return false
      }
      return undefined
    })
    const { tr } = editor.state
    tr.setNodeMarkup(nodePos, undefined, { id: 'SECONDID' })
    editor.view.dispatch(tr)

    const chip = editor.view.dom.querySelector('[data-type="tag-ref"]') as HTMLElement
    chip.click()
    expect(onClick).toHaveBeenCalledWith('SECONDID')
  })

  it('click still works after an attrs update — click handler survives re-render', () => {
    const onClick = vi.fn()
    editor = createEditor({
      onClick,
      content: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'tag_ref', attrs: { id: 'SURVIVOR1' } }],
          },
        ],
      },
    })

    let chip = editor.view.dom.querySelector('[data-type="tag-ref"]') as HTMLElement
    chip.click()
    expect(onClick).toHaveBeenCalledTimes(1)

    // Trigger a NodeView.update() by changing attrs — this exercises the
    // "listeners registered ONCE in outer closure, not inside render()"
    // invariant. Without that guarantee the handler count would grow and/or
    // go stale.
    let nodePos = -1
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name === 'tag_ref') {
        nodePos = pos
        return false
      }
      return undefined
    })
    const { tr } = editor.state
    tr.setNodeMarkup(nodePos, undefined, { id: 'SURVIVOR2' })
    editor.view.dispatch(tr)

    chip = editor.view.dom.querySelector('[data-type="tag-ref"]') as HTMLElement
    chip.click()
    expect(onClick).toHaveBeenCalledTimes(2)
    expect(onClick).toHaveBeenLastCalledWith('SURVIVOR2')
  })

  it('destroy() removes the listener so a later click is ignored', () => {
    const onClick = vi.fn()
    editor = createEditor({
      onClick,
      content: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'tag_ref', attrs: { id: 'DESTROYED' } }],
          },
        ],
      },
    })

    const chip = editor.view.dom.querySelector('[data-type="tag-ref"]') as HTMLElement
    chip.click()
    expect(onClick).toHaveBeenCalledTimes(1)

    editor.destroy()
    onClick.mockClear()
    chip.click()
    expect(onClick).not.toHaveBeenCalled()
  })
})
