import { beforeEach, describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------------
// Global-shortcut wrappers
// ---------------------------------------------------------------------------
//
// `registerGlobalShortcut` / `unregisterGlobalShortcut` /
// `isGlobalShortcutRegistered` use a dynamic
// `import('@tauri-apps/plugin-global-shortcut')` internally, so we mock the
// module factory at the file scope and import the wrappers separately.

const mockRegister = vi.fn()
const mockUnregister = vi.fn()
const mockIsRegistered = vi.fn()
vi.mock('@tauri-apps/plugin-global-shortcut', () => ({
  register: mockRegister,
  unregister: mockUnregister,
  isRegistered: mockIsRegistered,
}))

// Defer the import so the vi.mock above hoists ahead of it. Using a dynamic
// import at the top of each test keeps the wrapper references fresh across
// `vi.clearAllMocks()` runs in `beforeEach`.
async function importGlobalShortcutWrappers() {
  return await import('@/lib/platform/global-shortcut')
}

describe('registerGlobalShortcut', () => {
  beforeEach(() => {
    mockRegister.mockReset()
    mockUnregister.mockReset()
    mockIsRegistered.mockReset()
  })

  it('forwards the accelerator to the plugin and only fires the user callback on Pressed events', async () => {
    const { registerGlobalShortcut } = await importGlobalShortcutWrappers()
    mockRegister.mockResolvedValueOnce(undefined)

    const handler = vi.fn()
    await registerGlobalShortcut('Ctrl+Alt+N', handler)

    expect(mockRegister).toHaveBeenCalledOnce()
    expect(mockRegister).toHaveBeenCalledWith('Ctrl+Alt+N', expect.any(Function))

    // Drive the captured plugin handler with a Pressed and a Released
    // event — only the Pressed activation should reach the user callback.
    const pluginHandler = mockRegister.mock.calls[0]?.[1] as (e: {
      shortcut: string
      id: number
      state: 'Pressed' | 'Released'
    }) => void
    pluginHandler({ shortcut: 'Ctrl+Alt+N', id: 1, state: 'Pressed' })
    expect(handler).toHaveBeenCalledOnce()

    pluginHandler({ shortcut: 'Ctrl+Alt+N', id: 1, state: 'Released' })
    expect(handler).toHaveBeenCalledOnce()
  })

  it('propagates errors from the plugin (chord conflict)', async () => {
    const { registerGlobalShortcut } = await importGlobalShortcutWrappers()
    mockRegister.mockRejectedValueOnce(new Error('shortcut already registered'))

    await expect(registerGlobalShortcut('Ctrl+Alt+N', () => {})).rejects.toThrow(
      'shortcut already registered',
    )
  })

  it('is a no-op on mobile (Android user agent)', async () => {
    const { registerGlobalShortcut } = await importGlobalShortcutWrappers()
    const originalUA = navigator.userAgent
    Object.defineProperty(navigator, 'userAgent', {
      configurable: true,
      get: () => 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/120.0',
    })
    try {
      await registerGlobalShortcut('Ctrl+Alt+N', () => {})
      expect(mockRegister).not.toHaveBeenCalled()
    } finally {
      Object.defineProperty(navigator, 'userAgent', {
        configurable: true,
        get: () => originalUA,
      })
    }
  })
})

describe('unregisterGlobalShortcut', () => {
  beforeEach(() => {
    mockUnregister.mockReset()
  })

  it('forwards the accelerator to the plugin', async () => {
    const { unregisterGlobalShortcut } = await importGlobalShortcutWrappers()
    mockUnregister.mockResolvedValueOnce(undefined)

    await unregisterGlobalShortcut('Ctrl+Alt+N')

    expect(mockUnregister).toHaveBeenCalledOnce()
    expect(mockUnregister).toHaveBeenCalledWith('Ctrl+Alt+N')
  })

  it('propagates errors from the plugin', async () => {
    const { unregisterGlobalShortcut } = await importGlobalShortcutWrappers()
    mockUnregister.mockRejectedValueOnce(new Error('not registered'))

    await expect(unregisterGlobalShortcut('Ctrl+Alt+N')).rejects.toThrow('not registered')
  })

  it('is a no-op on mobile (iPhone user agent)', async () => {
    const { unregisterGlobalShortcut } = await importGlobalShortcutWrappers()
    const originalUA = navigator.userAgent
    Object.defineProperty(navigator, 'userAgent', {
      configurable: true,
      get: () =>
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148',
    })
    try {
      await unregisterGlobalShortcut('Ctrl+Alt+N')
      expect(mockUnregister).not.toHaveBeenCalled()
    } finally {
      Object.defineProperty(navigator, 'userAgent', {
        configurable: true,
        get: () => originalUA,
      })
    }
  })
})

describe('isGlobalShortcutRegistered', () => {
  beforeEach(() => {
    mockIsRegistered.mockReset()
  })

  it('forwards the accelerator and returns the plugin response', async () => {
    const { isGlobalShortcutRegistered } = await importGlobalShortcutWrappers()
    mockIsRegistered.mockResolvedValueOnce(true)

    const result = await isGlobalShortcutRegistered('Ctrl+Alt+N')

    expect(mockIsRegistered).toHaveBeenCalledOnce()
    expect(mockIsRegistered).toHaveBeenCalledWith('Ctrl+Alt+N')
    expect(result).toBe(true)
  })

  it('propagates errors from the plugin', async () => {
    const { isGlobalShortcutRegistered } = await importGlobalShortcutWrappers()
    mockIsRegistered.mockRejectedValueOnce(new Error('plugin unavailable'))

    await expect(isGlobalShortcutRegistered('Ctrl+Alt+N')).rejects.toThrow('plugin unavailable')
  })

  it('returns false on mobile without invoking the plugin', async () => {
    const { isGlobalShortcutRegistered } = await importGlobalShortcutWrappers()
    const originalUA = navigator.userAgent
    Object.defineProperty(navigator, 'userAgent', {
      configurable: true,
      get: () => 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/120.0',
    })
    try {
      const result = await isGlobalShortcutRegistered('Ctrl+Alt+N')
      expect(mockIsRegistered).not.toHaveBeenCalled()
      expect(result).toBe(false)
    } finally {
      Object.defineProperty(navigator, 'userAgent', {
        configurable: true,
        get: () => originalUA,
      })
    }
  })
})
