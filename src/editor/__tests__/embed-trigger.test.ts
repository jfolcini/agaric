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
