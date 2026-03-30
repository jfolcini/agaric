import { invoke } from '@tauri-apps/api/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useBootStore } from '../stores/boot'

const mockedInvoke = vi.mocked(invoke)

describe('useBootStore', () => {
  beforeEach(() => {
    // Reset the store state between tests
    useBootStore.setState({ state: 'booting', error: null })
    vi.clearAllMocks()
  })

  it('starts in booting state', () => {
    const { state } = useBootStore.getState()
    expect(state).toBe('booting')
  })

  it('transitions to recovering then ready on successful boot', async () => {
    // Track state transitions
    const states: string[] = []
    const unsub = useBootStore.subscribe((s) => states.push(s.state))

    mockedInvoke.mockResolvedValueOnce({ items: [], next_cursor: null, has_more: false })
    await useBootStore.getState().boot()
    unsub()

    expect(states).toContain('recovering')
    expect(useBootStore.getState().state).toBe('ready')
    expect(useBootStore.getState().error).toBeNull()
  })

  it('transitions to recovering then error on failed boot', async () => {
    const states: string[] = []
    const unsub = useBootStore.subscribe((s) => states.push(s.state))

    mockedInvoke.mockRejectedValueOnce(new Error('DB connection failed'))
    await useBootStore.getState().boot()
    unsub()

    expect(states).toContain('recovering')
    expect(useBootStore.getState().state).toBe('error')
    expect(useBootStore.getState().error).toBe('DB connection failed')
  })

  it('can retry from error state', async () => {
    mockedInvoke.mockRejectedValueOnce(new Error('fail'))
    await useBootStore.getState().boot()
    expect(useBootStore.getState().state).toBe('error')

    mockedInvoke.mockResolvedValueOnce({ items: [], next_cursor: null, has_more: false })
    await useBootStore.getState().boot()
    expect(useBootStore.getState().state).toBe('ready')
  })

  it('recovering state is observable during boot', async () => {
    // Use a deferred promise so we can observe state mid-boot
    let resolveInvoke: (v: unknown) => void
    const invokePromise = new Promise((resolve) => {
      resolveInvoke = resolve
    })
    mockedInvoke.mockReturnValueOnce(invokePromise as Promise<unknown>)

    const bootPromise = useBootStore.getState().boot()

    // While invoke is pending, state should be 'recovering'
    expect(useBootStore.getState().state).toBe('recovering')

    resolveInvoke!({ items: [], next_cursor: null, has_more: false })
    await bootPromise

    expect(useBootStore.getState().state).toBe('ready')
  })
})
