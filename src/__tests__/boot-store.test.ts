import { beforeEach, describe, expect, it } from 'vitest'
import { useBootStore } from '../stores/boot'

describe('useBootStore', () => {
  beforeEach(() => {
    // Reset the store state between tests
    useBootStore.setState({ state: 'booting', error: null })
  })

  it('starts in booting state', () => {
    const { state } = useBootStore.getState()
    expect(state).toBe('booting')
  })

  it('boot() transitions synchronously to ready (startup-latency Phase 2)', async () => {
    // Phase 2: the `invoke('list_blocks')` handshake was dropped. boot()
    // now sets state to 'ready' on its first call without issuing any IPC.
    await useBootStore.getState().boot()

    expect(useBootStore.getState().state).toBe('ready')
    expect(useBootStore.getState().error).toBeNull()
  })

  it('error state can be driven externally and retried via boot()', async () => {
    // The `error` state is preserved as an externally-triggerable surface
    // (e.g., a future fatal IPC outage that wants the full-screen recovery
    // prompt). Verify the round-trip: external setState → 'error' →
    // boot() → 'ready'.
    useBootStore.setState({ state: 'error', error: 'externally-driven failure' })
    expect(useBootStore.getState().state).toBe('error')

    await useBootStore.getState().boot()
    expect(useBootStore.getState().state).toBe('ready')
    expect(useBootStore.getState().error).toBeNull()
  })
})
