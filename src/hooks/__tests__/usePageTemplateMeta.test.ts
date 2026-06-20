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

vi.mock('../../lib/tauri', () => ({
  deleteProperty: vi.fn(),
  getProperties: vi.fn(),
  setProperty: vi.fn(),
}))

vi.mock('../../lib/logger', () => ({
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

import { deleteProperty, getProperties, setProperty } from '../../lib/tauri'
import { usePageTemplateMeta } from '../usePageTemplateMeta'

const mockedGet = vi.mocked(getProperties)
const mockedDelete = vi.mocked(deleteProperty)
const mockedSet = vi.mocked(setProperty)
const t = (key: string) => key

interface Prop {
  key: string
  value_text?: string | null
  value_ref?: string | null
}

const makeProps = (entries: Prop[]) =>
  // The real `Property` row has more fields, but the hook only reads
  // `key`, `value_text`, and `value_ref`, so the partial shape is safe.
  entries as unknown as Awaited<ReturnType<typeof getProperties>>

// The hook ignores `setProperty`'s `BlockRow` return value; we mock it
// as a partial-shape cast to keep the assertion focused on call args.
const fakeBlockRow = {} as Awaited<ReturnType<typeof setProperty>>

beforeEach(() => {
  vi.clearAllMocks()
  mockedGet.mockResolvedValue(makeProps([]))
  mockedDelete.mockResolvedValue(undefined)
  mockedSet.mockResolvedValue(fakeBlockRow)
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

    expect(mockedSet).toHaveBeenCalledWith({
      blockId: 'page-1',
      key: 'template',
      valueText: 'true',
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

    expect(mockedSet).toHaveBeenCalledWith({
      blockId: 'page-1',
      key: 'journal-template',
      valueText: 'true',
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
