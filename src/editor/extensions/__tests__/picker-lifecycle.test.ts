/**
 * Picker lifecycle regression tests — roving-handoff races.
 *
 * The roving editor is a singleton: switching blocks swaps the document
 * in-place (`replaceDocSilently`) without destroying the editor, so
 * `editor.isDestroyed` never fires on a block switch. These tests pin the
 * behaviour of the async picker paths across that handoff:
 *
 *  1. `resolveAndInsertPickerToken` must NOT splice a token (or the raw
 *     query text) into whatever document happens to be mounted when the
 *     async items/create lookup resolves — a size-only staleness check
 *     cannot detect a doc swap.
 *  2. The Suggestion-command `isCreate` path (at-tag / block-link) must
 *     delete the trigger range synchronously (closing the popup and the
 *     double-create window) and must not run a stale pre-await
 *     `deleteRange` against a swapped-in document.
 */

import { Editor } from '@tiptap/core'
import Document from '@tiptap/extension-document'
import Paragraph from '@tiptap/extension-paragraph'
import Text from '@tiptap/extension-text'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { BlockLink } from '@/editor/extensions/block-link'
import { resolveAndInsertPickerToken } from '@/editor/extensions/picker-plugin'
import { TagRef } from '@/editor/extensions/tag-ref'

let editor: Editor | undefined

afterEach(() => {
  editor?.destroy()
  editor = undefined
  vi.doUnmock('@tiptap/suggestion')
  vi.resetModules()
})

function buildEditor(initialText: string): Editor {
  return new Editor({
    element: document.createElement('div'),
    extensions: [
      Document,
      Paragraph,
      Text,
      TagRef.configure({ resolveName: (id) => `Tag:${id}` }),
      BlockLink.configure({ resolveTitle: (id) => `Title:${id}` }),
    ],
    content: {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: initialText ? [{ type: 'text', text: initialText }] : [],
        },
      ],
    },
  })
}

/**
 * Simulate the roving handoff's document swap: `use-roving-editor.ts`'s
 * `replaceDocSilently` replaces [0, doc.content.size] in a single
 * transaction on the same (never-destroyed) editor instance.
 */
function swapDoc(target: Editor, text: string) {
  const pmDoc = target.schema.nodeFromJSON({
    type: 'doc',
    content: [{ type: 'paragraph', content: text ? [{ type: 'text', text }] : [] }],
  })
  const { tr } = target.state
  tr.replaceWith(0, target.state.doc.content.size, pmDoc.content)
  tr.setMeta('addToHistory', false)
  target.view.dispatch(tr)
}

function countNodes(target: Editor, typeName: string): number {
  let count = 0
  target.state.doc.descendants((n) => {
    if (n.type.name === typeName) count += 1
  })
  return count
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0))

// ── Finding 24: resolveAndInsertPickerToken across a doc swap ─────

