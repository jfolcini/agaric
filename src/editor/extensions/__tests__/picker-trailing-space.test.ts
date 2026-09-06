/**
 * #4708 — picking a page / tag / block must not append a trailing space.
 *
 * Every picker used to end its insertion chain with `.insertContent(' ')`, so
 * `[[Page` → Enter → `,` produced `[[Page]] ,` and the user had to backspace.
 *
 * The space was believed to be load-bearing for two reasons; both are false,
 * and these tests pin that:
 *
 *  1. "the caret needs a text position after the atom" — the position right
 *     after an inline atom inside a paragraph IS a text position, so the
 *     caret lands there and typing continues the paragraph.
 *  2. "`allowedPrefixes` needs whitespace before the next trigger" — TipTap's
 *     `findSuggestionMatch` reads only `$position.nodeBefore.text`, and a
 *     text node always STARTS after an atom, so the trigger's prefix is the
 *     empty string, which every `allowedPrefixes` set accepts. A second
 *     picker therefore opens with no space between the two tokens.
 *
 * The pickers run against a real editor here, with the real `@tiptap/suggestion`
 * plugin: the mock is a pass-through that hands the tests the same `command`
 * callback the suggestion popup invokes on Enter, so the production insertion
 * chain is what runs. It is ONE hoisted `vi.mock` for the file, not a
 * `vi.doMock` / `vi.doUnmock` pair per test: those only queue, every concurrent
 * module fetch drains the queue in full, and a sibling drain's `unmock` landing
 * after this test's `mock` loads the real plugin uncaptured (#4742).
 */

import { Editor } from '@tiptap/core'
import Document from '@tiptap/extension-document'
import Paragraph from '@tiptap/extension-paragraph'
import Text from '@tiptap/extension-text'
import type { PluginKey } from '@tiptap/pm/state'
import type { SuggestionOptions } from '@tiptap/suggestion'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AtTagPicker, atTagPickerPluginKey } from '@/editor/extensions/at-tag-picker'
import { BlockLink } from '@/editor/extensions/block-link'
import { BlockLinkPicker, blockLinkPickerPluginKey } from '@/editor/extensions/block-link-picker'
import { BlockRef } from '@/editor/extensions/block-ref'
import { BlockRefPicker, blockRefPickerPluginKey } from '@/editor/extensions/block-ref-picker'
import { TagRef } from '@/editor/extensions/tag-ref'
import type { PickerItem } from '@/editor/SuggestionList'

type PickerCommand = NonNullable<SuggestionOptions<PickerItem>['command']>

const { capturedCommands } = vi.hoisted(() => ({
  capturedCommands: new Map<PluginKey, PickerCommand>(),
}))

vi.mock('@tiptap/suggestion', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tiptap/suggestion')>()
  return {
    ...actual,
    Suggestion: (opts: SuggestionOptions<PickerItem>) => {
      capturedCommands.set(opts.pluginKey as PluginKey, opts.command as PickerCommand)
      return actual.Suggestion(opts)
    },
  }
})

let editor: Editor | undefined

afterEach(() => {
  editor?.destroy()
  editor = undefined
})

function build(
  items: (query: string) => PickerItem[],
  onCreate?: (label: string) => Promise<string>,
): Editor {
  return new Editor({
    element: document.createElement('div'),
    extensions: [
      Document,
      Paragraph,
      Text,
      TagRef.configure({ resolveName: (id: string) => `Tag:${id}` }),
      BlockLink.configure({ resolveTitle: (id: string) => `Title:${id}` }),
      BlockRef.configure({ resolveContent: (id: string) => `Ref:${id}` }),
      AtTagPicker.configure({ items, ...(onCreate ? { onCreate } : {}) }),
      BlockLinkPicker.configure({ items }),
      BlockRefPicker.configure({ items }),
    ],
    content: { type: 'doc', content: [{ type: 'paragraph' }] },
  })
}

