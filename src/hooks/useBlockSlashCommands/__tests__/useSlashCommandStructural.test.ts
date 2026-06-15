/**
 * Structural slash commands: headings (h1..h6), callouts (default + per-type),
 * code/quote toggles, numbered list, divider, table (default + N×M), plus
 * the link/tag/query insert chains.
 */

import { invoke } from '@tauri-apps/api/core'
import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { makeBlock } from '../../../__tests__/fixtures'
import { useUndoStore } from '../../../stores/undo'
import { useSlashCommandStructural } from '../useSlashCommandStructural'
import { makeSyntheticCtx } from './test-utils'

vi.mock('../../../lib/announcer', () => ({ announce: vi.fn() }))
vi.mock('../../../lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock('../../../editor/markdown-serializer', () => ({
  serialize: vi.fn(() => 'serialized'),
}))

const mockedInvoke = vi.mocked(invoke)
const originalOnNewAction = useUndoStore.getState().onNewAction

afterEach(() => {
  useUndoStore.setState({
    ...useUndoStore.getState(),
    onNewAction: originalOnNewAction,
    pages: new Map(),
  })
})

beforeEach(() => {
  vi.clearAllMocks()
  mockedInvoke.mockResolvedValue(undefined)
})

describe('useSlashCommandStructural — headings', () => {
  it.each([1, 2, 3, 4, 5, 6])(
    'h%i prefixes existing content with the right hash count',
    async (n) => {
      const { result } = renderHook(() => useSlashCommandStructural())
      const { ctx, mount, pageStore } = makeSyntheticCtx()
      pageStore.setState({
        blocks: pageStore
          .getState()
          .blocks.map((b) => (b.id === 'BLOCK_1' ? { ...b, content: 'plain text' } : b)),
      })

      await result.current.exact[`h${n}`]?.(ctx, { id: `h${n}`, label: `Heading ${n}` })

      const expected = `${'#'.repeat(n)} plain text`
      expect(mockedInvoke).toHaveBeenCalledWith('edit_block', {
        blockId: 'BLOCK_1',
        toText: expected,
      })
      expect(mount).toHaveBeenCalledWith('BLOCK_1', expected)
    },
  )

  it('h1 strips an existing leading ##/### before reapplying', async () => {
    const { result } = renderHook(() => useSlashCommandStructural())
    const { ctx } = makeSyntheticCtx()
    ctx.pageStore.setState({
      blocks: ctx.pageStore
        .getState()
        .blocks.map((b) => (b.id === 'BLOCK_1' ? { ...b, content: '### already-h3' } : b)),
    })
    await result.current.exact['h1']?.(ctx, { id: 'h1', label: 'Heading 1' })
    expect(mockedInvoke).toHaveBeenCalledWith('edit_block', {
      blockId: 'BLOCK_1',
      toText: '# already-h3',
    })
  })

  it('heading slash command notifies undo (MAINT-116)', async () => {
    const onNewAction = vi.fn()
    useUndoStore.setState({ ...useUndoStore.getState(), onNewAction })
    const { result } = renderHook(() => useSlashCommandStructural())
    const { ctx } = makeSyntheticCtx()
    await result.current.exact['h1']?.(ctx, { id: 'h1', label: 'Heading 1' })
    expect(onNewAction).toHaveBeenCalledWith('PAGE_1')
  })
})

describe('useSlashCommandStructural — callouts', () => {
  it('/callout uses the info type', async () => {
    const { result } = renderHook(() => useSlashCommandStructural())
    const { ctx } = makeSyntheticCtx()
    ctx.pageStore.setState({
      blocks: ctx.pageStore
        .getState()
        .blocks.map((b) => (b.id === 'BLOCK_1' ? { ...b, content: 'note-text' } : b)),
    })
    await result.current.exact['callout']?.(ctx, { id: 'callout', label: 'Callout' })
    expect(mockedInvoke).toHaveBeenCalledWith('edit_block', {
      blockId: 'BLOCK_1',
      toText: '> [!INFO] note-text',
    })
  })

  it.each([
    ['callout-warning', '> [!WARNING] careful'],
    ['callout-tip', '> [!TIP] careful'],
    ['callout-error', '> [!ERROR] careful'],
    ['callout-note', '> [!NOTE] careful'],
  ] as const)('%s prefixed handler picks up the type from the id', async (id, expected) => {
    const { result } = renderHook(() => useSlashCommandStructural())
    const { ctx } = makeSyntheticCtx()
    ctx.pageStore.setState({
      blocks: ctx.pageStore
        .getState()
        .blocks.map((b) => (b.id === 'BLOCK_1' ? { ...b, content: 'careful' } : b)),
    })
    const handler = result.current.prefix.find(([p]) => p === 'callout-')?.[1]
    expect(handler).toBeDefined()
    await handler?.(ctx, { id, label: id })
    expect(mockedInvoke).toHaveBeenCalledWith('edit_block', {
      blockId: 'BLOCK_1',
      toText: expected,
    })
  })
})

