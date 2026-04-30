/**
 * Unit tests for useAppBootRecovery (MAINT-124 step 4 stretch).
 *
 * Validates the two mount-only IPC effects in isolation. Integration
 * coverage (App-level boot path) remains in `App.test.tsx`.
 */

import { invoke } from '@tauri-apps/api/core'
import { renderHook, waitFor } from '@testing-library/react'
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

const mockedInvoke = vi.mocked(invoke)

beforeEach(() => {
  vi.clearAllMocks()
  __resetPriorityLevelsForTests()
})

afterEach(() => {
  __resetPriorityLevelsForTests()
})

describe('useAppBootRecovery — orphan-draft flush', () => {
  it('calls flush_draft for every entry returned by list_drafts', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_drafts') {
        return [{ block_id: 'B1' }, { block_id: 'B2' }]
      }
      if (cmd === 'flush_draft') {
        return undefined
      }
      if (cmd === 'list_property_defs') {
        return []
      }
      return null
    })

    renderHook(() => useAppBootRecovery())

    await waitFor(() => {
      const flushCalls = mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'flush_draft')
      expect(flushCalls).toHaveLength(2)
    })
  })

  it('logs a warning when list_drafts itself fails', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_drafts') {
        throw new Error('IPC down')
      }
      if (cmd === 'list_property_defs') {
        return []
      }
      return null
    })

    renderHook(() => useAppBootRecovery())

    await waitFor(() => {
      expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
        'App',
        'Failed to list drafts during boot recovery',
        undefined,
        expect.any(Error),
      )
    })
  })
})

describe('useAppBootRecovery — priority levels (UX-201b)', () => {
  it('hydrates the priority-levels cache from list_property_defs', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_drafts') return []
      if (cmd === 'list_property_defs') {
        return [
          {
            key: 'priority',
            value_type: 'select',
            options: JSON.stringify(['urgent', 'high', 'low']),
          },
        ]
      }
      return null
    })

    renderHook(() => useAppBootRecovery())

    await waitFor(() => {
      expect(getPriorityLevels()).toEqual(['urgent', 'high', 'low'])
    })
  })

  it('keeps defaults when the priority definition is missing', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_drafts') return []
      if (cmd === 'list_property_defs') return []
      return null
    })

    const before = getPriorityLevels()
    renderHook(() => useAppBootRecovery())

    // Wait a tick for the IPC promise to settle
    await waitFor(() => {
      const calls = mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'list_property_defs')
      expect(calls.length).toBeGreaterThanOrEqual(1)
    })
    expect(getPriorityLevels()).toEqual(before)
  })

  it('keeps defaults and warns on invalid JSON options', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_drafts') return []
      if (cmd === 'list_property_defs') {
        return [{ key: 'priority', value_type: 'select', options: '{not-json' }]
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
