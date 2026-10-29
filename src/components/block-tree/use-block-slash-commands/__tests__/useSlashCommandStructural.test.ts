/**
 * Structural slash commands: headings (h1..h6), callouts (default + per-type),
 * code/quote toggles, numbered list, divider, table (opens the size grid), plus
 * the link/tag/query insert chains.
 */

import type { InvokeArgs } from '@tauri-apps/api/core'
import { invoke } from '@tauri-apps/api/core'
import { renderHook, waitFor } from '@testing-library/react'
import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { makeBlockRow } from '@/__tests__/fixtures'
import { makeSyntheticCtx } from '@/components/block-tree/use-block-slash-commands/__tests__/test-utils'
import { useSlashCommandStructural } from '@/components/block-tree/use-block-slash-commands/useSlashCommandStructural'
import { registerActiveDraftFlush } from '@/lib/active-draft-flush'
import type { PropertyRow } from '@/lib/bindings'
import {
  _resetGraphStructureEventsForTest,
  getGraphStructureKey,
} from '@/lib/graph-structure-events'
import { listStyleFromRows, setListStyle } from '@/lib/list-style'
import { dispatch } from '@/lib/tauri-mock/handlers'
import { SEED_IDS, seedBlocks } from '@/lib/tauri-mock/seed'
import { useSpaceStore } from '@/stores/space'
import { useUndoStore } from '@/stores/undo'

vi.mock('@/lib/announcer', () => ({ announce: vi.fn() }))
vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock('@/editor/markdown-serializer', () => ({
  serialize: vi.fn(() => 'serialized'),
}))
// #4552 slice 2 — `setListStyle` is a real IPC-backed write (`setProperty`);
// stub it so these tests exercise ONLY the dispatch wiring, not the property
// IPC path (already covered by `list-style.test.ts`). `listStyleForBlockType`
// stays real (a pure function).
vi.mock('@/lib/list-style', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/list-style')>()
  return { ...actual, setListStyle: vi.fn().mockResolvedValue([]) }
})

const mockedInvoke = vi.mocked(invoke)
const mockedSetListStyle = vi.mocked(setListStyle)
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
  // A `…Once` stub a test leaves unconsumed would otherwise answer the next test's call.
  mockedSetListStyle.mockReset().mockResolvedValue([])
  // #2468 — `edit_block` (the applyContentEdit backbone) resolves a `WithOps`
  // envelope; give it a wire-faithful default so the undo-ref capture path is
  // exercised instead of tripping on an `undefined` response.
  mockedInvoke.mockImplementation(async (cmd: string) => {
    if (cmd === 'edit_block') {
      return { id: 'BLOCK_1', content: '', op_refs: [{ device_id: 'dev1', seq: 3 }] }
    }
    return undefined
  })
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
          .blocks.map((b) =>
            b.id === 'BLOCK_1' ? Object.assign({}, b, { content: 'plain text' }) : b,
          ),
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
        .blocks.map((b) =>
          b.id === 'BLOCK_1' ? Object.assign({}, b, { content: '### already-h3' }) : b,
        ),
    })
    await result.current.exact['h1']?.(ctx, { id: 'h1', label: 'Heading 1' })
    expect(mockedInvoke).toHaveBeenCalledWith('edit_block', {
      blockId: 'BLOCK_1',
      toText: '# already-h3',
    })
  })

  it('heading slash command notifies undo', async () => {
    const onNewAction = vi.fn()
    useUndoStore.setState({ ...useUndoStore.getState(), onNewAction })
    const { result } = renderHook(() => useSlashCommandStructural())
    const { ctx } = makeSyntheticCtx()
    await result.current.exact['h1']?.(ctx, { id: 'h1', label: 'Heading 1' })
    // #2468 — the edit's captured op_refs ride along for ref-addressed undo.
    expect(onNewAction).toHaveBeenCalledWith('PAGE_1', [{ device_id: 'dev1', seq: 3 }])
  })

  // #4963 — `applyContentEdit` writes through the command and patches the
  // store by hand, so it never reaches the reducer that bumps the counter. The
  // rewritten content is what the graph's edges and the reference panels are
  // derived from, and every structural slash command goes through it.
  it('a content-rewriting slash command bumps the graph-structure counter', async () => {
    const { result } = renderHook(() => useSlashCommandStructural())
    const { ctx } = makeSyntheticCtx()
    _resetGraphStructureEventsForTest()
    await result.current.exact['h1']?.(ctx, { id: 'h1', label: 'Heading 1' })

    await waitFor(() => expect(getGraphStructureKey()).toBe(1))
  })
})