/** Type raw text into the editor at the cursor, as a user keystroke would. */
function type(ed: Editor, text: string): void {
  ed.chain().focus().insertContent(text).run()
}

interface PluginRange {
  from: number
  to: number
}

/**
 * Select `item` from the picker keyed by `pluginKey` — the exact call the
 * suggestion popup makes on Enter, with the range the live plugin state holds.
 */
function pick(ed: Editor, pluginKey: PluginKey, item: PickerItem): void {
  const state = pluginKey.getState(ed.state) as { active: boolean; range: PluginRange } | undefined
  const command = capturedCommands.get(pluginKey)
  expect(state?.active, 'picker must be open before an item can be picked').toBe(true)
  expect(command, 'the picker must have registered a suggestion command').toBeDefined()
  if (!state || !command) return
  command({ editor: ed, range: state.range, props: item })
}

/** The paragraph's children as `type` / `type("text")` labels. */
function children(ed: Editor): string[] {
  const labels: string[] = []
  ed.state.doc.child(0).forEach((node) => {
    labels.push(node.isText ? `text(${JSON.stringify(node.text)})` : node.type.name)
  })
  return labels
}

const tagItem = (id: string, label: string): PickerItem => ({ id, label, isCreate: false })

// ── The report: a comma must land directly against the token ───────────

describe('#4708 — no trailing space after a picked token', () => {
  it('tag picker: `@work` → pick → `,` yields the chip then a bare comma', async () => {
    const items = vi.fn((_query: string) => [tagItem('TAG_1', 'work')])
    editor = build(items)
    editor.commands.focus('end')

    type(editor, '@work')
    await vi.waitFor(() => expect(items).toHaveBeenCalled())
    pick(editor, atTagPickerPluginKey, tagItem('TAG_1', 'work'))

    type(editor, ',')

    expect(children(editor)).toEqual(['tag_ref', 'text(",")'])
    expect(editor.state.doc.textContent).toBe(',')
  })

  it('page-link picker: `[[Page` → pick → `,` yields the chip then a bare comma', async () => {
    const items = vi.fn((_query: string) => [tagItem('PAGE_1', 'Page')])
    editor = build(items)
    editor.commands.focus('end')

    type(editor, '[[Page')
    await vi.waitFor(() => expect(items).toHaveBeenCalled())
    pick(editor, blockLinkPickerPluginKey, tagItem('PAGE_1', 'Page'))

    type(editor, ',')

    expect(children(editor)).toEqual(['block_link', 'text(",")'])
    expect(editor.state.doc.textContent).toBe(',')
  })

  it('block-ref picker: `((Block` → pick → `,` yields the chip then a bare comma', async () => {
    const items = vi.fn((_query: string) => [tagItem('BLK_1', 'Block')])
    editor = build(items)
    editor.commands.focus('end')

    type(editor, '((Block')
    await vi.waitFor(() => expect(items).toHaveBeenCalled())
    pick(editor, blockRefPickerPluginKey, tagItem('BLK_1', 'Block'))

    type(editor, ',')

    expect(children(editor)).toEqual(['block_ref', 'text(",")'])
    expect(editor.state.doc.textContent).toBe(',')
  })

  it('create path: a newly created tag also lands without a trailing space', async () => {
    const items = vi.fn((_query: string) => [
      { id: 'PLACEHOLDER', label: 'brandnew', isCreate: true },
    ])
    const onCreate = vi.fn().mockResolvedValue('TAG_NEW')
    const ed = build(items, onCreate)
    editor = ed
    ed.commands.focus('end')

    type(ed, '@brandnew')
    await vi.waitFor(() => expect(items).toHaveBeenCalled())
    pick(ed, atTagPickerPluginKey, { id: 'PLACEHOLDER', label: 'brandnew', isCreate: true })

    // The token only lands once the create IPC resolves.
    await vi.waitFor(() => expect(children(ed)).toEqual(['tag_ref']))

    type(ed, ',')

    expect(children(ed)).toEqual(['tag_ref', 'text(",")'])
    expect(ed.state.doc.textContent).toBe(',')
  })
})

