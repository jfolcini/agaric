/**
 * Tests for useUpdateCheck — desktop auto-update wire-up.
 *
 * Covers:
 *  - Boot check skipped on mobile (UA sniff)
 *  - 24-h debounce honoured (recent LS timestamp)
 *  - 24-h debounce expired (old LS timestamp triggers check)
 *  - Update available → toast shown with stable id
 *  - No update on boot → silent (no toast)
 *  - `checkForUpdatesNow` bypass of the debounce window
 *  - `checkForUpdatesNow` no-update confirmation toast
 *  - Install flow: flushAllDrafts → downloadAndInstall → relaunch in order
 *  - Install failure: notify.error called, no relaunch
 */

import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { flushAllDrafts } from '@/lib/tauri'

import {
  checkForUpdatesNow,
  LAST_UPDATE_CHECK_STORAGE_KEY,
  useUpdateCheck,
} from '../useUpdateCheck'

// ── Module mocks ────────────────────────────────────────────────────
// These need to be hoisted, hence the `vi.mock` + module-scope captured
// `vi.fn()`s pattern.
const mockCheck = vi.fn()
const mockRelaunch = vi.fn()

vi.mock('@tauri-apps/plugin-updater', () => ({
  check: (...args: unknown[]) => mockCheck(...args),
}))

vi.mock('@tauri-apps/plugin-process', () => ({
  relaunch: (...args: unknown[]) => mockRelaunch(...args),
}))

vi.mock('@/lib/tauri', () => ({
  flushAllDrafts: vi.fn(),
}))

