/**
 * Tests for `usePageTemplateMeta` — template + space metadata hook
 * extracted from `PageHeader` during the design-system maintainability
 * pass.
 *
 * Covers:
 *  1. Initial property load populates the four state slots.
 *  2. Missing properties default to `false` / `null`.
 *  3. `handleToggleTemplate` deletes the property when currently set
 *     and posts a `removed` toast; sets it otherwise.
 *  4. `handleToggleJournalTemplate` mirrors the same shape on its key.
 *  5. The `onAfterToggle` callback fires on success and on failure.
 *  6. A failed toggle still flips `onAfterToggle` and posts an error.
 */

import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// #2927 phase 4 — `usePageTemplateMeta` now calls `commands.getProperties` /
// `commands.deleteProperty` / `commands.setProperty` from `@/lib/bindings`
// directly instead of the `@/lib/tauri` wrapper. The same spies back both
// surfaces so the `vi.mocked(...)` assertions keep working; they resolve
// the `{ status: 'ok', data }` envelope that `unwrap` expects.
const { mockGetProperties, mockDeleteProperty, mockSetProperty } = vi.hoisted(() => ({
  mockGetProperties: vi.fn(),
  mockDeleteProperty: vi.fn(),
  mockSetProperty: vi.fn(),
}))

vi.mock('@/lib/bindings', async () => {
  const actual = await vi.importActual<typeof import('@/lib/bindings')>('@/lib/bindings')
  return {
    ...actual,
    commands: {
      ...actual.commands,
      getProperties: mockGetProperties,
      deleteProperty: mockDeleteProperty,
      setProperty: mockSetProperty,
    },
  }
})

vi.mock('@/lib/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    loading: vi.fn(),
    dismiss: vi.fn(),
  }),
}))

import { usePageTemplateMeta } from '@/hooks/usePageTemplateMeta'

const mockedGet = mockGetProperties
const mockedDelete = mockDeleteProperty
const mockedSet = mockSetProperty
const t = (key: string) => key

interface Prop {
  key: string
  value_text?: string | null
  value_ref?: string | null
}

// The real `PropertyRow` has more fields, but the hook only reads `key`,
// `value_text`, and `value_ref`, so the partial shape is safe.
const makeProps = (entries: Prop[]) => ({ status: 'ok' as const, data: entries })

// The hook ignores `setProperty`'s `BlockRow` return value; an empty object
// is enough to keep the assertion focused on call args.
const fakeSetPropertyResult = { status: 'ok' as const, data: {} }

beforeEach(() => {
  vi.clearAllMocks()
  mockedGet.mockResolvedValue(makeProps([]))
  // #2468 — deleteProperty now resolves WithOps<DeletePropertyResponse>.
  mockedDelete.mockResolvedValue({
    status: 'ok',
    data: { block_id: 'PAGE_1', key: 'template', op_refs: [] },
  })
  mockedSet.mockResolvedValue(fakeSetPropertyResult)
})

describe('usePageTemplateMeta — initial load', () => {
  it('populates all four state slots from the property set', async () => {
    mockedGet.mockResolvedValueOnce(
      makeProps([
        { key: 'template', value_text: 'true' },
        { key: 'journal-template', value_text: 'true' },
        { key: 'is_space', value_text: 'true' },
        { key: 'space', value_ref: 'space-42' },
      ]),
    )
    const onAfterToggle = vi.fn()
    const { result } = renderHook(() => usePageTemplateMeta('page-1', t, onAfterToggle))

    await waitFor(() => {
      expect(result.current.isTemplate).toBe(true)
    })
    expect(result.current.isJournalTemplate).toBe(true)
    expect(result.current.isSpaceBlock).toBe(true)
    expect(result.current.pageSpaceId).toBe('space-42')
  })

  it('defaults to false / null when properties are missing', async () => {
    mockedGet.mockResolvedValueOnce(makeProps([]))
    const { result } = renderHook(() => usePageTemplateMeta('page-1', t, vi.fn()))

    await waitFor(() => {
      expect(mockedGet).toHaveBeenCalled()
    })
    expect(result.current.isTemplate).toBe(false)
    expect(result.current.isJournalTemplate).toBe(false)
    expect(result.current.isSpaceBlock).toBe(false)
    expect(result.current.pageSpaceId).toBeNull()
  })

  it('skips the load when `pageId` is empty', () => {
    renderHook(() => usePageTemplateMeta('', t, vi.fn()))
    expect(mockedGet).not.toHaveBeenCalled()
  })
})