// ── The regression the space was there to prevent ──────────────────────
//
// Two tokens back to back: the second trigger must still open its picker
// even though it is typed directly against an atom, and the two tokens must
// end up ADJACENT (no space text node wedged between them).

describe('#4708 — back-to-back inserts still open the second picker', () => {
  it('tag picker: `@a` → pick → `@b` → pick yields two adjacent chips', async () => {
    const items = vi.fn((query: string) =>
      query.startsWith('b') ? [tagItem('TAG_B', 'beta')] : [tagItem('TAG_A', 'alpha')],
    )
    editor = build(items)
    editor.commands.focus('end')

    type(editor, '@alpha')
    await vi.waitFor(() => expect(items).toHaveBeenCalled())
    pick(editor, atTagPickerPluginKey, tagItem('TAG_A', 'alpha'))

    // Typed directly against the chip — no space in between.
    items.mockClear()
    type(editor, '@beta')
    await vi.waitFor(() => expect(items).toHaveBeenCalledWith('beta'))
    pick(editor, atTagPickerPluginKey, tagItem('TAG_B', 'beta'))

    expect(children(editor)).toEqual(['tag_ref', 'tag_ref'])
    expect(editor.state.doc.child(0).child(0).attrs['id']).toBe('TAG_A')
    expect(editor.state.doc.child(0).child(1).attrs['id']).toBe('TAG_B')
  })

  it('page-link picker: `[[A` → pick → `[[B` → pick yields two adjacent chips', async () => {
    const items = vi.fn((query: string) =>
      query.startsWith('B') ? [tagItem('PAGE_B', 'Bravo')] : [tagItem('PAGE_A', 'Alpha')],
    )
    editor = build(items)
    editor.commands.focus('end')

    type(editor, '[[Alpha')
    await vi.waitFor(() => expect(items).toHaveBeenCalled())
    pick(editor, blockLinkPickerPluginKey, tagItem('PAGE_A', 'Alpha'))

    items.mockClear()
    type(editor, '[[Bravo')
    await vi.waitFor(() => expect(items).toHaveBeenCalledWith('Bravo'))
    pick(editor, blockLinkPickerPluginKey, tagItem('PAGE_B', 'Bravo'))

    expect(children(editor)).toEqual(['block_link', 'block_link'])
    expect(editor.state.doc.child(0).child(0).attrs['id']).toBe('PAGE_A')
    expect(editor.state.doc.child(0).child(1).attrs['id']).toBe('PAGE_B')
  })
})

// ── The caret is left somewhere the user can keep typing ───────────────

describe('#4708 — caret after a picked token', () => {
  it('collapses at the end of the paragraph, and typing continues that paragraph', async () => {
    const items = vi.fn((_query: string) => [tagItem('PAGE_1', 'Page')])
    editor = build(items)
    editor.commands.focus('end')

    type(editor, 'see [[Page')
    await vi.waitFor(() => expect(items).toHaveBeenCalled())
    pick(editor, blockLinkPickerPluginKey, tagItem('PAGE_1', 'Page'))

    const paragraph = editor.state.doc.child(0)
    const { selection } = editor.state
    expect(selection.empty).toBe(true)
    expect(selection.$from.parent.type.name).toBe('paragraph')
    expect(selection.$from.parentOffset).toBe(paragraph.content.size)

    type(editor, ' and more')

    // Still one paragraph, no hard break, and the typing landed after the chip.
    expect(editor.state.doc.childCount).toBe(1)
    let hardBreaks = 0
    editor.state.doc.descendants((node) => {
      if (node.type.name === 'hard_break') hardBreaks += 1
    })
    expect(hardBreaks).toBe(0)
    expect(children(editor)).toEqual(['text("see ")', 'block_link', 'text(" and more")'])
  })
})
