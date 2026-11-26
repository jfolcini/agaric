/**
 * The platform decides touch (#7040 M7): the desktop Tauri app never, the
 * Android app always, a browser when its pointer is coarse and it has touch
 * points. `window.isTauri` marks the Tauri app; the user agent marks Android.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import { __resetPlatformCacheForTests } from '@/lib/platform'
import { detectTouch, syncTouchAttribute } from '@/lib/touch'

const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 Chrome/120 Mobile'
const LINUX_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko)'

type Listener = () => void

function setDevice({
  tauri,
  userAgent,
  coarse,
  touchPoints,
}: {
  tauri: boolean
  userAgent: string
  coarse: boolean
  touchPoints: number
}): { listeners: Listener[] } {
  const listeners: Listener[] = []
  if (tauri) window.isTauri = true
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(userAgent)
  vi.spyOn(navigator, 'maxTouchPoints', 'get').mockReturnValue(touchPoints)
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (query: string) =>
      ({
        matches: query === '(pointer: coarse)' && coarse,
        addEventListener: (_type: string, listener: Listener) => listeners.push(listener),
        removeEventListener: () => {},
      }) as unknown as MediaQueryList,
  )
  __resetPlatformCacheForTests()
  return { listeners }
}

afterEach(() => {
  delete window.isTauri
  vi.restoreAllMocks()
  __resetPlatformCacheForTests()
  document.documentElement.removeAttribute('data-touch')
})

describe('detectTouch', () => {
  it('is never touch in the desktop Tauri app, even with a coarse pointer and touch points', () => {
    setDevice({ tauri: true, userAgent: LINUX_UA, coarse: true, touchPoints: 5 })
    expect(detectTouch()).toBe(false)
  })

  it('is always touch in the Android Tauri app, even with a fine pointer and no touch points', () => {
    setDevice({ tauri: true, userAgent: ANDROID_UA, coarse: false, touchPoints: 0 })
    expect(detectTouch()).toBe(true)
  })

  it('is touch in a browser with a coarse pointer and touch points', () => {
    setDevice({ tauri: false, userAgent: LINUX_UA, coarse: true, touchPoints: 5 })
    expect(detectTouch()).toBe(true)
  })

  it('is not touch in a browser with a coarse pointer and no touch points', () => {
    setDevice({ tauri: false, userAgent: LINUX_UA, coarse: true, touchPoints: 0 })
    expect(detectTouch()).toBe(false)
  })

  it('is not touch in a browser with a fine pointer, whatever its touch points', () => {
    setDevice({ tauri: false, userAgent: ANDROID_UA, coarse: false, touchPoints: 5 })
    expect(detectTouch()).toBe(false)
  })
})

describe('syncTouchAttribute', () => {
  it('writes the answer onto <html> and follows the pointer', () => {
    const device = setDevice({ tauri: false, userAgent: LINUX_UA, coarse: true, touchPoints: 5 })
    syncTouchAttribute()
    expect(document.documentElement.hasAttribute('data-touch')).toBe(true)

    vi.spyOn(navigator, 'maxTouchPoints', 'get').mockReturnValue(0)
    for (const listener of device.listeners) listener()
    expect(document.documentElement.hasAttribute('data-touch')).toBe(false)
  })

  it('leaves the desktop Tauri app off touch', () => {
    setDevice({ tauri: true, userAgent: LINUX_UA, coarse: true, touchPoints: 5 })
    syncTouchAttribute()
    expect(document.documentElement.hasAttribute('data-touch')).toBe(false)
  })
})
