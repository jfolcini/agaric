/**
 * Tests for the BlockRef extension.
 */

import { Editor } from '@tiptap/core'
import Document from '@tiptap/extension-document'
import Paragraph from '@tiptap/extension-paragraph'
import Text from '@tiptap/extension-text'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { BlockRef } from '@/editor/extensions/block-ref'
import { normalizeBlockRefTitle } from '@/lib/block-title'
import { t } from '@/lib/i18n'

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

// ── #4228 — production Editor mount, resolve-store title contract ──────────
//
// `resolveContent` is wired (in `use-roving-editor.ts`, production code) to
// the same resolve-store title `renderBlockRef` reads, which is normalised
// ONCE at the seed (`normalizeBlockRefTitle`, `@/lib/block-title`) — first
// line only, capped, Untitled-substituted. The NodeView renders whatever
// `resolveContent` returns verbatim (`dom.textContent = content`, no local
// split/cap), so these tests exercise it exactly the way production wires
// it: `resolveContent` given raw, possibly multi-line/newline-leading
// content, normalised the same way the real seed normalises it. Uses a
// real mounted `Editor` (mirrors `block-link.test.ts`'s `BlockLink
// NodeView` suite) rather than `createNodeView` above, since the id-attr
// update path is easiest to exercise through `setContent`.

function createEditor(options: {
  resolveContent?: (id: string) => string
  onNavigate?: (id: string) => void
  content?: Record<string, unknown>
}): Editor {
  return new Editor({
    element: document.createElement('div'),
    extensions: [
      Document,
      Paragraph,
      Text,
      BlockRef.configure({
        resolveContent: options.resolveContent ?? ((id) => `Content:${id}`),
        onNavigate: options.onNavigate,
      }),
    ],
    content: options.content ?? { type: 'doc', content: [{ type: 'paragraph' }] },
  })
}

function docWithRef(id: string): Record<string, unknown> {
  return {
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'block_ref', attrs: { id } }] }],
  }
}

