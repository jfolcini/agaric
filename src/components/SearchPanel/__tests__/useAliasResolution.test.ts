/**
 * Tests for useAliasResolution (D-3).
 *
 * Validates:
 *  - Empty/whitespace query returns null + ''.
 *  - Successful alias resolve → fetches the block and returns it.
 *  - Alias matching an existing FTS result is suppressed.
 *  - getBlock failure resets to null.
 *  - resolvePageByAlias rejection logs + resets to null.
 *  - currentSpaceId is threaded into the IPC.
 *  - Empty query after a match clears state.
 *
 * NOTE: every test uses `mockResolvedValue` (persistent) rather than
 * `mockResolvedValueOnce` so a re-fired effect (e.g. when React 19
 * StrictMode double-invokes effects in test mode, or when a parent
 * passes a fresh `results` array reference) does not exhaust the
 * mock queue and crash the hook with "Cannot read properties of
 * undefined (reading 'then')". Stable `results` references are also
 * declared at module scope so the effect dep stays referentially
 * stable across renders.
 */

import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../lib/tauri', () => ({
  resolvePageByAlias: vi.fn(),
  getBlock: vi.fn(),
}))

vi.mock('../../../lib/logger', () => ({
  logger: {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}))

import { logger } from '../../../lib/logger'
import { type BlockRow, getBlock, resolvePageByAlias } from '../../../lib/tauri'
import { useAliasResolution } from '../useAliasResolution'

const mockedResolveAlias = vi.mocked(resolvePageByAlias)
const mockedGetBlock = vi.mocked(getBlock)

function makeBlock(overrides: Partial<BlockRow> = {}): BlockRow {
  return {
    id: 'BLOCK_A',
    block_type: 'page',
    content: 'Apollo',
    parent_id: null,
    page_id: null,
    position: 0,
    deleted_at: null,
    todo_state: null,
    priority: null,
    due_date: null,
    scheduled_date: null,
    ...overrides,
  }
}

// Module-level stable references — keep `results` referentially stable
// across renders so the effect's `[query, results, currentSpaceId]`
// dep array doesn't refire on each render.
const EMPTY_RESULTS: BlockRow[] = []

beforeEach(() => {
  vi.clearAllMocks()
})

describe('useAliasResolution', () => {
  it('returns null + "" when the query is empty', () => {
    const { result } = renderHook(() => useAliasResolution('', EMPTY_RESULTS, 'SPACE_A'))
    expect(result.current.aliasMatch).toBeNull()
    expect(result.current.aliasQuery).toBe('')
    expect(mockedResolveAlias).not.toHaveBeenCalled()
  })

  it('returns null + "" when the query is whitespace only', () => {
    const { result } = renderHook(() => useAliasResolution('   ', EMPTY_RESULTS, 'SPACE_A'))
    expect(result.current.aliasMatch).toBeNull()
    expect(result.current.aliasQuery).toBe('')
    expect(mockedResolveAlias).not.toHaveBeenCalled()
  })

  it('resolves a matching alias to a BlockRow', async () => {
    mockedResolveAlias.mockResolvedValue(['BLOCK_A', 'apollo'])
    const block = makeBlock({ id: 'BLOCK_A', content: 'Apollo' })
    mockedGetBlock.mockResolvedValue(block)

    const { result } = renderHook(() => useAliasResolution('apollo', EMPTY_RESULTS, 'SPACE_A'))

    await waitFor(() => {
      expect(result.current.aliasMatch).toEqual(block)
    })
    expect(result.current.aliasQuery).toBe('apollo')
    expect(mockedResolveAlias).toHaveBeenCalledWith({
      alias: 'apollo',
      spaceId: 'SPACE_A',
    })
    expect(mockedGetBlock).toHaveBeenCalledWith('BLOCK_A')
  })

  it('passes a null spaceId through', async () => {
    mockedResolveAlias.mockResolvedValue(null)

    renderHook(() => useAliasResolution('apollo', EMPTY_RESULTS, null))

    await waitFor(() => {
      expect(mockedResolveAlias).toHaveBeenCalledWith({
        alias: 'apollo',
        spaceId: null,
      })
    })
  })

  it('returns null when resolvePageByAlias yields null', async () => {
    mockedResolveAlias.mockResolvedValue(null)

    const { result } = renderHook(() => useAliasResolution('nope', EMPTY_RESULTS, 'SPACE_A'))

    await waitFor(() => {
      expect(mockedResolveAlias).toHaveBeenCalled()
    })
    expect(result.current.aliasMatch).toBeNull()
    expect(result.current.aliasQuery).toBe('')
    expect(mockedGetBlock).not.toHaveBeenCalled()
  })

  it('suppresses the alias when the matched id is already in results', async () => {
    mockedResolveAlias.mockResolvedValue(['BLOCK_A', 'apollo'])
    const existing = makeBlock({ id: 'BLOCK_A' })
    const stableResults = [existing]

    const { result } = renderHook(() => useAliasResolution('apollo', stableResults, 'SPACE_A'))

    await waitFor(() => {
      expect(mockedResolveAlias).toHaveBeenCalled()
    })
    // Suppression is now a render-time derive (a changing
    // `results` array no longer re-fires the alias IPC). The card is
    // still hidden when the resolved page is already in results;
    // whether getBlock ran is an implementation detail.
    expect(result.current.aliasMatch).toBeNull()
    expect(result.current.aliasQuery).toBe('')
  })

  it('resets to null when getBlock fails', async () => {
    mockedResolveAlias.mockResolvedValue(['BLOCK_A', 'apollo'])
    mockedGetBlock.mockRejectedValue(new Error('not found'))

    const { result } = renderHook(() => useAliasResolution('apollo', EMPTY_RESULTS, 'SPACE_A'))

    await waitFor(() => {
      expect(mockedGetBlock).toHaveBeenCalled()
    })
    // Give the catch handler a tick to run.
    await Promise.resolve()
    expect(result.current.aliasMatch).toBeNull()
    expect(result.current.aliasQuery).toBe('')
  })

  it('logs and resets when resolvePageByAlias rejects', async () => {
    const err = new Error('transport failed')
    mockedResolveAlias.mockRejectedValue(err)

    const { result } = renderHook(() => useAliasResolution('apollo', EMPTY_RESULTS, 'SPACE_A'))

    await waitFor(() => {
      // CR9: the raw query is intentionally NOT logged (log hygiene);
      // the context arg is now `undefined`.
      expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
        'SearchPanel',
        'alias resolution failed',
        undefined,
        err,
      )
    })
    expect(result.current.aliasMatch).toBeNull()
    expect(result.current.aliasQuery).toBe('')
  })

  // Issue #106 — `not_found` from the resolver is the expected empty
  // state (the alias points at a deleted / non-existent page). The
  // hook MUST treat it as "no match", not as a system error: state
  // resets to null AND the warn log stays quiet (no toast either,
  // since this hook never emits one).
  it('treats kind="not_found" as an empty state — no warn log, state cleared', async () => {
    mockedResolveAlias.mockRejectedValue({ kind: 'not_found', message: 'no such alias' })

    const { result } = renderHook(() =>
      useAliasResolution('does-not-exist', EMPTY_RESULTS, 'SPACE_A'),
    )

    await waitFor(() => {
      expect(mockedResolveAlias).toHaveBeenCalled()
    })
    // Give the catch handler a tick to run.
    await Promise.resolve()
    expect(result.current.aliasMatch).toBeNull()
    expect(result.current.aliasQuery).toBe('')
    // The warn log path is reserved for unexpected transport failures —
    // a not_found is the regular "alias points nowhere" path and must
    // not be logged at warn level.
    expect(vi.mocked(logger.warn)).not.toHaveBeenCalled()
  })

  it('clears state when the query becomes empty after a match', async () => {
    mockedResolveAlias.mockResolvedValue(['BLOCK_A', 'apollo'])
    mockedGetBlock.mockResolvedValue(makeBlock({ id: 'BLOCK_A' }))

    const { result, rerender } = renderHook(
      ({ q }: { q: string }) => useAliasResolution(q, EMPTY_RESULTS, 'SPACE_A'),
      { initialProps: { q: 'apollo' } },
    )

    await waitFor(() => {
      expect(result.current.aliasMatch?.id).toBe('BLOCK_A')
    })

    rerender({ q: '' })
    await waitFor(() => {
      expect(result.current.aliasMatch).toBeNull()
      expect(result.current.aliasQuery).toBe('')
    })
  })
})
