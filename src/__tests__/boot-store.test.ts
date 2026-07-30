import { invoke } from '@tauri-apps/api/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { mockInvokeCommands } from '@/__tests__/helpers/invoke'
import { useBootStore } from '@/stores/boot'
import { useSpaceStore } from '@/stores/space'

describe('useBootStore', () => {
  beforeEach(() => {
    // Reset the store state between tests
    useBootStore.setState({ state: 'booting', error: null })
    useSpaceStore.setState({ availableSpaces: [], lastRefreshOutcome: { kind: 'ok' } })
    // #3225 — `boot()` DOES issue IPC: it awaits the space store's
    // `refreshAvailableSpaces()`, which calls `list_spaces`. Until the
    // strict fallback landed, that call fell through to a mock resolving
    // `undefined`, which `unwrap` reports as success — the store logged
    // "list_spaces returned a non-array response; treating as empty" and
    // the assertions below passed against a shape production never sends.
    vi.mocked(invoke).mockImplementation(mockInvokeCommands({ list_spaces: () => [] }))
  })

  it('starts in booting state', () => {
    const { state } = useBootStore.getState()
    expect(state).toBe('booting')
  })

  it('boot() transitions to ready once the space store has hydrated', async () => {
    // Phase 2 dropped the artificial `invoke('list_blocks')` handshake;
    // #2921 then made `boot()` await the space store's
    // `refreshAvailableSpaces()` (a real `list_spaces` IPC, stubbed above)
    // and flip to 'ready' when it reports a non-hard-error outcome.
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
