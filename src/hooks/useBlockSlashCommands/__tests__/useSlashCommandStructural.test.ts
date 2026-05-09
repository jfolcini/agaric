/**
 * Structural slash commands: headings (h1..h6), callouts (default + per-type),
 * code/quote toggles, numbered list, divider, table (default + N×M), plus
 * the link/tag/query insert chains.
 */

import { invoke } from '@tauri-apps/api/core'
import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
  it.each([
    1, 2, 3, 4, 5, 6,
  ])('h%i prefixes existing content with the right hash count', async (n) => {
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
  })

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

  it('callout-warning prefixed handler picks up the type from the id', async () => {
    const { result } = renderHook(() => useSlashCommandStructural())
    const { ctx } = makeSyntheticCtx()
    ctx.pageStore.setState({
      blocks: ctx.pageStore
        .getState()
        .blocks.map((b) => (b.id === 'BLOCK_1' ? { ...b, content: 'careful' } : b)),
    })
    const handler = result.current.prefix.find(([p]) => p === 'callout-')?.[1]
    await handler?.(ctx, { id: 'callout-warning', label: 'Warning' })
    expect(mockedInvoke).toHaveBeenCalledWith('edit_block', {
      blockId: 'BLOCK_1',
      toText: '> [!WARNING] careful',
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

describe('useSlashCommandStructural — editor inserts (link/tag/query/code/quote)', () => {
  it.each([
    'link',
    'tag',
    'code',
    'quote',
    'query',
  ] as const)('no-ops gracefully when ctx.rovingEditor.editor is null for /%s', (id) => {
    const { result } = renderHook(() => useSlashCommandStructural())
    const { ctx } = makeSyntheticCtx() // editor is null
    // We assert no throw rather than asserting editor commands; the editor
    // path is a thin chain wrapper that's exercised end-to-end in
    // BlockTree integration tests.
    expect(() => result.current.exact[id]?.(ctx, { id, label: id })).not.toThrow()
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
