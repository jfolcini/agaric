/**
 * #6033 — a typed `[[Page#Heading]]` / `[[Page#^ULID]]`, and `[[#Heading]]` on
 * the editor's own page, keeps its anchor: the block the anchor names is stored
 * as the block ref `((ULID))`, or for `![[…]]` alone in its block the embed
 * `{{embed ((ULID))}}`. An anchor that names no block links the page, as before.
 * The extension asks its `findAnchor` option which block an anchor names
 * (`anchor-block.ts`, tested there).
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
const GOALS = blockId(7)
const PROJECT: PickerItem = { id: PAGE, label: 'Project', title: 'Project' }

const searchPages = vi.fn(async (query: string): Promise<PickerItem[]> =>
  'project'.startsWith(query.toLowerCase())
    ? [PROJECT]
    : [{ id: '__create__', label: query, isCreate: true }],
)
const onCreatePage = vi.fn(async (_label: string) => '01PAGE00000000000000000NEW')
/** `Goals` names the heading block on any page; nothing else names a block. */
const findAnchor = vi.fn(async (_pageId: string | undefined, anchor: string) =>
  anchor === 'Goals' ? GOALS : undefined,
)

const editors: Editor[] = []

afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy()
  rendered.props.clear()
  vi.clearAllMocks()
})

async function blockMode(markdown = '') {
  const hook = renderHook(() => useRovingEditor({ searchPages, onCreatePage, findAnchor }))
  await waitFor(() => expect(hook.result.current.editor).not.toBeNull())
  const handle = hook.result.current
  editors.push(handle.editor as Editor)
  handle.mount('01BLOCK0000000000000000001', markdown)
  ;(handle.editor as Editor).commands.focus('end')
  return handle
}

function pageMode(): Editor {
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
      findAnchor,
      onNavigate: () => {},
      onTagClick: () => {},
      placeholder: '',
    }),
    content: pageDocContent([{ id: blockId(1), depth: 0, content: '' }], () => blockId(9)),
  })
  editors.push(editor)
  editor.commands.focus('end')
  return editor
}

/** Type `text` and wait for the closing `]]` rule's async lookup to land a chip. */
async function typeResolved(editor: Editor, text: string) {
  type(editor, text)
  await vi.waitFor(() => expect(JSON.stringify(editor.getJSON())).toMatch(/block_(link|ref)/))
}

async function pickerFor(query: string) {
  return vi.waitFor(() => {
    const props = rendered.props.get(blockLinkPickerPluginKey)
    expect(props?.query).toBe(query)
    return props as { command: (item: PickerItem) => void }
  })
}

describe('a typed `[[Page#anchor]]` in block mode (#6033)', () => {
  it('refs the block the anchor names on that page', async () => {
    const handle = await blockMode()
    await typeResolved(handle.editor as Editor, '[[Project#Goals]]')

    expect(findAnchor).toHaveBeenCalledWith(PAGE, 'Goals')
    expect(handle.unmount()).toBe(`((${GOALS}))`)
  })

  it('alone in its block as `![[…]]`, embeds the block the anchor names', async () => {
    const handle = await blockMode()
    await typeResolved(handle.editor as Editor, '![[Project#Goals]]')

    expect(handle.unmount()).toBe(`{{embed ((${GOALS}))}}`)
  })

  it('links the page when the anchor names no block', async () => {
    const handle = await blockMode()
    await typeResolved(handle.editor as Editor, '[[Project#Elsewhere|see]]')

    expect(findAnchor).toHaveBeenCalledWith(PAGE, 'Elsewhere')
    expect(handle.unmount()).toBe(`[[${PAGE}|see]]`)
  })

  it('asks for no anchor when the whole text names a page', async () => {
    const handle = await blockMode()
    await typeResolved(handle.editor as Editor, '[[Project]]')

    expect(findAnchor).not.toHaveBeenCalled()
    expect(handle.unmount()).toBe(`[[${PAGE}]]`)
  })

  it('`[[#Goals]]` refs the block the anchor names on its own page', async () => {
    const handle = await blockMode()
    await typeResolved(handle.editor as Editor, '[[#Goals]]')

    expect(findAnchor).toHaveBeenCalledWith(undefined, 'Goals')
    expect(handle.unmount()).toBe(`((${GOALS}))`)
  })

  it('`[[#Elsewhere]]` names no block and stays as typed', async () => {
    const handle = await blockMode()
    const editor = handle.editor as Editor
    type(editor, '[[#Elsewhere]]')
    await vi.waitFor(() => expect(findAnchor).toHaveBeenCalledWith(undefined, 'Elsewhere'))

    await vi.waitFor(() => expect(editor.getText()).toBe('[[#Elsewhere]]'))
  })

  it('picking the page after typing an anchor refs the block the anchor names', async () => {
    const handle = await blockMode()
    type(handle.editor as Editor, '[[Project#Goals')
    ;(await pickerFor('Project#Goals')).command(PROJECT)

    const editor = handle.editor as Editor
    await vi.waitFor(() => expect(JSON.stringify(editor.getJSON())).toContain('block_ref'))
    expect(findAnchor).toHaveBeenCalledWith(PAGE, 'Goals')
    expect(handle.unmount()).toBe(`((${GOALS}))`)
  })
})

describe('a typed `[[Page#anchor]]` in page mode (#6033)', () => {
  it('refs the block the anchor names on that page', async () => {
    const editor = pageMode()
    await typeResolved(editor, '[[Project#Goals]]')

    expect(markdownOf(editor.state.doc.child(0))).toBe(`((${GOALS}))`)
  })

  it('alone in its block as `![[…]]`, embeds the block the anchor names', async () => {
    const editor = pageMode()
    await typeResolved(editor, '![[Project#Goals]]')

    expect(markdownOf(editor.state.doc.child(0))).toBe(`{{embed ((${GOALS}))}}`)
  })
})