describe('resolveAndInsertPickerToken — roving doc swap mid-resolve', () => {
  it('drops the token when the document was swapped before items resolved', async () => {
    // Block A: the input rule already deleted '[[Team Roadmap]]'.
    editor = buildEditor('Write report ')
    let resolveItems!: (items: { id: string; label: string }[]) => void
    const itemsPromise = new Promise<{ id: string; label: string }[]>((r) => {
      resolveItems = r
    })

    const done = resolveAndInsertPickerToken({
      editor,
      text: 'Team Roadmap',
      insertPos: 14, // end of 'Write report ' in block A
      items: () => itemsPromise,
      matchItem: (items, text) => items.find((i) => i.label === text),
      tokenFor: (id) => ({ type: 'block_link', attrs: { id } }),
      loggerComponent: 'TestPicker',
      errorMessage: 'failed',
    })

    // Roving handoff: block B (longer than insertPos) is mounted into the
    // same editor instance while the IPC is still in flight.
    const blockBText = 'This is block B with plenty of content to keep offsets in range'
    swapDoc(editor, blockBText)

    resolveItems([{ id: 'ULID_1', label: 'Team Roadmap' }])
    await done

    // Block B must be untouched — no block_link spliced into its middle.
    expect(countNodes(editor, 'block_link')).toBe(0)
    expect(editor.state.doc.textContent).toBe(blockBText)
  })

  it('drops the raw-text fallback when the document was swapped (no-match branch)', async () => {
    editor = buildEditor('Write report ')
    let resolveItems!: (items: { id: string; label: string }[]) => void
    const itemsPromise = new Promise<{ id: string; label: string }[]>((r) => {
      resolveItems = r
    })

    const done = resolveAndInsertPickerToken({
      editor,
      text: 'Team Roadmap',
      insertPos: 14,
      items: () => itemsPromise,
      matchItem: () => undefined,
      tokenFor: (id) => ({ type: 'block_link', attrs: { id } }),
      loggerComponent: 'TestPicker',
      errorMessage: 'failed',
    })

    const blockBText = 'This is block B with plenty of content to keep offsets in range'
    swapDoc(editor, blockBText)

    resolveItems([])
    await done

    expect(editor.state.doc.textContent).toBe(blockBText)
  })

  it('skips onCreate entirely when the document was swapped before items resolved', async () => {
    editor = buildEditor('Write report ')
    let resolveItems!: (items: { id: string; label: string }[]) => void
    const itemsPromise = new Promise<{ id: string; label: string }[]>((r) => {
      resolveItems = r
    })
    const onCreate = vi.fn().mockResolvedValue('NEW_ULID')

    const done = resolveAndInsertPickerToken({
      editor,
      text: 'Team Roadmap',
      insertPos: 14,
      items: () => itemsPromise,
      matchItem: () => undefined,
      tokenFor: (id) => ({ type: 'block_link', attrs: { id } }),
      onCreate,
      loggerComponent: 'TestPicker',
      errorMessage: 'failed',
    })

    const blockBText = 'This is block B with plenty of content to keep offsets in range'
    swapDoc(editor, blockBText)

    resolveItems([])
    await done

    // No orphan page/tag minted for a doc we can no longer insert into.
    expect(onCreate).not.toHaveBeenCalled()
    expect(countNodes(editor, 'block_link')).toBe(0)
    expect(editor.state.doc.textContent).toBe(blockBText)
  })

  it('drops the error-path plain-text fallback when the document was swapped', async () => {
    editor = buildEditor('Write report ')
    let rejectItems!: (err: Error) => void
    const itemsPromise = new Promise<never>((_r, rej) => {
      rejectItems = rej
    })

    const done = resolveAndInsertPickerToken({
      editor,
      text: 'Team Roadmap',
      insertPos: 14,
      items: () => itemsPromise,
      matchItem: () => undefined,
      tokenFor: (id) => ({ type: 'block_link', attrs: { id } }),
      loggerComponent: 'TestPicker',
      errorMessage: 'failed',
    })

    const blockBText = 'This is block B with plenty of content to keep offsets in range'
    swapDoc(editor, blockBText)

    rejectItems(new Error('IPC down'))
    await done

    expect(editor.state.doc.textContent).toBe(blockBText)
  })

  it('survives the trigger-range deletion itself (input-rule delete lands after the helper starts)', async () => {
    // The input-rule handler queues `state.tr.delete(range.from, range.to)`
    // and the transaction is dispatched AFTER the handler (and thus the
    // helper call) returns — the tracked position sits on the deletion
    // boundary and must NOT be treated as gone.
    editor = buildEditor('Hello [[Team Roadmap]]')
    let resolveItems!: (items: { id: string; label: string }[]) => void
    const itemsPromise = new Promise<{ id: string; label: string }[]>((r) => {
      resolveItems = r
    })

    const done = resolveAndInsertPickerToken({
      editor,
      text: 'Team Roadmap',
      insertPos: 7, // range.from of '[[Team Roadmap]]'
      items: () => itemsPromise,
      matchItem: (items, text) => items.find((i) => i.label === text),
      tokenFor: (id) => ({ type: 'block_link', attrs: { id } }),
      loggerComponent: 'TestPicker',
      errorMessage: 'failed',
    })

    // The trigger text is deleted while the resolve is in flight.
    editor.chain().deleteRange({ from: 7, to: 23 }).run()

    resolveItems([{ id: 'ULID_1', label: 'Team Roadmap' }])
    await done

    const paragraph = editor.state.doc.child(0)
    expect(paragraph.childCount).toBe(2)
    expect(paragraph.child(0).text).toBe('Hello ')
    expect(paragraph.child(1).type.name).toBe('block_link')
    expect(paragraph.child(1).attrs['id']).toBe('ULID_1')
  })

  it('maps the insertion position through concurrent same-block edits', async () => {
    editor = buildEditor('Hello world')
    let resolveItems!: (items: { id: string; label: string }[]) => void
    const itemsPromise = new Promise<{ id: string; label: string }[]>((r) => {
      resolveItems = r
    })

    const done = resolveAndInsertPickerToken({
      editor,
      text: 'myTag',
      insertPos: 12, // end of 'Hello world'
      items: () => itemsPromise,
      matchItem: (items, text) => items.find((i) => i.label === text),
      tokenFor: (id) => ({ type: 'tag_ref', attrs: { id } }),
      loggerComponent: 'TestPicker',
      errorMessage: 'failed',
    })

    // The user keeps typing at the start of the same block while the
    // lookup is in flight — the captured offset must shift with the edit.
    editor.chain().insertContentAt(1, 'XYZ ').run()

    resolveItems([{ id: 'ULID_TAG', label: 'myTag' }])
    await done

    const paragraph = editor.state.doc.child(0)
    expect(paragraph.childCount).toBe(2)
    expect(paragraph.child(0).text).toBe('XYZ Hello world')
    expect(paragraph.child(1).type.name).toBe('tag_ref')
  })
})