describe('useSlashCommandStructural — callouts, and the list style they and headings clear', () => {
  it('/callout uses the info type', async () => {
    const { result } = renderHook(() => useSlashCommandStructural())
    const { ctx } = makeSyntheticCtx()
    ctx.pageStore.setState({
      blocks: ctx.pageStore
        .getState()
        .blocks.map((b) =>
          b.id === 'BLOCK_1' ? Object.assign({}, b, { content: 'note-text' }) : b,
        ),
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
        .blocks.map((b) => (b.id === 'BLOCK_1' ? Object.assign({}, b, { content: 'careful' }) : b)),
    })
    const handler = result.current.prefix.find(([p]) => p === 'callout-')?.[1]
    expect(handler).toBeDefined()
    await handler?.(ctx, { id, label: id })
    expect(mockedInvoke).toHaveBeenCalledWith('edit_block', {
      blockId: 'BLOCK_1',
      toText: expected,
    })
  })

  // A heading or a callout is not a list: like every Turn into target but the two
  // lists, it drops a bulleted block's `listStyle`, read back here from the mock
  // backend. `/code` and `/quote` are pinned in the edge-case file, on a real editor.
  it.each(['h1', 'h2', 'h6', 'callout', 'callout-warning'])(
    '%s clears the block’s list style',
    async (id) => {
      seedBlocks()
      mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => dispatch(cmd, args))
      const actual = await vi.importActual<typeof import('@/lib/list-style')>('@/lib/list-style')
      mockedSetListStyle.mockImplementationOnce(actual.setListStyle)
      const blockId = SEED_IDS.BLOCK_GS_1
      await actual.setListStyle(blockId, 'bullet')
      const styleOf = () =>
        listStyleFromRows(dispatch('get_properties', { blockId }) as PropertyRow[])
      expect(styleOf()).toBe('bullet')

      const { result } = renderHook(() => useSlashCommandStructural())
      const { ctx } = makeSyntheticCtx({ blockId })
      const handler =
        result.current.exact[id] ?? result.current.prefix.find(([p]) => p === 'callout-')?.[1]
      await handler?.(ctx, { id, label: id })

      expect(styleOf()).toBe('none')
      expect(toast.error).not.toHaveBeenCalled()
    },
  )

  // A refused `edit_block` leaves the block as it was: still a list, and told once.
  it.each([
    ['h1', 'blockTree.setHeadingFailed'],
    ['callout', 'slash.calloutFailed'],
    ['callout-warning', 'slash.calloutFailed'],
    ['turn-paragraph', 'slash.turnIntoFailed'],
  ])('%s keeps the list style when the edit is refused', async (id, failKey) => {
    seedBlocks()
    mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => {
      if (cmd === 'edit_block') throw new Error('refused')
      return dispatch(cmd, args)
    })
    const actual = await vi.importActual<typeof import('@/lib/list-style')>('@/lib/list-style')
    mockedSetListStyle.mockImplementation(actual.setListStyle)
    const blockId = SEED_IDS.BLOCK_GS_1
    await actual.setListStyle(blockId, 'bullet')
    const styleOf = () =>
      listStyleFromRows(dispatch('get_properties', { blockId }) as PropertyRow[])

    const { result } = renderHook(() => useSlashCommandStructural())
    const { ctx } = makeSyntheticCtx({ blockId })
    const handler =
      result.current.exact[id] ?? result.current.prefix.find(([p]) => id.startsWith(p))?.[1]
    await handler?.(ctx, { id, label: id })

    expect(styleOf()).toBe('bullet')
    expect(toast.error).toHaveBeenCalledTimes(1)
    expect(toast.error).toHaveBeenCalledWith(failKey)
  })

  it('/h2 toasts once when clearing the list style fails', async () => {
    mockedSetListStyle.mockRejectedValueOnce(new Error('boom'))
    const { result } = renderHook(() => useSlashCommandStructural())
    const { ctx } = makeSyntheticCtx()

    await result.current.exact['h2']?.(ctx, { id: 'h2', label: 'H2' })

    expect(mockedInvoke).toHaveBeenCalledWith('edit_block', {
      blockId: 'BLOCK_1',
      toText: '## hello',
    })
    expect(toast.error).toHaveBeenCalledTimes(1)
    expect(toast.error).toHaveBeenCalledWith('blockTree.clearListStyleFailed')
  })

  it('/callout toasts once when clearing the list style fails', async () => {
    mockedSetListStyle.mockRejectedValueOnce(new Error('boom'))
    const { result } = renderHook(() => useSlashCommandStructural())
    const { ctx } = makeSyntheticCtx()

    await result.current.exact['callout']?.(ctx, { id: 'callout', label: 'Callout' })

    expect(mockedInvoke).toHaveBeenCalledWith('edit_block', {
      blockId: 'BLOCK_1',
      toText: '> [!INFO] hello',
    })
    expect(toast.error).toHaveBeenCalledTimes(1)
    expect(toast.error).toHaveBeenCalledWith('slash.calloutFailed')
  })
})

