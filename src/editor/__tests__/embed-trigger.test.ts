/**
 * #5691 — `![[` (Obsidian's embed syntax) opens the `[[` page picker, and the
 * pick is written as the embed `{{embed [[ULID]]}}`, in both editors: block
 * mode's roving editor (saved through `unmount`) and page mode's document.
 */

import { renderHook, waitFor } from '@testing-library/react'
import type { Editor } from '@tiptap/core'
import { Editor as TipTapEditor } from '@tiptap/core'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { blockLinkPickerPluginKey } from '@/editor/extensions/block-link-picker'
import { blockId, markdownOf, type } from '@/editor/page-mode/__tests__/page-mode-fixtures'
import { pageDocContent } from '@/editor/page-mode/page-document'
import { pageModeExtensions } from '@/editor/page-mode/page-mode-extensions'
import type { PickerItem } from '@/editor/SuggestionList'
import { useRovingEditor } from '@/editor/use-roving-editor'
import { parseEmbedToken } from '@/lib/embed-token'

// The popup is SuggestionList's, tested there. Here a picker's last props
// stand in for it: `command(item)` is what a tap, click or Enter on a row runs.
const rendered = vi.hoisted(() => ({
  props: new Map<unknown, { command: (item: PickerItem) => void; query: string }>(),
}))
vi.mock('@/editor/suggestion-renderer', () => ({
  createSuggestionRenderer: (_label: string, pluginKey: unknown) => ({
    onStart: (props: { command: (item: PickerItem) => void; query: string }) => {
      rendered.props.set(pluginKey, props)
    },
    onUpdate: (props: { command: (item: PickerItem) => void; query: string }) => {
      rendered.props.set(pluginKey, props)
    },
    onKeyDown: () => false,
    onExit: () => {
      rendered.props.delete(pluginKey)
    },
  }),
  cleanupOrphanedPopups: () => 0,
}))

const PAGE = '01PAGE00000000000000000PRJ'
const CREATED = '01PAGE00000000000000000NEW'
const PROJECT: PickerItem = { id: PAGE, label: 'Project', title: 'Project' }

const searchPages = vi.fn(async (query: string): Promise<PickerItem[]> =>
  'project'.startsWith(query.toLowerCase())
    ? [PROJECT]
    : [{ id: '__create__', label: query, isCreate: true }],
)
const onCreatePage = vi.fn(async (_label: string) => CREATED)

const editors: Editor[] = []

afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy()
  rendered.props.clear()
  vi.clearAllMocks()
})

/** The `[[` popup's props once it shows `query`. */
async function pickerFor(query: string) {
  return vi.waitFor(() => {
    const props = rendered.props.get(blockLinkPickerPluginKey)
    expect(props?.query).toBe(query)
    return props as { command: (item: PickerItem) => void }
  })
}

/** Block mode: the roving editor mounted in a block holding `markdown`. */
async function blockMode(markdown = '') {
  const hook = renderHook(() => useRovingEditor({ searchPages, onCreatePage }))
  await waitFor(() => expect(hook.result.current.editor).not.toBeNull())
  const handle = hook.result.current
  editors.push(handle.editor as Editor)
  handle.mount('01BLOCK0000000000000000001', markdown)
  ;(handle.editor as Editor).commands.focus('end')
  return handle
}

/** Page mode: page mode's document holding one block of `markdown`. */
function pageMode(markdown = ''): Editor {
  const noItems = () => Promise.resolve([])
  const editor = new TipTapEditor({
    element: document.createElement('div'),
    extensions: pageModeExtensions({
      resolveTagName: (id) => id,
      resolveBlockTitle: (id) => id,
      resolveBlockStatus: () => 'active',
      resolveTagStatus: () => 'active',
      searchTags: noItems,
      searchPages,
      searchBlockRefs: noItems,
      onCreatePage,
      onCreateTag: () => Promise.resolve(''),
      onNavigate: () => {},
      onTagClick: () => {},
      placeholder: '',
    }),
    content: pageDocContent([{ id: blockId(1), depth: 0, content: markdown }], () => blockId(9)),
  })
  editors.push(editor)
  editor.commands.focus('end')
  return editor
}