describe('useSlashCommandStructural — list, divider', () => {
  it('numbered-list prefixes existing content with `1. `', async () => {
    const { result } = renderHook(() => useSlashCommandStructural())
    const { ctx } = makeSyntheticCtx()
    ctx.pageStore.setState({
      blocks: ctx.pageStore
        .getState()
        .blocks.map((b) => (b.id === 'BLOCK_1' ? { ...b, content: 'item' } : b)),
    })
    await result.current.exact['numbered-list']?.(ctx, {
      id: 'numbered-list',
      label: 'Numbered list',
    })
    expect(mockedInvoke).toHaveBeenCalledWith('edit_block', {
      blockId: 'BLOCK_1',
      toText: '1. item',
    })
  })

  it('divider replaces content with `---`', async () => {
    const { result } = renderHook(() => useSlashCommandStructural())
    const { ctx } = makeSyntheticCtx()
    await result.current.exact['divider']?.(ctx, { id: 'divider', label: 'Divider' })
    expect(mockedInvoke).toHaveBeenCalledWith('edit_block', { blockId: 'BLOCK_1', toText: '---' })
  })
})

describe('useSlashCommandStructural — duplicate (#976 item 13)', () => {
  it('/duplicate clones the block + subtree via pasteBlocks anchored on the block', async () => {
    const { result } = renderHook(() => useSlashCommandStructural())
    const { ctx, pageStore } = makeSyntheticCtx()
    // Anchor the focused block plus one child so the serialized subtree is
    // non-empty (a leaf-only page would still serialize the single block).
    pageStore.setState({
      blocks: [
        makeBlock({ id: 'BLOCK_1', content: 'parent', parent_id: 'PAGE_1' }),
        makeBlock({ id: 'BLOCK_2', content: 'child', parent_id: 'BLOCK_1' }),
      ],
    })
    const pasteBlocks = vi.fn(async (_anchorId: string, _markdown: string) => [] as string[])
    pageStore.setState({ pasteBlocks })

    await result.current.exact['duplicate']?.(ctx, { id: 'duplicate', label: 'Duplicate' })

    expect(pasteBlocks).toHaveBeenCalledTimes(1)
    // Anchored on the focused block; the serialized subtree is the same
    // indented-markdown the context-menu Duplicate row + Ctrl+Shift+J binding
    // feed to pasteBlocks.
    expect(pasteBlocks).toHaveBeenCalledWith('BLOCK_1', expect.stringContaining('parent'))
  })

  it('/duplicate is a no-op when the focused block is gone (no pasteBlocks)', async () => {
    const { result } = renderHook(() => useSlashCommandStructural())
    const { ctx, pageStore } = makeSyntheticCtx()
    const pasteBlocks = vi.fn(async (_anchorId: string, _markdown: string) => [] as string[])
    pageStore.setState({ blocks: [], pasteBlocks })

    await result.current.exact['duplicate']?.(ctx, { id: 'duplicate', label: 'Duplicate' })

    expect(pasteBlocks).not.toHaveBeenCalled()
  })
})

