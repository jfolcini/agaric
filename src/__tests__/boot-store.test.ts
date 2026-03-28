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

  it('transitions to ready on successful boot', async () => {
    mockedInvoke.mockResolvedValueOnce({ items: [], next_cursor: null, has_more: false })
    await useBootStore.getState().boot()
    expect(useBootStore.getState().state).toBe('ready')
    expect(useBootStore.getState().error).toBeNull()
  })

  it('transitions to error on failed boot', async () => {
    mockedInvoke.mockRejectedValueOnce(new Error('DB connection failed'))
    await useBootStore.getState().boot()
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
})
