import { renderHook } from '@testing-library/react'
import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  PAGES_RENAMED_EVENT,
  PAGES_RENAMED_TOAST_ID,
  type PageRenamed,
  usePageRenameNotices,
} from '@/hooks/usePageRenameNotices'
import { t } from '@/lib/i18n'
import { logger } from '@/lib/logger'

const { mockUnlisten, mockListen } = vi.hoisted(() => {
  const unlisten = vi.fn()
  return { mockUnlisten: unlisten, mockListen: vi.fn().mockResolvedValue(unlisten) }
})

vi.mock('@tauri-apps/api/event', () => ({
  listen: (...args: unknown[]) => mockListen(...args),
}))

vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

// `sonner` is mocked globally via test-setup.ts → src/__tests__/mocks/sonner.ts.

const FOO: PageRenamed = { page_id: 'PAGE_FOO', from: 'Foo', to: 'Foo (2)' }
const BAR: PageRenamed = { page_id: 'PAGE_BAR', from: 'bar', to: 'bar (3)' }

let hadTauriInternals: boolean

beforeEach(() => {
  vi.clearAllMocks()
  hadTauriInternals = '__TAURI_INTERNALS__' in window
  if (!hadTauriInternals) {
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      value: {},
      writable: true,
      configurable: true,
    })
  }
  mockListen.mockResolvedValue(mockUnlisten)
})

afterEach(() => {
  if (!hadTauriInternals) {
    delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
  }
})

/** Deliver `payload` as the backend's `pages:renamed` event. */
function emitRenamed(payload: PageRenamed[]): void {
  const call = mockListen.mock.calls.find((c) => c[0] === PAGES_RENAMED_EVENT)
  if (!call) throw new Error(`no listener registered for ${PAGES_RENAMED_EVENT}`)
  ;(call[1] as (event: { payload: PageRenamed[] }) => void)({ payload })
}

describe('usePageRenameNotices', () => {
  it('listens for the event name the backend emits', () => {
    // `EVENT_PAGES_RENAMED` in src-tauri/src/repair/name_collisions.rs.
    expect(PAGES_RENAMED_EVENT).toBe('pages:renamed')
    renderHook(() => usePageRenameNotices())
    expect(mockListen).toHaveBeenCalledWith('pages:renamed', expect.any(Function))
  })

  it('names the page it renamed, in a toast that stays until dismissed', () => {
    renderHook(() => usePageRenameNotices())
    emitRenamed([FOO])
    expect(toast.info).toHaveBeenCalledWith(
      t('pages.nameTieRenamed', { count: 1, from: 'Foo', to: 'Foo (2)' }),
      { id: PAGES_RENAMED_TOAST_ID, duration: Number.POSITIVE_INFINITY },
    )
    expect(vi.mocked(toast.info).mock.calls[0]?.[0]).toContain('Foo (2)')
  })

  it('counts several renames in one toast', () => {
    renderHook(() => usePageRenameNotices())
    emitRenamed([FOO, BAR])
    expect(toast.info).toHaveBeenCalledTimes(1)
    expect(toast.info).toHaveBeenCalledWith(t('pages.nameTieRenamed', { count: 2 }), {
      id: PAGES_RENAMED_TOAST_ID,
      duration: Number.POSITIVE_INFINITY,
    })
    expect(vi.mocked(toast.info).mock.calls[0]?.[0]).not.toContain('Foo')
  })

  it('shows nothing for an empty payload', () => {
    renderHook(() => usePageRenameNotices())
    emitRenamed([])
    expect(toast.info).not.toHaveBeenCalled()
  })

  it('logs a listener that fails to register', async () => {
    const failure = new Error('no event bus')
    mockListen.mockRejectedValueOnce(failure)
    renderHook(() => usePageRenameNotices())
    await vi.waitFor(() =>
      expect(logger.warn).toHaveBeenCalledWith(
        'usePageRenameNotices',
        'Failed to listen to pages:renamed',
        undefined,
        failure,
      ),
    )
  })

  it('does not listen outside Tauri', () => {
    delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
    renderHook(() => usePageRenameNotices())
    expect(mockListen).not.toHaveBeenCalled()
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      value: {},
      writable: true,
      configurable: true,
    })
  })
})