describe('useSlashCommandStructural — turn into (#264)', () => {
  function setContent(
    pageStore: ReturnType<typeof makeSyntheticCtx>['pageStore'],
    content: string,
  ): void {
    // Mirror the heading tests above: `setState({ blocks })` funnels through
    // the store's `setWithBlocksById` wrapper, which rebuilds the `blocksById`
    // map that `readCurrentContent` reads from.
    pageStore.setState({
      blocks: pageStore.getState().blocks.map((b) => (b.id === 'BLOCK_1' ? { ...b, content } : b)),
    })
  }

  it.each([
    ['turn-h1', '# hello world'],
    ['turn-h2', '## hello world'],
    ['turn-h3', '### hello world'],
  ] as const)('%s converts a paragraph to the right heading level', async (id, expected) => {
    const { result } = renderHook(() => useSlashCommandStructural())
    const { ctx, pageStore } = makeSyntheticCtx()
    setContent(pageStore, 'hello world')
    const handler = result.current.prefix.find(([p]) => p === 'turn-')?.[1]
    expect(handler).toBeDefined()
    await handler?.(ctx, { id, label: id })
    expect(mockedInvoke).toHaveBeenCalledWith('edit_block', {
      blockId: 'BLOCK_1',
      toText: expected,
    })
  })

  it('turn-code wraps content in a fenced code block', async () => {
    const { result } = renderHook(() => useSlashCommandStructural())
    const { ctx, pageStore } = makeSyntheticCtx()
    setContent(pageStore, 'hello world')
    const handler = result.current.prefix.find(([p]) => p === 'turn-')?.[1]
    await handler?.(ctx, { id: 'turn-code', label: 'Code block' })
    expect(mockedInvoke).toHaveBeenCalledWith('edit_block', {
      blockId: 'BLOCK_1',
      toText: '```\nhello world\n```',
    })
  })

  it('the bare /turn parent is a no-op (no edit)', async () => {
    const { result } = renderHook(() => useSlashCommandStructural())
    const { ctx, pageStore } = makeSyntheticCtx()
    setContent(pageStore, 'hello world')
    await result.current.exact['turn']?.(ctx, { id: 'turn', label: 'Turn into' })
    expect(mockedInvoke).not.toHaveBeenCalledWith(
      'edit_block',
      expect.objectContaining({ blockId: 'BLOCK_1' }),
    )
  })

  it('turn-paragraph strips an existing heading marker', async () => {
    const { result } = renderHook(() => useSlashCommandStructural())
    const { ctx, pageStore } = makeSyntheticCtx()
    setContent(pageStore, '### a heading')
    const handler = result.current.prefix.find(([p]) => p === 'turn-')?.[1]
    await handler?.(ctx, { id: 'turn-paragraph', label: 'Text' })
    expect(mockedInvoke).toHaveBeenCalledWith('edit_block', {
      blockId: 'BLOCK_1',
      toText: 'a heading',
    })
  })

  it('turn-quote wraps content in a blockquote marker', async () => {
    const { result } = renderHook(() => useSlashCommandStructural())
    const { ctx, pageStore } = makeSyntheticCtx()
    setContent(pageStore, 'a thought')
    const handler = result.current.prefix.find(([p]) => p === 'turn-')?.[1]
    await handler?.(ctx, { id: 'turn-quote', label: 'Quote' })
    expect(mockedInvoke).toHaveBeenCalledWith('edit_block', {
      blockId: 'BLOCK_1',
      toText: '> a thought',
    })
  })

  it('turn-callout converts to an info callout', async () => {
    const { result } = renderHook(() => useSlashCommandStructural())
    const { ctx, pageStore } = makeSyntheticCtx()
    setContent(pageStore, 'important')
    const handler = result.current.prefix.find(([p]) => p === 'turn-')?.[1]
    await handler?.(ctx, { id: 'turn-callout', label: 'Callout' })
    expect(mockedInvoke).toHaveBeenCalledWith('edit_block', {
      blockId: 'BLOCK_1',
      toText: '> [!INFO] important',
    })
  })

  it('turn-numbered-list prepends an ordered-list marker', async () => {
    const { result } = renderHook(() => useSlashCommandStructural())
    const { ctx, pageStore } = makeSyntheticCtx()
    setContent(pageStore, 'first')
    const handler = result.current.prefix.find(([p]) => p === 'turn-')?.[1]
    await handler?.(ctx, { id: 'turn-numbered-list', label: 'Ordered list' })
    expect(mockedInvoke).toHaveBeenCalledWith('edit_block', {
      blockId: 'BLOCK_1',
      toText: '1. first',
    })
  })

  it('ignores an unknown turn- id (no edit)', async () => {
    const { result } = renderHook(() => useSlashCommandStructural())
    const { ctx } = makeSyntheticCtx()
    const handler = result.current.prefix.find(([p]) => p === 'turn-')?.[1]
    await handler?.(ctx, { id: 'turn-bogus', label: 'Bogus' })
    expect(mockedInvoke).not.toHaveBeenCalledWith(
      'edit_block',
      expect.objectContaining({ blockId: 'BLOCK_1' }),
    )
  })
})