describe('useSlashCommandStructural — list, divider (#4552 slice 2)', () => {
  // `/numbered-list` and `/bullet-list` now set the `listStyle` block
  // property instead of prepending a `1. ` / `- ` markdown marker — the
  // marker is drawn from that property (`ListMarker.tsx`), not from content.
  it('numbered-list sets listStyle=ordered and does NOT edit content', async () => {
    const { result } = renderHook(() => useSlashCommandStructural())
    const { ctx } = makeSyntheticCtx()
    ctx.pageStore.setState({
      blocks: ctx.pageStore
        .getState()
        .blocks.map((b) => (b.id === 'BLOCK_1' ? Object.assign({}, b, { content: 'item' }) : b)),
    })
    await result.current.exact['numbered-list']?.(ctx, {
      id: 'numbered-list',
      label: 'Numbered list',
    })
    expect(mockedSetListStyle).toHaveBeenCalledWith('BLOCK_1', 'ordered')
    expect(mockedInvoke).not.toHaveBeenCalledWith(
      'edit_block',
      expect.objectContaining({ blockId: 'BLOCK_1' }),
    )
  })

  it('bullet-list sets listStyle=bullet and does NOT edit content', async () => {
    const { result } = renderHook(() => useSlashCommandStructural())
    const { ctx } = makeSyntheticCtx()
    await result.current.exact['bullet-list']?.(ctx, { id: 'bullet-list', label: 'Bullet list' })
    expect(mockedSetListStyle).toHaveBeenCalledWith('BLOCK_1', 'bullet')
    expect(mockedInvoke).not.toHaveBeenCalledWith(
      'edit_block',
      expect.objectContaining({ blockId: 'BLOCK_1' }),
    )
  })

  // A heading shows no bullet or number, so a list style stored on it is one nobody
  // sees: the command makes it a list paragraph, as Turn into does. Read back from
  // the mock backend.
  it.each([
    ['bullet-list', 'bullet'],
    ['numbered-list', 'ordered'],
  ] as const)('%s on a heading makes it a paragraph styled %s', async (id, style) => {
    seedBlocks()
    mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => dispatch(cmd, args))
    const actual = await vi.importActual<typeof import('@/lib/list-style')>('@/lib/list-style')
    mockedSetListStyle.mockImplementation(actual.setListStyle)
    const blockId = SEED_IDS.BLOCK_GS_1
    dispatch('edit_block', { blockId, toText: '# Title' })

    const { result } = renderHook(() => useSlashCommandStructural())
    const { ctx } = makeSyntheticCtx({
      blockId,
      blocks: [{ id: blockId, content: '# Title', parent_id: 'PAGE_1' }],
    })
    await result.current.exact[id]?.(ctx, { id, label: id })

    expect((dispatch('get_block', { blockId }) as { content: string }).content).toBe('Title')
    expect(listStyleFromRows(dispatch('get_properties', { blockId }) as PropertyRow[])).toBe(style)
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('numbered-list reports the failure toast when setListStyle rejects', async () => {
    mockedSetListStyle.mockRejectedValueOnce(new Error('boom'))
    const { result } = renderHook(() => useSlashCommandStructural())
    const { ctx } = makeSyntheticCtx()
    // Must not throw — the handler catches and reports via `notify.error`.
    await expect(
      result.current.exact['numbered-list']?.(ctx, { id: 'numbered-list', label: 'Numbered list' }),
    ).resolves.toBeUndefined()
  })

  // #4577 — the PAIR; `handleListStyle`'s docblock is the defect.
  //
  // Both halves have to be asserted together: asserting only `setListStyle`
  // passes on the broken code, and asserting only the content passes on a
  // handler that flushed and then forgot to write the style. The registration
  // below stands in for `useDebouncedContentCommit`'s (the synthetic ctx has
  // no live TipTap instance): it is the same `registerActiveDraftFlush`
  // bridge, committing through the page store's `edit` as the real one does.
  it('flushes the pending in-editor content before writing listStyle (#4577)', async () => {
    mockedInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === 'edit_block') {
        return {
          id: 'BLOCK_1',
          content: (args as { toText: string }).toText,
          op_refs: [{ device_id: 'dev1', seq: 4 }],
        }
      }
      return undefined
    })
    const { result } = renderHook(() => useSlashCommandStructural())
    const { ctx, pageStore } = makeSyntheticCtx()
    const unregister = registerActiveDraftFlush('BLOCK_1', async () => {
      await pageStore.getState().edit('BLOCK_1', 'typed but uncommitted')
    })
    try {
      await result.current.exact['numbered-list']?.(ctx, {
        id: 'numbered-list',
        label: 'Numbered list',
      })
    } finally {
      unregister()
    }

    // Re-read the store rather than asserting the call shape: this is the
    // content a subsequent Discard would leave behind.
    expect(pageStore.getState().blocksById.get('BLOCK_1')?.content).toBe('typed but uncommitted')
    expect(mockedSetListStyle).toHaveBeenCalledWith('BLOCK_1', 'ordered')
  })

  it('divider replaces content with `---`', async () => {
    const { result } = renderHook(() => useSlashCommandStructural())
    const { ctx } = makeSyntheticCtx()
    await result.current.exact['divider']?.(ctx, { id: 'divider', label: 'Divider' })
    expect(mockedInvoke).toHaveBeenCalledWith('edit_block', { blockId: 'BLOCK_1', toText: '---' })
  })
})

