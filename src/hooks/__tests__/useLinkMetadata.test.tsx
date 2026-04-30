/**
 * Tests for useLinkMetadata hook — typed wrapper around fetchLinkMetadata IPC.
 *
 * Validates:
 * - fetch invokes fetch_link_metadata with the URL and returns the resolved metadata
 * - fetch logs a structured warning and re-throws when the IPC rejects
 */

import { invoke } from '@tauri-apps/api/core'
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { logger } from '../../lib/logger'
import type { LinkMetadata } from '../../lib/tauri'
import { useLinkMetadata } from '../useLinkMetadata'

const mockedInvoke = vi.mocked(invoke)

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('useLinkMetadata.fetch', () => {
  it('invokes fetch_link_metadata and returns the resolved metadata', async () => {
    const meta: LinkMetadata = {
      url: 'https://example.com',
      title: 'Example',
      favicon_url: 'https://example.com/favicon.ico',
      description: 'An example domain',
      fetched_at: '2026-01-01T00:00:00Z',
      auth_required: false,
    }
    mockedInvoke.mockResolvedValueOnce(meta)

    const { result } = renderHook(() => useLinkMetadata())

    let resolved: LinkMetadata | undefined
    await act(async () => {
      resolved = await result.current.fetch('https://example.com')
    })

    expect(mockedInvoke).toHaveBeenCalledWith('fetch_link_metadata', {
      url: 'https://example.com',
    })
    expect(resolved).toEqual(meta)
  })

  it('logs a structured warning and re-throws when the IPC rejects', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const cause = new Error('network down')
    mockedInvoke.mockRejectedValueOnce(cause)

    const { result } = renderHook(() => useLinkMetadata())

    await expect(
      act(async () => {
        await result.current.fetch('https://example.com')
      }),
    ).rejects.toBe(cause)

    expect(warnSpy).toHaveBeenCalledWith(
      'useLinkMetadata',
      'fetchLinkMetadata failed',
      { url: 'https://example.com' },
      cause,
    )
  })
})