describe('useSlashCommandStructural — editor inserts (link/tag/query/code/quote)', () => {
  it.each(['link', 'tag', 'code', 'quote'] as const)(
    'no-ops gracefully when ctx.rovingEditor.editor is null for /%s',
    (id) => {
      const { result } = renderHook(() => useSlashCommandStructural())
      const { ctx } = makeSyntheticCtx() // editor is null
      // We assert no throw rather than asserting editor commands; the editor
      // path is a thin chain wrapper that's exercised end-to-end in
      // BlockTree integration tests.
      expect(() => result.current.exact[id]?.(ctx, { id, label: id })).not.toThrow()
    },
  )

  it('/query opens the visual builder instead of inserting raw syntax (#215)', () => {
    const { result } = renderHook(() => useSlashCommandStructural())
    const { ctx, openQueryBuilder } = makeSyntheticCtx()
    result.current.exact['query']?.(ctx, { id: 'query', label: 'Query' })
    expect(openQueryBuilder).toHaveBeenCalledOnce()
  })

  it('/emoji opens the browse-grid picker instead of inserting text (#286)', () => {
    const { result } = renderHook(() => useSlashCommandStructural())
    const { ctx, openEmojiPicker } = makeSyntheticCtx()
    result.current.exact['emoji']?.(ctx, { id: 'emoji', label: 'Emoji' })
    expect(openEmojiPicker).toHaveBeenCalledOnce()
  })
})

describe('useSlashCommandStructural — table', () => {
  it('/table no-ops when editor is null (would call insertTable otherwise)', () => {
    const { result } = renderHook(() => useSlashCommandStructural())
    const { ctx } = makeSyntheticCtx()
    expect(() =>
      result.current.exact['table']?.(ctx, { id: 'table', label: 'Table' }),
    ).not.toThrow()
  })

  it('/table:4:6 prefixed handler parses dimensions and no-ops without editor', () => {
    const { result } = renderHook(() => useSlashCommandStructural())
    const { ctx } = makeSyntheticCtx()
    const handler = result.current.prefix.find(([p]) => p === 'table:')?.[1]
    expect(handler).toBeDefined()
    expect(() => handler?.(ctx, { id: 'table:4:6', label: 'Table 4×6' })).not.toThrow()
  })

  // #215 — header-row opt-out. Capture the `insertTable` options to assert the
  // `withHeaderRow` flag for both the default and the no-header variant.
  function ctxWithInsertTableSpy() {
    const insertTable = vi.fn(() => ({ run: vi.fn() }))
    const { ctx } = makeSyntheticCtx()
    ctx.rovingEditor.editor = {
      chain: () => ({ focus: () => ({ insertTable }) }),
    } as unknown as typeof ctx.rovingEditor.editor
    return { ctx, insertTable }
  }

  it('/table inserts a 3×3 table WITH a header row', () => {
    const { result } = renderHook(() => useSlashCommandStructural())
    const { ctx, insertTable } = ctxWithInsertTableSpy()
    result.current.exact['table']?.(ctx, { id: 'table', label: 'Table' })
    expect(insertTable).toHaveBeenCalledWith({ rows: 3, cols: 3, withHeaderRow: true })
  })

  it('/table-no-header inserts a 3×3 table WITHOUT a header row (#215)', () => {
    const { result } = renderHook(() => useSlashCommandStructural())
    const { ctx, insertTable } = ctxWithInsertTableSpy()
    result.current.exact['table-no-header']?.(ctx, {
      id: 'table-no-header',
      label: 'Table (no header)',
    })
    expect(insertTable).toHaveBeenCalledWith({ rows: 3, cols: 3, withHeaderRow: false })
  })
})

describe('useSlashCommandStructural — table identity', () => {
  it('returns a stable table identity across rerenders', () => {
    const { result, rerender } = renderHook(() => useSlashCommandStructural())
    const first = result.current
    rerender()
    expect(result.current).toBe(first)
  })

  it('exposes h1..h6 as exact handlers (not as a prefix)', () => {
    const { result } = renderHook(() => useSlashCommandStructural())
    for (let n = 1; n <= 6; n++) expect(result.current.exact[`h${n}`]).toBeDefined()
    // No `h` prefix entry — heading handling is fully exact.
    expect(result.current.prefix.find(([p]) => p === 'h')).toBeUndefined()
  })
})
