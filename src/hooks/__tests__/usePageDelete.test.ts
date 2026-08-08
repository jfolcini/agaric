/** Tests for the thin PageBrowser adapter over usePageDeleteAction. */

import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { usePageDelete } from '@/hooks/usePageDelete'

const { requestDelete, sharedDialog } = vi.hoisted(() => ({
  requestDelete: vi.fn(),
  sharedDialog: { type: 'shared-confirm-dialog' },
}))

vi.mock('@/hooks/usePageDeleteAction', () => ({
  usePageDeleteAction: () => ({
    requestDelete,
    deletingId: 'PENDING_PAGE',
    isDeleting: true,
    confirmDialog: sharedDialog,
  }),
}))

beforeEach(() => {
  vi.clearAllMocks()
})

describe('usePageDelete', () => {
  it('exposes shared in-flight state and the shared confirm dialog', () => {
    const { result } = renderHook(() => usePageDelete(vi.fn(), vi.fn()))

    expect(result.current.deletingId).toBe('PENDING_PAGE')
    expect(result.current.confirmDialog).toBe(sharedDialog)
  })

  it('ignores a null row target', () => {
    const { result } = renderHook(() => usePageDelete(vi.fn(), vi.fn()))

    act(() => {
      result.current.setDeleteTarget(null)
    })

    expect(requestDelete).not.toHaveBeenCalled()
  })

  it('delegates PageBrowser copy and removes only after the shared delete succeeds', () => {
    const setPages = vi.fn()
    const onRestored = vi.fn()
    const { result } = renderHook(() => usePageDelete(setPages, onRestored))

    act(() => {
      result.current.setDeleteTarget({ id: 'P1', name: 'Page one' })
    })

    expect(requestDelete).toHaveBeenCalledWith(
      'P1',
      'Page one',
      expect.objectContaining({
        confirmCopy: {
          titleKey: 'pageBrowser.deletePage',
          descriptionKey: 'pageHeader.deleteConfirm',
          confirmKey: 'pageBrowser.delete',
          cancelKey: 'pageBrowser.cancel',
          values: { name: 'Page one' },
        },
        onRestored,
      }),
    )
    expect(setPages).not.toHaveBeenCalled()

    const options = requestDelete.mock.calls[0]?.[2] as
      | { onDeleted?: (pageId: string) => void }
      | undefined
    act(() => {
      options?.onDeleted?.('P1')
    })

    expect(setPages).toHaveBeenCalledTimes(1)
    const updater = setPages.mock.calls[0]?.[0] as
      | ((pages: Array<{ id: string }>) => Array<{ id: string }>)
      | undefined
    expect(updater?.([{ id: 'P1' }, { id: 'P2' }])).toEqual([{ id: 'P2' }])
  })
})