describe('`![[` in block mode', () => {
  it('opens the page picker, and the pick saves the block as an embed of that page', async () => {
    const handle = await blockMode()
    type(handle.editor as Editor, '![[Proj')
    ;(await pickerFor('Proj')).command(PROJECT)

    const saved = handle.unmount()
    expect(saved).toBe(`{{embed [[${PAGE}]]}}`)
    expect(parseEmbedToken(saved)).toEqual({ targetId: PAGE })
  })

  it('after other text keeps the `!` and links the page', async () => {
    const handle = await blockMode('Hello')
    type(handle.editor as Editor, '![[Proj')
    ;(await pickerFor('Proj')).command(PROJECT)

    expect(handle.unmount()).toBe(`Hello\\![[${PAGE}]]`)
  })

  it('before other text keeps the `!` and links the page', async () => {
    const handle = await blockMode('tail')
    ;(handle.editor as Editor).commands.focus('start')
    type(handle.editor as Editor, '![[Proj')
    ;(await pickerFor('Proj')).command(PROJECT)

    expect(handle.unmount()).toBe(`\\![[${PAGE}]]tail`)
  })

  it('creates the page from the create row and embeds it', async () => {
    const handle = await blockMode()
    type(handle.editor as Editor, '![[Roadmap')
    ;(await pickerFor('Roadmap')).command({ id: '__create__', label: 'Roadmap', isCreate: true })

    expect(onCreatePage).toHaveBeenCalledWith('Roadmap')
    // The token lands once the create resolves.
    const editor = handle.editor as Editor
    await vi.waitFor(() => expect(editor.isEmpty).toBe(false))
    expect(handle.unmount()).toBe(`{{embed [[${CREATED}]]}}`)
  })

  it('leaves `[[` without the `!` a page link', async () => {
    const handle = await blockMode()
    type(handle.editor as Editor, '[[Proj')
    ;(await pickerFor('Proj')).command(PROJECT)

    expect(handle.unmount()).toBe(`[[${PAGE}]]`)
  })
})

describe('`![[` in page mode', () => {
  it('opens the page picker, and the pick makes the block an embed of that page', async () => {
    const editor = pageMode()
    type(editor, '![[Proj')
    ;(await pickerFor('Proj')).command(PROJECT)

    expect(markdownOf(editor.state.doc.child(0))).toBe(`{{embed [[${PAGE}]]}}`)
  })
})

/** Type `text` and wait for the closing `]]` rule's async lookup to land its block link. */
async function typeResolved(editor: Editor, text: string) {
  type(editor, text)
  await vi.waitFor(() => expect(JSON.stringify(editor.getJSON())).toContain('block_link'))
}

describe('a typed whole `![[Name]]` in block mode (#6033)', () => {
  it('alone in its block saves the block as an embed of that page', async () => {
    const handle = await blockMode()
    await typeResolved(handle.editor as Editor, '![[Project]]')

    expect(handle.unmount()).toBe(`{{embed [[${PAGE}]]}}`)
  })

  it('creates a page it does not find and embeds it', async () => {
    const handle = await blockMode()
    await typeResolved(handle.editor as Editor, '![[Roadmap]]')

    expect(onCreatePage).toHaveBeenCalledWith('Roadmap')
    expect(handle.unmount()).toBe(`{{embed [[${CREATED}]]}}`)
  })

  it('drops a `|label`, which the embed has no room for', async () => {
    const handle = await blockMode()
    await typeResolved(handle.editor as Editor, '![[Project|the plan]]')

    expect(handle.unmount()).toBe(`{{embed [[${PAGE}]]}}`)
  })

  it('embeds the page an anchored body names when the anchor names no block', async () => {
    const handle = await blockMode()
    await typeResolved(handle.editor as Editor, '![[Project#Goals]]')

    expect(handle.unmount()).toBe(`{{embed [[${PAGE}]]}}`)
  })

  it('after other text keeps the `!` and links the page', async () => {
    const handle = await blockMode('Hello')
    await typeResolved(handle.editor as Editor, '![[Project]]')

    expect(handle.unmount()).toBe(`Hello\\![[${PAGE}]]`)
  })

  it('after an escaping backslash keeps the `!` and links the page', async () => {
    const handle = await blockMode()
    await typeResolved(handle.editor as Editor, '\\![[Project]]')

    const saved = handle.unmount()
    expect(parseEmbedToken(saved)).toBeNull()
    expect(saved).toBe(`\\\\\\![[${PAGE}]]`)
  })

  it('before other text keeps the `!` and links the page', async () => {
    const handle = await blockMode('tail')
    ;(handle.editor as Editor).commands.focus('start')
    await typeResolved(handle.editor as Editor, '![[Project]]')

    expect(handle.unmount()).toBe(`\\![[${PAGE}]]tail`)
  })

  it('leaves `[[Name]]` without the `!` a page link', async () => {
    const handle = await blockMode()
    await typeResolved(handle.editor as Editor, '[[Project]]')

    expect(handle.unmount()).toBe(`[[${PAGE}]]`)
  })

  it.each([
    ['', '{{embed [[01PAGE0000000000000000TWNA]]}}'],
    ['Hello', 'Hello\\![[01PAGE0000000000000000TWNA]]'],
  ])('after %j, a name two pages share takes the lowest id (#6278)', async (before, expected) => {
    const twin = (id: string): PickerItem => ({ id, label: 'Twin', title: 'Twin' })
    const search = searchPages.getMockImplementation()
    searchPages.mockImplementation(async (query) =>
      query === 'Twin'
        ? [twin('01PAGE0000000000000000TWNB'), twin('01PAGE0000000000000000TWNA')]
        : [],
    )
    try {
      const handle = await blockMode(before)
      await typeResolved(handle.editor as Editor, '![[Twin]]')

      expect(handle.unmount()).toBe(expected)
    } finally {
      if (search) searchPages.mockImplementation(search)
    }
  })

  it('one undo brings back the typed text', async () => {
    const handle = await blockMode()
    const editor = handle.editor as Editor
    await typeResolved(editor, '![[Project]]')
    editor.commands.undo()

    expect(editor.getText()).toBe('![[Project]]')
  })
})

