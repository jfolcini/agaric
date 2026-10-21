/**
 * Unit tests for useAppBootRecovery (stretch).
 *
 * Validates the mount-only orphan-draft flush in isolation. Integration
 * coverage (App-level boot path) remains in `App.test.tsx`.
 */

import { invoke } from '@tauri-apps/api/core'
import { renderHook, waitFor } from '@testing-library/react'
import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useAppBootRecovery } from '@/hooks/useAppBootRecovery'
import { logger } from '@/lib/logger'

vi.mock('@/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

vi.mock('sonner', () => ({
  toast: {
    info: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
  },
}))

const mockedInvoke = vi.mocked(invoke)

beforeEach(() => {
  vi.clearAllMocks()
})

describe('useAppBootRecovery — orphan-draft flush', () => {
  // The boot-recovery path is a single `flush_all_drafts` IPC instead
  // of `list_drafts` → N `flush_draft` fire-and-forget calls. Tests
  // mock the consolidated IPC and branch on the returned `flushed`
  // count.
  it('issues exactly one flush_all_drafts IPC and no per-draft fan-out', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'flush_all_drafts') return { flushed: 2 }
      return null
    })

    renderHook(() => useAppBootRecovery())

    await waitFor(() => {
      const calls = mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'flush_all_drafts')
      expect(calls).toHaveLength(1)
    })
    // Regression guard: the old per-draft loop (and its `list_drafts`
    // probe) must NOT fire any more.
    expect(mockedInvoke).not.toHaveBeenCalledWith('flush_draft', expect.anything())
    expect(mockedInvoke).not.toHaveBeenCalledWith('list_drafts')
    expect(mockedInvoke).not.toHaveBeenCalledWith('list_drafts', expect.anything())
  })

  it('logs a warning when flush_all_drafts itself fails', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'flush_all_drafts') throw new Error('IPC down')
      return null
    })

    renderHook(() => useAppBootRecovery())

    await waitFor(() => {
      expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
        'App',
        'Failed to flush orphaned drafts during boot recovery',
        undefined,
        expect.any(Error),
      )
    })
  })

  // Orphan-draft flush is no longer silent. Recovery emits a
  // localised toast when count > 0; zero recoveries stay silent so we
  // don't spam users on a clean boot.
  it('fires toast.info with the recovered count when ≥1 draft is flushed', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'flush_all_drafts') return { flushed: 3 }
      return null
    })

    renderHook(() => useAppBootRecovery())

    await waitFor(() => {
      expect(vi.mocked(toast.info)).toHaveBeenCalledTimes(1)
    })
    // The string is i18n-rendered via i18next; pluralisation picks
    // `_other` for count !== 1. Match the literal English the catalog
    // ships for the `boot.recoveredDrafts_other` key.
    expect(vi.mocked(toast.info)).toHaveBeenCalledWith('Recovered 3 unsaved drafts')
  })

  it('uses singular form when exactly one draft is recovered', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'flush_all_drafts') return { flushed: 1 }
      return null
    })

    renderHook(() => useAppBootRecovery())

    await waitFor(() => {
      expect(vi.mocked(toast.info)).toHaveBeenCalledWith('Recovered 1 unsaved draft')
    })
  })

  it('does NOT fire any toast when zero drafts are pending', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'flush_all_drafts') return { flushed: 0 }
      return null
    })

    renderHook(() => useAppBootRecovery())

    // Wait for the IPC to settle, then assert silence.
    await waitFor(() => {
      const calls = mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'flush_all_drafts')
      expect(calls.length).toBeGreaterThanOrEqual(1)
    })
    expect(vi.mocked(toast.info)).not.toHaveBeenCalled()
    expect(vi.mocked(toast.success)).not.toHaveBeenCalled()
  })

  // Regression guard: the original `logger.info('boot', …)` line must
  // continue to fire alongside the new toast — the pre-existing log
  // sink is what powers offline diagnostics.
  it('still emits logger.info with the recovered count (regression guard)', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'flush_all_drafts') return { flushed: 2 }
      return null
    })

    renderHook(() => useAppBootRecovery())

    await waitFor(() => {
      expect(vi.mocked(logger.info)).toHaveBeenCalledWith('boot', 'Recovered 2 unsaved draft(s)')
    })
  })
})