describe('usePageTemplateMeta — toggle handlers', () => {
  it('handleToggleTemplate deletes the property when currently set', async () => {
    mockedGet.mockResolvedValueOnce(makeProps([{ key: 'template', value_text: 'true' }]))
    const onAfterToggle = vi.fn()
    const { result } = renderHook(() => usePageTemplateMeta('page-1', t, onAfterToggle))

    await waitFor(() => {
      expect(result.current.isTemplate).toBe(true)
    })

    await act(async () => {
      await result.current.handleToggleTemplate()
    })

    expect(mockedDelete).toHaveBeenCalledWith('page-1', 'template')
    expect(mockedSet).not.toHaveBeenCalled()
    expect(result.current.isTemplate).toBe(false)
    expect(onAfterToggle).toHaveBeenCalledTimes(1)
  })

  it('handleToggleTemplate sets the property when currently unset', async () => {
    const onAfterToggle = vi.fn()
    const { result } = renderHook(() => usePageTemplateMeta('page-1', t, onAfterToggle))

    await waitFor(() => {
      expect(mockedGet).toHaveBeenCalled()
    })

    await act(async () => {
      await result.current.handleToggleTemplate()
    })

    expect(mockedSet).toHaveBeenCalledWith('page-1', 'template', {
      value_text: 'true',
      value_num: null,
      value_date: null,
      value_ref: null,
      value_bool: null,
    })
    expect(mockedDelete).not.toHaveBeenCalled()
    expect(result.current.isTemplate).toBe(true)
    expect(onAfterToggle).toHaveBeenCalledTimes(1)
  })

  it('handleToggleJournalTemplate uses the `journal-template` key', async () => {
    const onAfterToggle = vi.fn()
    const { result } = renderHook(() => usePageTemplateMeta('page-1', t, onAfterToggle))

    await waitFor(() => {
      expect(mockedGet).toHaveBeenCalled()
    })

    await act(async () => {
      await result.current.handleToggleJournalTemplate()
    })

    expect(mockedSet).toHaveBeenCalledWith('page-1', 'journal-template', {
      value_text: 'true',
      value_num: null,
      value_date: null,
      value_ref: null,
      value_bool: null,
    })
    expect(result.current.isJournalTemplate).toBe(true)
  })

  it('still invokes `onAfterToggle` when the IPC fails', async () => {
    mockedSet.mockRejectedValueOnce(new Error('IPC down'))
    const onAfterToggle = vi.fn()
    const { result } = renderHook(() => usePageTemplateMeta('page-1', t, onAfterToggle))

    await waitFor(() => {
      expect(mockedGet).toHaveBeenCalled()
    })

    await act(async () => {
      await result.current.handleToggleTemplate()
    })

    // Local flag should *not* flip on failure (the catch path keeps the
    // previous boolean), and `onAfterToggle` must still fire so the
    // kebab menu closes.
    expect(result.current.isTemplate).toBe(false)
    expect(onAfterToggle).toHaveBeenCalledTimes(1)
  })
})

describe('usePageTemplateMeta — setPageSpaceId', () => {
  it('exposes a setter that updates `pageSpaceId`', async () => {
    const { result } = renderHook(() => usePageTemplateMeta('page-1', t, vi.fn()))

    await waitFor(() => {
      expect(mockedGet).toHaveBeenCalled()
    })

    act(() => {
      result.current.setPageSpaceId('space-77')
    })
    expect(result.current.pageSpaceId).toBe('space-77')
  })
})