// ── Findings 25 + 26: Suggestion-command isCreate path ────────────

type SuggestionCommand = (ctx: {
  editor: Editor
  range: { from: number; to: number }
  props: unknown
}) => void

/**
 * Capture the Suggestion `command` the picker wires up, using the same
 * mock-`@tiptap/suggestion` pattern as the per-picker suites. The command
 * closes over the freshly imported picker module's real insertion logic.
 */
async function captureCommand(
  picker: 'at-tag' | 'block-link',
  targetEditor: Editor,
  onCreate: (label: string) => Promise<string>,
): Promise<SuggestionCommand> {
  vi.resetModules()
  let captured: Record<string, unknown> | undefined
  vi.doMock('@tiptap/suggestion', () => ({
    Suggestion: (opts: Record<string, unknown>) => {
      captured = opts
      return {}
    },
  }))
  const ext =
    picker === 'at-tag'
      ? (await import('@/editor/extensions/at-tag-picker')).AtTagPicker.configure({
          items: () => [],
          onCreate,
        })
      : (await import('@/editor/extensions/block-link-picker')).BlockLinkPicker.configure({
          items: () => [],
          onCreate,
        })
  ;(ext.config.addProseMirrorPlugins as unknown as (this: unknown) => unknown).call({
    editor: targetEditor,
    options: ext.options,
  })
  vi.doUnmock('@tiptap/suggestion')
  return captured?.['command'] as SuggestionCommand
}

