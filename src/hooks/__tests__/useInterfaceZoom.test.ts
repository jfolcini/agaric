/**
 * #5646 — the interface zoom: the shortcuts step and persist it, the app shell
 * applies it to the webview, and the next mount restores it.
 */

import { fireEvent, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useAppKeyboardShortcuts } from '@/hooks/useAppKeyboardShortcuts'
import { stepInterfaceZoom, useInterfaceZoom } from '@/hooks/useInterfaceZoom'
import { setCustomShortcut } from '@/lib/keyboard-config'
import { logger } from '@/lib/logger'
import { INTERFACE_ZOOM_LEVELS } from '@/lib/preferences'

const mockSetZoom = vi.fn()
vi.mock('@tauri-apps/api/webview', () => ({
  getCurrentWebview: () => ({ setZoom: mockSetZoom }),
}))
vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const KEY = 'agaric-interface-zoom'
const t = (key: string): string => key

/** The app shell: the shortcut listeners plus the hook that applies the zoom. */
function mountShell() {
  return renderHook(() => {
    useAppKeyboardShortcuts({ t, isMobile: false })
    useInterfaceZoom()
  })
}

beforeEach(() => {
  localStorage.clear()
  mockSetZoom.mockReset()
  mockSetZoom.mockResolvedValue(undefined)
  vi.mocked(logger.warn).mockClear()
})

describe('stepInterfaceZoom', () => {
  it('moves one level and holds at both ends of the range', () => {
    expect(stepInterfaceZoom(1, 1)).toBe(1.1)
    expect(stepInterfaceZoom(1, -1)).toBe(0.9)
    expect(stepInterfaceZoom(0.5, -1)).toBe(0.5)
    expect(stepInterfaceZoom(2.5, 1)).toBe(2.5)
    expect(INTERFACE_ZOOM_LEVELS.at(0)).toBe(0.5)
    expect(INTERFACE_ZOOM_LEVELS.at(-1)).toBe(2.5)
  })
})

describe('useInterfaceZoom', () => {
  it('leaves the webview alone at the default 100%', async () => {
    mountShell()
    expect(mockSetZoom).not.toHaveBeenCalled()
    // Positive control: a stored level on another mount does reach the webview.
    localStorage.setItem(KEY, '1.5')
    renderHook(() => useInterfaceZoom())
    await waitFor(() => expect(mockSetZoom).toHaveBeenCalledTimes(1))
    expect(mockSetZoom).toHaveBeenCalledWith(1.5)
  })

  it('ignores a stored value outside the range', async () => {
    localStorage.setItem(KEY, '3')
    mountShell()

    fireEvent.keyDown(window, { key: '=', ctrlKey: true })

    expect(localStorage.getItem(KEY)).toBe('1.1')
    await waitFor(() => expect(mockSetZoom).toHaveBeenCalledExactlyOnceWith(1.1))
  })

  it('Ctrl+= zooms in, persists the level, and the next mount restores it', async () => {
    const shell = mountShell()

    fireEvent.keyDown(window, { key: '=', ctrlKey: true })
    fireEvent.keyDown(window, { key: '+', ctrlKey: true, shiftKey: true })

    expect(localStorage.getItem(KEY)).toBe('1.25')
    await waitFor(() => expect(mockSetZoom).toHaveBeenLastCalledWith(1.25))

    shell.unmount()
    mockSetZoom.mockClear()
    mountShell()

    await waitFor(() => expect(mockSetZoom).toHaveBeenCalledExactlyOnceWith(1.25))
  })

  it('Ctrl+- zooms out and Ctrl+0 resets to 100%', async () => {
    mountShell()

    fireEvent.keyDown(window, { key: '-', ctrlKey: true })
    expect(localStorage.getItem(KEY)).toBe('0.9')
    await waitFor(() => expect(mockSetZoom).toHaveBeenLastCalledWith(0.9))

    fireEvent.keyDown(window, { key: '0', ctrlKey: true })
    expect(localStorage.getItem(KEY)).toBe('1')
    await waitFor(() => expect(mockSetZoom).toHaveBeenLastCalledWith(1))
  })

  it('follows a rebound shortcut instead of the default', () => {
    setCustomShortcut('interfaceZoomIn', 'Ctrl + Alt + I')
    mountShell()

    fireEvent.keyDown(window, { key: '=', ctrlKey: true })
    expect(localStorage.getItem(KEY)).toBe('1')

    fireEvent.keyDown(window, { key: 'i', ctrlKey: true, altKey: true })
    expect(localStorage.getItem(KEY)).toBe('1.1')
  })

  it('Ctrl+= at the maximum keeps the maximum', () => {
    localStorage.setItem(KEY, '2.5')
    mountShell()

    fireEvent.keyDown(window, { key: '=', ctrlKey: true })

    expect(localStorage.getItem(KEY)).toBe('2.5')
  })

  it('a rejected setZoom is logged and the level stays saved', async () => {
    const err = new Error('webview.set_webview_zoom not allowed')
    mockSetZoom.mockRejectedValue(err)
    mountShell()

    fireEvent.keyDown(window, { key: '=', ctrlKey: true })

    await waitFor(() =>
      expect(logger.warn).toHaveBeenCalledWith(
        'window',
        'setZoom() failed or webview API unavailable',
        { factor: 1.1 },
        err,
      ),
    )
    expect(localStorage.getItem(KEY)).toBe('1.1')
  })
})