describe('a typed whole `![[Name]]` in page mode (#6033)', () => {
  it('alone in its block makes the block an embed of that page', async () => {
    const editor = pageMode()
    await typeResolved(editor, '![[Project]]')

    expect(markdownOf(editor.state.doc.child(0))).toBe(`{{embed [[${PAGE}]]}}`)
  })
})

/**
 * Where the embed would not be its block's whole content, the one place it
 * renders, `![[` links instead, typed or picked. Each block's markdown ends in
 * a stand-in `x`, deleted before typing, that keeps its container from parsing away.
 */
const NOT_ALONE: Array<[string, string]> = [
  ['a heading', '# x'],
  ['a quote', '> x'],
  ['a task', '- [ ] x'],
  ['a list item', '- a\n- x'],
  ['a second paragraph', 'Hello\n\nx'],
]

/** Delete the stand-in `x` before the caret. */
function dropStandIn(editor: Editor) {
  const { from } = editor.state.selection
  editor.commands.deleteRange({ from: from - 1, to: from })
}

describe('`![[` where the embed would not be the whole block, in block mode', () => {
  it.each(NOT_ALONE)('typed whole in %s keeps the `!` and links the page', async (_, md) => {
    const handle = await blockMode(md)
    dropStandIn(handle.editor as Editor)
    await typeResolved(handle.editor as Editor, '![[Project]]')

    expect(handle.unmount()).toBe(`${md.slice(0, -1)}\\![[${PAGE}]]`)
  })

  it.each(NOT_ALONE)('picked in %s keeps the `!` and links the page', async (_, md) => {
    const handle = await blockMode(md)
    dropStandIn(handle.editor as Editor)
    type(handle.editor as Editor, '![[Proj')
    ;(await pickerFor('Proj')).command(PROJECT)

    expect(handle.unmount()).toBe(`${md.slice(0, -1)}\\![[${PAGE}]]`)
  })
})

describe('`![[` where the embed would not be the whole block, in page mode', () => {
  it.each(NOT_ALONE)('typed whole in %s keeps the `!` and links the page', async (_, md) => {
    const editor = pageMode(md)
    dropStandIn(editor)
    await typeResolved(editor, '![[Project]]')

    expect(markdownOf(editor.state.doc.child(0))).toBe(`${md.slice(0, -1)}\\![[${PAGE}]]`)
  })

  it.each(NOT_ALONE)('picked in %s keeps the `!` and links the page', async (_, md) => {
    const editor = pageMode(md)
    dropStandIn(editor)
    type(editor, '![[Proj')
    ;(await pickerFor('Proj')).command(PROJECT)

    expect(markdownOf(editor.state.doc.child(0))).toBe(`${md.slice(0, -1)}\\![[${PAGE}]]`)
  })
})