describe('BlockLinkPicker isCreate command — stale range / double-create window', () => {
  it('deletes the trigger range synchronously, closing the re-fire window before the create resolves', async () => {
    editor = buildEditor('[[New Project')
    let resolveCreate!: (id: string) => void
    const onCreate = vi.fn(
      () =>
        new Promise<string>((r) => {
          resolveCreate = r
        }),
    )
    const command = await captureCommand('block-link', editor, onCreate)

    command({
      editor,
      range: { from: 1, to: 14 },
      props: { id: 'create', label: 'New Project', isCreate: true },
    })

    // Synchronous deletion is what exits the Suggestion plugin (the match
    // breaks), so a second Enter/click cannot re-invoke the create while
    // the IPC is in flight.
    expect(editor.state.doc.textContent).toBe('')
    expect(onCreate).toHaveBeenCalledTimes(1)

    resolveCreate('NEW_PAGE_ID')
    await flush()

    // Token + trailing space land where the trigger text was.
    const paragraph = editor.state.doc.child(0)
    expect(paragraph.childCount).toBe(2)
    expect(paragraph.child(0).type.name).toBe('block_link')
    expect(paragraph.child(0).attrs['id']).toBe('NEW_PAGE_ID')
    expect(paragraph.child(1).text).toBe(' ')
  })

  it('does not corrupt a swapped-in document: pre-await range never applied to block B', async () => {
    editor = buildEditor('[[New Project')
    let resolveCreate!: (id: string) => void
    const onCreate = vi.fn(
      () =>
        new Promise<string>((r) => {
          resolveCreate = r
        }),
    )
    const command = await captureCommand('block-link', editor, onCreate)

    command({
      editor,
      range: { from: 1, to: 14 },
      props: { id: 'create', label: 'New Project', isCreate: true },
    })

    // Roving handoff to block B while the create IPC is in flight.
    const blockBText = 'Block B content that must stay intact'
    swapDoc(editor, blockBText)

    resolveCreate('NEW_PAGE_ID')
    await flush()

    expect(editor.state.doc.textContent).toBe(blockBText)
    expect(countNodes(editor, 'block_link')).toBe(0)
  })

  it('restores the trigger text at its position when the create IPC fails', async () => {
    editor = buildEditor('[[New Project')
    let rejectCreate!: (err: Error) => void
    const onCreate = vi.fn(
      () =>
        new Promise<string>((_r, rej) => {
          rejectCreate = rej
        }),
    )
    const command = await captureCommand('block-link', editor, onCreate)

    command({
      editor,
      range: { from: 1, to: 14 },
      props: { id: 'create', label: 'New Project', isCreate: true },
    })

    rejectCreate(new Error('IPC down'))
    await flush()

    expect(editor.state.doc.textContent).toBe('[[New Project')
    expect(countNodes(editor, 'block_link')).toBe(0)
  })
})

describe('AtTagPicker isCreate command — stale range / double-create window', () => {
  it('deletes the trigger range synchronously and inserts tag_ref + space at the tracked position', async () => {
    editor = buildEditor('@newTag')
    let resolveCreate!: (id: string) => void
    const onCreate = vi.fn(
      () =>
        new Promise<string>((r) => {
          resolveCreate = r
        }),
    )
    const command = await captureCommand('at-tag', editor, onCreate)

    command({
      editor,
      range: { from: 1, to: 8 },
      props: { id: 'create', label: 'newTag', isCreate: true },
    })

    expect(editor.state.doc.textContent).toBe('')
    expect(onCreate).toHaveBeenCalledTimes(1)

    resolveCreate('NEW_TAG_ULID')
    await flush()

    const paragraph = editor.state.doc.child(0)
    expect(paragraph.childCount).toBe(2)
    expect(paragraph.child(0).type.name).toBe('tag_ref')
    expect(paragraph.child(0).attrs['id']).toBe('NEW_TAG_ULID')
    expect(paragraph.child(1).text).toBe(' ')
  })

  it('does not corrupt a swapped-in document: token dropped after a roving handoff', async () => {
    editor = buildEditor('@newTag')
    let resolveCreate!: (id: string) => void
    const onCreate = vi.fn(
      () =>
        new Promise<string>((r) => {
          resolveCreate = r
        }),
    )
    const command = await captureCommand('at-tag', editor, onCreate)

    command({
      editor,
      range: { from: 1, to: 8 },
      props: { id: 'create', label: 'newTag', isCreate: true },
    })

    const blockBText = 'Block B content that must stay intact'
    swapDoc(editor, blockBText)

    resolveCreate('NEW_TAG_ULID')
    await flush()

    expect(editor.state.doc.textContent).toBe(blockBText)
    expect(countNodes(editor, 'tag_ref')).toBe(0)
  })
})