describe('BlockRef NodeView — mounted Editor, resolve-store title contract (#4228)', () => {
  let editor: Editor

  afterEach(() => {
    editor?.destroy()
  })

  it('renders a span with block-ref-chip and cursor-pointer classes', () => {
    editor = createEditor({ content: docWithRef('TESTID0001') })

    const chip = editor.view.dom.querySelector('[data-type="block-ref"]')
    expect(chip).not.toBeNull()
    expect(chip?.classList.contains('block-ref-chip')).toBe(true)
    expect(chip?.classList.contains('cursor-pointer')).toBe(true)
  })

  // #4228 criterion 1 — a block whose content begins with "\n" must render
  // a NON-BLANK chip. `resolveContent` here is wired exactly the way
  // production wires it: to the same normalisation the resolve-store seed
  // applies, given the raw content.
  it('renders a NON-BLANK chip for newline-leading content (empty first line)', () => {
    editor = createEditor({
      resolveContent: () => normalizeBlockRefTitle('\nreal text'),
      content: docWithRef('NL0001'),
    })

    const chip = editor.view.dom.querySelector('[data-type="block-ref"]')
    expect(chip?.textContent).not.toBe('')
    expect(chip?.textContent).toBe(t('block.untitled'))
  })

  // Symmetric pair — a fix that always shows the placeholder is not a fix.
  it('renders the real title verbatim for a genuinely-titled block', () => {
    editor = createEditor({
      resolveContent: () => normalizeBlockRefTitle('real title'),
      content: docWithRef('RT0001'),
    })

    const chip = editor.view.dom.querySelector('[data-type="block-ref"]')
    expect(chip?.textContent).toBe('real title')
  })

  // #4228 criterion 3 — multi-line content renders a BOUNDED chip: only the
  // first line, never the raw multi-line content the pre-#4228 NodeView
  // assigned verbatim (its own docblock claimed first-line-only, but the
  // code never enforced it).
  it('renders only the first line for multi-line content, not the raw multi-line content', () => {
    const rawContent = 'first line\nsecond line\nthird line'
    editor = createEditor({
      resolveContent: () => normalizeBlockRefTitle(rawContent),
      content: docWithRef('ML0001'),
    })

    const chip = editor.view.dom.querySelector('[data-type="block-ref"]')
    expect(chip?.textContent).toBe('first line')
    expect(chip?.textContent).not.toContain('\n')
    expect(chip?.textContent).not.toContain('second line')
    expect(chip?.textContent).not.toContain('third line')
  })

  it('caps a long first line to 60 chars (57 + ellipsis), matching the seed', () => {
    const longFirstLine = 'x'.repeat(120)
    editor = createEditor({
      resolveContent: () => normalizeBlockRefTitle(longFirstLine),
      content: docWithRef('LONG0001'),
    })

    const chip = editor.view.dom.querySelector('[data-type="block-ref"]')
    expect(chip?.textContent).toBe(`${'x'.repeat(57)}...`)
    expect(chip?.textContent?.length).toBe(60)
  })

  it('sets data-id, data-testid, and contenteditable=false', () => {
    editor = createEditor({ content: docWithRef('ATTRS0001') })
    const chip = editor.view.dom.querySelector('[data-type="block-ref"]')
    expect(chip?.getAttribute('data-id')).toBe('ATTRS0001')
    expect(chip?.getAttribute('data-testid')).toBe('block-ref-chip')
    expect(chip?.getAttribute('contenteditable')).toBe('false')
  })

  /**
   * Structural parity with `renderBlockRef`
   * (`@/components/RichContentRenderer/marks/blockRef.tsx`): `.block-ref-chip`
   * is `inline-flex`, and `text-overflow` applies only to a block container,
   * so a title assigned straight to `dom.textContent` becomes an anonymous
   * flex item that no selector can reach — `max-width` then hard-clips it with
   * no `…`. The title has to live in a real `.block-ref-chip-label` child, and
   * the native `title=` is what reveals the clipped tail.
   */
  it('puts the title in a .block-ref-chip-label child and mirrors it into title=', () => {
    editor = createEditor({
      resolveContent: () => 'a title long enough that max-width would clip it on screen',
      content: docWithRef('LABEL0001'),
    })

    const chip = editor.view.dom.querySelector('[data-type="block-ref"]')
    const label = chip?.querySelector('.block-ref-chip-label')
    expect(label).not.toBeNull()
    expect(label?.textContent).toBe('a title long enough that max-width would clip it on screen')
    expect(chip?.getAttribute('title')).toBe(
      'a title long enough that max-width would clip it on screen',
    )
  })

  it('re-fills the single label child on update instead of appending another', () => {
    editor = createEditor({
      resolveContent: (id) => `Title for ${id}`,
      content: docWithRef('UPD0001'),
    })

    editor.commands.setContent(docWithRef('UPD0002'))

    const chip = editor.view.dom.querySelector('[data-type="block-ref"]')
    expect(chip?.querySelectorAll('.block-ref-chip-label').length).toBe(1)
    expect(chip?.textContent).toBe('Title for UPD0002')
  })

  it('calls onNavigate with the block id on click', () => {
    const onNavigate = vi.fn()
    editor = createEditor({ onNavigate, content: docWithRef('CLICK0001') })

    const chip = editor.view.dom.querySelector('[data-type="block-ref"]') as HTMLElement
    chip.dispatchEvent(new MouseEvent('click', { bubbles: true }))

    expect(onNavigate).toHaveBeenCalledWith('CLICK0001')
  })

  it('re-renders (updates textContent) when the node id attribute changes', () => {
    editor = createEditor({
      resolveContent: (id) => `Title for ${id}`,
      content: docWithRef('OLD0001'),
    })

    const chipBefore = editor.view.dom.querySelector('[data-type="block-ref"]')
    expect(chipBefore?.textContent).toBe('Title for OLD0001')

    // Replace the whole doc with a new block_ref id — exercises the
    // NodeView's `update` path via a fresh render rather than in-place
    // attribute mutation (ProseMirror node identity), which is sufficient
    // to prove `resolveContent` is re-invoked with the new id.
    editor.commands.setContent(docWithRef('NEW0001'))

    const chipAfter = editor.view.dom.querySelector('[data-type="block-ref"]')
    expect(chipAfter?.textContent).toBe('Title for NEW0001')
  })
})