vi.mock('@/lib/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

// Mock `@/lib/notify` directly so the tests can assert on `notify.message`
// / `notify.error` / `notify.success` calls. The default `notify`
// callable + the chained method shape is preserved.
interface NotifyMockMethods {
  message: ReturnType<typeof vi.fn>
  error: ReturnType<typeof vi.fn>
  success: ReturnType<typeof vi.fn>
  info: ReturnType<typeof vi.fn>
  warning: ReturnType<typeof vi.fn>
  loading: ReturnType<typeof vi.fn>
  promise: ReturnType<typeof vi.fn>
  custom: ReturnType<typeof vi.fn>
  dismiss: ReturnType<typeof vi.fn>
}
type NotifyMockShape = ReturnType<typeof vi.fn> & NotifyMockMethods

vi.mock('@/lib/notify', () => {
  const fn = Object.assign(vi.fn(), {
    message: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    loading: vi.fn(),
    promise: vi.fn(),
    custom: vi.fn(),
    dismiss: vi.fn(),
  }) as NotifyMockShape
  return { notify: fn }
})

import { notify } from '@/lib/notify'

// ── UA helpers ─────────────────────────────────────────────────────
const DESKTOP_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'
const ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36'

let originalUA: string

function setUserAgent(ua: string) {
  Object.defineProperty(navigator, 'userAgent', {
    configurable: true,
    get: () => ua,
  })
}

beforeEach(() => {
  originalUA = navigator.userAgent
  setUserAgent(DESKTOP_UA)
  localStorage.clear()
  vi.mocked(flushAllDrafts).mockReset()
  vi.mocked(flushAllDrafts).mockResolvedValue({ flushed: 0 })
  mockCheck.mockReset()
  mockRelaunch.mockReset()
  vi.mocked(notify.message).mockReset()
  vi.mocked(notify.error).mockReset()
  vi.mocked(notify.success).mockReset()
})

afterEach(() => {
  setUserAgent(originalUA)
})

describe('useUpdateCheck — boot effect', () => {
  it('skips the check on mobile (Android UA)', async () => {
    setUserAgent(ANDROID_UA)
    renderHook(() => useUpdateCheck())
    // Give microtasks a chance to flush; nothing should have called check.
    await Promise.resolve()
    await Promise.resolve()
    expect(mockCheck).not.toHaveBeenCalled()
  })

  it('honours the 24-h debounce when LS has a recent timestamp', async () => {
    const recent = new Date(Date.now() - 60 * 60 * 1000).toISOString() // 1 h ago
    localStorage.setItem(LAST_UPDATE_CHECK_STORAGE_KEY, recent)
    renderHook(() => useUpdateCheck())
    await Promise.resolve()
    await Promise.resolve()
    expect(mockCheck).not.toHaveBeenCalled()
  })

  it('calls check when the debounce window expired and updates the LS timestamp', async () => {
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString() // 48 h ago
    localStorage.setItem(LAST_UPDATE_CHECK_STORAGE_KEY, old)
    mockCheck.mockResolvedValueOnce(null)

    renderHook(() => useUpdateCheck())

    await waitFor(() => expect(mockCheck).toHaveBeenCalledTimes(1))
    const after = localStorage.getItem(LAST_UPDATE_CHECK_STORAGE_KEY)
    expect(after).not.toBe(old)
    expect(after).not.toBeNull()
  })

  it('shows the update-available toast with the stable id when an update is found', async () => {
    mockCheck.mockResolvedValueOnce({
      version: '1.2.3',
      downloadAndInstall: vi.fn(),
    })

    renderHook(() => useUpdateCheck())

    await waitFor(() => expect(notify.message).toHaveBeenCalledTimes(1))
    const [, opts] = vi.mocked(notify.message).mock.calls[0] ?? []
    expect(opts).toMatchObject({ id: 'update-available' })
  })

  it('is silent on the boot check when no update is available', async () => {
    mockCheck.mockResolvedValueOnce(null)

    renderHook(() => useUpdateCheck())

    await waitFor(() => expect(mockCheck).toHaveBeenCalledTimes(1))
    expect(notify.message).not.toHaveBeenCalled()
    expect(notify.success).not.toHaveBeenCalled()
    expect(notify.error).not.toHaveBeenCalled()
  })
})

describe('checkForUpdatesNow — manual entry point', () => {
  it('bypasses the 24-h debounce', async () => {
    const recent = new Date(Date.now() - 60 * 1000).toISOString() // 1 min ago
    localStorage.setItem(LAST_UPDATE_CHECK_STORAGE_KEY, recent)
    mockCheck.mockResolvedValueOnce(null)

    await checkForUpdatesNow()

    expect(mockCheck).toHaveBeenCalledTimes(1)
  })

  it('shows the no-update confirmation toast on success when nothing is new', async () => {
    mockCheck.mockResolvedValueOnce(null)

    await checkForUpdatesNow()

    expect(notify.success).toHaveBeenCalledTimes(1)
  })

  it('shows the update-available toast when an update is found', async () => {
    mockCheck.mockResolvedValueOnce({
      version: '2.0.0',
      downloadAndInstall: vi.fn(),
    })

    await checkForUpdatesNow()

    expect(notify.message).toHaveBeenCalledTimes(1)
    const [, opts] = vi.mocked(notify.message).mock.calls[0] ?? []
    expect(opts).toMatchObject({ id: 'update-available' })
  })
})

describe('install flow', () => {
  it('flushes drafts, downloads + installs, then relaunches in order', async () => {
    const order: string[] = []
    vi.mocked(flushAllDrafts).mockImplementation(async () => {
      order.push('flush')
      return { flushed: 0 }
    })
    const downloadAndInstall = vi.fn(async () => {
      order.push('install')
    })
    mockRelaunch.mockImplementation(async () => {
      order.push('relaunch')
    })
    mockCheck.mockResolvedValueOnce({ version: '1.2.3', downloadAndInstall })

    await checkForUpdatesNow()

    await waitFor(() => expect(notify.message).toHaveBeenCalled())
    // Pull the install action out of the toast options and fire it.
    const [, opts] = vi.mocked(notify.message).mock.calls[0] ?? []
    const action = (opts as unknown as { action: { onClick: () => void } }).action
    action.onClick()

    await waitFor(() => expect(mockRelaunch).toHaveBeenCalled())
    expect(order).toEqual(['flush', 'install', 'relaunch'])
  })

  it('reports a notify.error and skips relaunch when downloadAndInstall rejects', async () => {
    const downloadAndInstall = vi.fn(async () => {
      throw new Error('network down')
    })
    mockCheck.mockResolvedValueOnce({ version: '1.2.3', downloadAndInstall })

    await checkForUpdatesNow()

    await waitFor(() => expect(notify.message).toHaveBeenCalled())
    const [, opts] = vi.mocked(notify.message).mock.calls[0] ?? []
    const action = (opts as unknown as { action: { onClick: () => void } }).action
    action.onClick()

    await waitFor(() => expect(notify.error).toHaveBeenCalled())
    expect(mockRelaunch).not.toHaveBeenCalled()
    // Toast-cleanup on install failure (technical review #2):
    // the persistent `update-available` toast must be dismissed so the
    // user doesn't have a stale "Install & restart" button still
    // clickable, AND the LS timestamp must be cleared so the next
    // boot re-tries the check sooner (avoids a 24 h silent wait).
    expect(notify.dismiss).toHaveBeenCalledWith('update-available')
    expect(localStorage.getItem(LAST_UPDATE_CHECK_STORAGE_KEY)).toBeNull()
  })

  it('aborts the install when flushAllDrafts rejects (mid-edit safety)', async () => {
    // Technical review #1: flushAllDrafts failure must prevent
    // downloadAndInstall so an interrupted install can't lose a
    // user's in-flight edit.
    vi.mocked(flushAllDrafts).mockRejectedValueOnce(new Error('sqlite contention'))
    const downloadAndInstall = vi.fn(async () => {})
    mockCheck.mockResolvedValueOnce({ version: '1.2.3', downloadAndInstall })

    await checkForUpdatesNow()
    await waitFor(() => expect(notify.message).toHaveBeenCalled())
    const [, opts] = vi.mocked(notify.message).mock.calls[0] ?? []
    const action = (opts as unknown as { action: { onClick: () => void } }).action
    action.onClick()

    await waitFor(() => expect(notify.error).toHaveBeenCalled())
    expect(downloadAndInstall).not.toHaveBeenCalled()
    expect(mockRelaunch).not.toHaveBeenCalled()
    expect(notify.dismiss).toHaveBeenCalledWith('update-available')
  })
})
