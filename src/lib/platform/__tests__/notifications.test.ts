import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ensureNotificationPermission } from '@/lib/platform/notifications'

// `ensureNotificationPermission` dynamically imports the notification
// plugin's permission API; mock the module factory at file scope so the
// hoisted import resolves to spies.
const mockIsPermissionGranted = vi.fn()
const mockRequestPermission = vi.fn()
vi.mock('@tauri-apps/plugin-notification', () => ({
  isPermissionGranted: mockIsPermissionGranted,
  requestPermission: mockRequestPermission,
}))

// ---------------------------------------------------------------------------
// EnsureNotificationPermission
// ---------------------------------------------------------------------------

describe('ensureNotificationPermission', () => {
  beforeEach(() => {
    mockIsPermissionGranted.mockReset()
    mockRequestPermission.mockReset()
  })

  it('returns true without prompting when permission is already granted', async () => {
    mockIsPermissionGranted.mockResolvedValueOnce(true)

    const result = await ensureNotificationPermission()

    expect(result).toBe(true)
    expect(mockRequestPermission).not.toHaveBeenCalled()
  })

  it('requests permission and returns true when the user grants it', async () => {
    mockIsPermissionGranted.mockResolvedValueOnce(false)
    mockRequestPermission.mockResolvedValueOnce('granted')

    const result = await ensureNotificationPermission()

    expect(mockRequestPermission).toHaveBeenCalledOnce()
    expect(result).toBe(true)
  })

  it('returns false when the user denies the permission request', async () => {
    mockIsPermissionGranted.mockResolvedValueOnce(false)
    mockRequestPermission.mockResolvedValueOnce('denied')

    const result = await ensureNotificationPermission()

    expect(result).toBe(false)
  })

  it('returns false (without throwing) when the plugin API rejects', async () => {
    mockIsPermissionGranted.mockRejectedValueOnce(new Error('plugin unavailable'))

    await expect(ensureNotificationPermission()).resolves.toBe(false)
  })
})
