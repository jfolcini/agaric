/**
 * Tests for `usePageTemplateMeta` — template metadata hook
 * extracted from `PageHeader` during the design-system maintainability
 * pass.
 *
 * Covers:
 *  1. Initial property load populates the three state slots.
 *  2. Missing properties default to `false`.
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
// directly instead of the hand-written wrapper. The same spies back both
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
import { recordBlockPropertyChange } from '@/lib/block-property-events'
import { dispatch } from '@/lib/tauri-mock/handlers'
import { SEED_IDS, seedBlocks } from '@/lib/tauri-mock/seed'

const mockedGet = mockGetProperties
const mockedDelete = mockDeleteProperty
const mockedSet = mockSetProperty
const t = (key: string) => key

interface Prop {
  key: string
  value_text?: string | null
}

// The real `PropertyRow` has more fields, but the hook only reads `key` and
// `value_text`, so the partial shape is safe.
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
  it('populates all three state slots from the property set', async () => {
    mockedGet.mockResolvedValueOnce(
      makeProps([
        { key: 'template', value_text: 'true' },
        { key: 'journal-template', value_text: 'true' },
        { key: 'is_space', value_text: 'true' },
      ]),
    )
    const onAfterToggle = vi.fn()
    const { result } = renderHook(() => usePageTemplateMeta('page-1', t, onAfterToggle))

    await waitFor(() => {
      expect(result.current.isTemplate).toBe(true)
    })
    expect(result.current.isJournalTemplate).toBe(true)
    expect(result.current.isSpaceBlock).toBe(true)
  })

  it('defaults to false when properties are missing', async () => {
    mockedGet.mockResolvedValueOnce(makeProps([]))
    const { result } = renderHook(() => usePageTemplateMeta('page-1', t, vi.fn()))

    await waitFor(() => {
      expect(mockedGet).toHaveBeenCalled()
    })
    expect(result.current.isTemplate).toBe(false)
    expect(result.current.isJournalTemplate).toBe(false)
    expect(result.current.isSpaceBlock).toBe(false)
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

// #5287 — a synced device or an MCP agent can toggle `template` on the open
// page; the flag must follow, or the next click writes a no-op.
describe('usePageTemplateMeta — property changes made elsewhere', () => {
  it('re-reads the flags from the backend when a property event lands', async () => {
    seedBlocks()
    const pageId = SEED_IDS.PAGE_QUICK_NOTES
    mockedGet.mockImplementation(async (blockId: string) => ({
      status: 'ok' as const,
      data: dispatch('get_properties', { blockId }),
    }))
    const { result } = renderHook(() => usePageTemplateMeta(pageId, t, vi.fn()))
    await waitFor(() => {
      expect(mockedGet).toHaveBeenCalledTimes(1)
    })
    expect(result.current.isTemplate).toBe(false)

    dispatch('set_property', {
      blockId: pageId,
      key: 'template',
      value: {
        value_text: 'true',
        value_num: null,
        value_date: null,
        value_ref: null,
        value_bool: null,
      },
    })
    act(() => {
      recordBlockPropertyChange()
    })

    await waitFor(() => {
      expect(result.current.isTemplate).toBe(true)
    })
  })
})

describe('usePageTemplateMeta — page switch', () => {
  it('ignores the answer for a page it already left', async () => {
    let answerOldPage: (props: ReturnType<typeof makeProps>) => void = () => {}
    mockedGet.mockImplementation((blockId: string) =>
      blockId === 'page-old'
        ? new Promise((resolve) => {
            answerOldPage = resolve
          })
        : Promise.resolve(makeProps([])),
    )
    const { result, rerender } = renderHook(
      ({ pageId }) => usePageTemplateMeta(pageId, t, vi.fn()),
      { initialProps: { pageId: 'page-old' } },
    )
    rerender({ pageId: 'page-new' })
    await waitFor(() => {
      expect(mockedGet).toHaveBeenCalledWith('page-new')
    })

    await act(async () => {
      answerOldPage(makeProps([{ key: 'template', value_text: 'true' }]))
    })

    expect(result.current.isTemplate).toBe(false)
  })
})
