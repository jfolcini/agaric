/**
 * Unit tests for useAppBootRecovery (stretch).
 *
 * Validates the two mount-only IPC effects in isolation. Integration
 * coverage (App-level boot path) remains in `App.test.tsx`.
 */

import { invoke } from '@tauri-apps/api/core'
import { renderHook, waitFor } from '@testing-library/react'
import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { logger } from '../../lib/logger'
import { __resetPriorityLevelsForTests, getPriorityLevels } from '../../lib/priority-levels'
import { useAppBootRecovery } from '../useAppBootRecovery'

vi.mock('../../lib/logger', () => ({
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
  __resetPriorityLevelsForTests()
})

afterEach(() => {
  __resetPriorityLevelsForTests()
})

describe('useAppBootRecovery — orphan-draft flush', () => {
  // The boot-recovery path is a single `flush_all_drafts` IPC instead
  // of `list_drafts` → N `flush_draft` fire-and-forget calls. Tests
  // mock the consolidated IPC and branch on the returned `flushed`
  // count.
  it('issues exactly one flush_all_drafts IPC and no per-draft fan-out', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'flush_all_drafts') return { flushed: 2 }
      if (cmd === 'get_property_def') return null
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
      if (cmd === 'get_property_def') return null
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
      if (cmd === 'get_property_def') return null
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
      if (cmd === 'get_property_def') return null
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
      if (cmd === 'get_property_def') return null
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
      if (cmd === 'get_property_def') return null
      return null
    })

    renderHook(() => useAppBootRecovery())

    await waitFor(() => {
      expect(vi.mocked(logger.info)).toHaveBeenCalledWith('boot', 'Recovered 2 unsaved draft(s)')
    })
  })
})

describe('useAppBootRecovery — priority levels', () => {
  // Priority lookup now goes through the dedicated
  // `get_property_def(key)` PK SELECT instead of paginating the entire
  // property-definition vocabulary via `list_property_defs`.
  it('hydrates the priority-levels cache from get_property_def(priority)', async () => {
    mockedInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === 'flush_all_drafts') return { flushed: 0 }
      if (cmd === 'get_property_def') {
        const a = args as { key: string } | undefined
        if (a?.key === 'priority') {
          return {
            key: 'priority',
            value_type: 'select',
            options: JSON.stringify(['urgent', 'high', 'low']),
            created_at: '2025-01-01T00:00:00Z',
          }
        }
        return null
      }
      return null
    })

    renderHook(() => useAppBootRecovery())

    await waitFor(() => {
      expect(getPriorityLevels()).toEqual(['urgent', 'high', 'low'])
    })
    // Regression guard — only the targeted PK lookup is in flight.
    expect(mockedInvoke).toHaveBeenCalledWith('get_property_def', { key: 'priority' })
    expect(mockedInvoke).not.toHaveBeenCalledWith('list_property_defs', expect.anything())
  })

  it('keeps defaults when the priority definition is missing', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'flush_all_drafts') return { flushed: 0 }
      if (cmd === 'get_property_def') return null
      return null
    })

    const before = getPriorityLevels()
    renderHook(() => useAppBootRecovery())

    // Wait a tick for the IPC promise to settle
    await waitFor(() => {
      const calls = mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'get_property_def')
      expect(calls.length).toBeGreaterThanOrEqual(1)
    })
    expect(getPriorityLevels()).toEqual(before)
  })

  it('keeps defaults and warns on invalid JSON options', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'flush_all_drafts') return { flushed: 0 }
      if (cmd === 'get_property_def') {
        return {
          key: 'priority',
          value_type: 'select',
          options: '{not-json',
          created_at: '2025-01-01T00:00:00Z',
        }
      }
      return null
    })

    const before = getPriorityLevels()
    renderHook(() => useAppBootRecovery())

    await waitFor(() => {
      expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
        'App',
        'priority property definition has invalid JSON options',
        expect.any(Object),
        expect.any(Error),
      )
    })
    expect(getPriorityLevels()).toEqual(before)
  })
})