describe('useSlashCommandStructural — duplicate (#976 item 13)', () => {
  /**
   * A backend that copies whatever `edit_block` last stored for BLOCK_1 and
   * serves both rows back through `load_page_subtree`, so each test reads the
   * copy out of the reloaded store.
   */
  function stubDuplicateBackend(initial: string): void {
    let stored = initial
    let copied: string | null = null
    const row = (id: string, content: string, position: number) =>
      makeBlockRow({ id, content, parent_id: 'PAGE_1', position })
    mockedInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
      const a = (args ?? {}) as Record<string, unknown>
      if (cmd === 'edit_block') {
        stored = a['toText'] as string
        return { id: 'BLOCK_1', content: stored, op_refs: [{ device_id: 'dev1', seq: 5 }] }
      }
      if (cmd === 'duplicate_block') {
        copied = stored
        return {
          op_refs: [{ device_id: 'dev1', seq: 6 }],
          blocks: [row('BLOCK_1_COPY', copied, 2)],
        }
      }
      if (cmd === 'load_page_subtree') {
        const rows = [
          row('BLOCK_1', stored, 1),
          ...(copied === null ? [] : [row('BLOCK_1_COPY', copied, 2)]),
        ]
        return { blocks: rows, truncated: false, total: rows.length }
      }
      return undefined
    })
  }

  beforeEach(() => {
    useSpaceStore.setState({ currentSpaceId: 'SPACE_TEST' })
  })

  it('/duplicate copies the block through duplicate_block and reloads the copy', async () => {
    stubDuplicateBackend('hello')
    const { result } = renderHook(() => useSlashCommandStructural())
    const { ctx, pageStore } = makeSyntheticCtx()

    await result.current.exact['duplicate']?.(ctx, { id: 'duplicate', label: 'Duplicate' })

    expect(mockedInvoke).toHaveBeenCalledWith('duplicate_block', { blockId: 'BLOCK_1' })
    expect(pageStore.getState().blocks.map((b) => [b.id, b.content])).toEqual([
      ['BLOCK_1', 'hello'],
      ['BLOCK_1_COPY', 'hello'],
    ])
  })

  // #4577 — same family as `handleListStyle` above: the backend copies the
  // STORED row, so the flush has to land BEFORE `duplicate_block` runs. The
  // copy's content (not a call order) is what proves it: a flush that ran
  // after the command would still copy the pre-typing content.
  it('flushes the pending in-editor content before duplicating (#4577)', async () => {
    stubDuplicateBackend('hello')
    const { result } = renderHook(() => useSlashCommandStructural())
    const { ctx, pageStore } = makeSyntheticCtx()
    // Stands in for `useDebouncedContentCommit`'s registration (the synthetic
    // ctx has no live TipTap instance) — same bridge, same store `edit`.
    const unregister = registerActiveDraftFlush('BLOCK_1', async () => {
      await pageStore.getState().edit('BLOCK_1', 'typed but uncommitted')
    })
    try {
      await result.current.exact['duplicate']?.(ctx, { id: 'duplicate', label: 'Duplicate' })
    } finally {
      unregister()
    }

    expect(pageStore.getState().blocksById.get('BLOCK_1_COPY')?.content).toBe(
      'typed but uncommitted',
    )
  })

  it('/duplicate is a no-op when the focused block is gone (no IPC)', async () => {
    stubDuplicateBackend('hello')
    const { result } = renderHook(() => useSlashCommandStructural())
    const { ctx, pageStore } = makeSyntheticCtx()
    pageStore.setState({ blocks: [] })

    await result.current.exact['duplicate']?.(ctx, { id: 'duplicate', label: 'Duplicate' })

    expect(mockedInvoke).not.toHaveBeenCalled()
    expect(pageStore.getState().blocks).toEqual([])
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
      blocks: pageStore
        .getState()
        .blocks.map((b) => (b.id === 'BLOCK_1' ? Object.assign({}, b, { content }) : b)),
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

  // #4552 slice 2 — Turn-into no longer prepends a markdown marker for the
  // two list targets: content stays bare, and the `listStyle` property
  // carries the list-ness instead (`listStyleForBlockType`).
  it('turn-numbered-list leaves content bare and sets listStyle=ordered', async () => {
    const { result } = renderHook(() => useSlashCommandStructural())
    const { ctx, pageStore } = makeSyntheticCtx()
    setContent(pageStore, 'first')
    const handler = result.current.prefix.find(([p]) => p === 'turn-')?.[1]
    await handler?.(ctx, { id: 'turn-numbered-list', label: 'Ordered list' })
    expect(mockedInvoke).toHaveBeenCalledWith('edit_block', {
      blockId: 'BLOCK_1',
      toText: 'first',
    })
    expect(mockedSetListStyle).toHaveBeenCalledWith('BLOCK_1', 'ordered')
  })

  it('turn-bullet-list leaves content bare and sets listStyle=bullet', async () => {
    const { result } = renderHook(() => useSlashCommandStructural())
    const { ctx, pageStore } = makeSyntheticCtx()
    setContent(pageStore, 'first')
    const handler = result.current.prefix.find(([p]) => p === 'turn-')?.[1]
    await handler?.(ctx, { id: 'turn-bullet-list', label: 'Bullet list' })
    expect(mockedInvoke).toHaveBeenCalledWith('edit_block', {
      blockId: 'BLOCK_1',
      toText: 'first',
    })
    expect(mockedSetListStyle).toHaveBeenCalledWith('BLOCK_1', 'bullet')
  })

  it('turn-paragraph clears listStyle (converting AWAY from a list)', async () => {
    const { result } = renderHook(() => useSlashCommandStructural())
    const { ctx, pageStore } = makeSyntheticCtx()
    setContent(pageStore, 'first')
    const handler = result.current.prefix.find(([p]) => p === 'turn-')?.[1]
    await handler?.(ctx, { id: 'turn-paragraph', label: 'Text' })
    expect(mockedSetListStyle).toHaveBeenCalledWith('BLOCK_1', 'none')
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

  it('/query opens the visual builder instead of inserting raw syntax (#215)', async () => {
    const { result } = renderHook(() => useSlashCommandStructural())
    const { ctx, openQueryBuilder } = makeSyntheticCtx()
    await result.current.exact['query']?.(ctx, { id: 'query', label: 'Query' })
    expect(openQueryBuilder).toHaveBeenCalledOnce()
  })

  it('/emoji opens the browse-grid picker instead of inserting text (#286)', async () => {
    const { result } = renderHook(() => useSlashCommandStructural())
    const { ctx, openEmojiPicker } = makeSyntheticCtx()
    await result.current.exact['emoji']?.(ctx, { id: 'emoji', label: 'Emoji' })
    expect(openEmojiPicker).toHaveBeenCalledOnce()
  })
})

describe('useSlashCommandStructural — table', () => {
  it('/table opens the size grid instead of inserting a table', async () => {
    const { result } = renderHook(() => useSlashCommandStructural())
    const { ctx, openTablePicker } = makeSyntheticCtx()
    const chain = vi.fn()
    ctx.rovingEditor.editor = { chain } as unknown as typeof ctx.rovingEditor.editor
    await result.current.exact['table']?.(ctx, { id: 'table', label: 'Table' })
    expect(openTablePicker).toHaveBeenCalledOnce()
    expect(chain).not.toHaveBeenCalled()
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
