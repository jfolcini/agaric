import { afterEach, describe, expect, it } from 'vitest'

import { getDebugMode, useDebugStore } from '@/stores/useDebugStore'

afterEach(() => {
  useDebugStore.setState({ debugMode: false })
  localStorage.clear()
})

describe('useDebugStore', () => {
  it('defaults to off', () => {
    expect(useDebugStore.getState().debugMode).toBe(false)
    expect(getDebugMode()).toBe(false)
  })

  it('setDebugMode updates the flag and the non-hook getter reflects it', () => {
    useDebugStore.getState().setDebugMode(true)
    expect(useDebugStore.getState().debugMode).toBe(true)
    expect(getDebugMode()).toBe(true)
  })

  it('toggleDebugMode flips the flag', () => {
    expect(useDebugStore.getState().debugMode).toBe(false)
    useDebugStore.getState().toggleDebugMode()
    expect(useDebugStore.getState().debugMode).toBe(true)
    useDebugStore.getState().toggleDebugMode()
    expect(useDebugStore.getState().debugMode).toBe(false)
  })

  it('persists only the flag under the agaric:debug key', () => {
    useDebugStore.getState().setDebugMode(true)
    const raw = localStorage.getItem('agaric:debug')
    expect(raw).not.toBeNull()
    const parsed = JSON.parse(raw as string)
    expect(parsed.state).toEqual({ debugMode: true })
  })
})
