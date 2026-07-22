/**
 * Tests for `useBootStore` (#2921).
 *
 * Before this fix, `boot()` unconditionally set `state: 'ready'` once
 * `refreshAvailableSpaces()` settled — even when it hard-failed (no usable
 * prior snapshot), leaving the app on `ready` with `currentSpaceId: null`
 * and no toast/retry surface (every page load then silently no-ops,
 * `page-blocks.ts` `load()` early-returns, and the initial `loading: true`
 * skeleton spins forever).
 *
 * `refreshAvailableSpaces()` never rejects (see `space.test.ts` and
 * `space.ts`'s module doc — non-boot callers like `SpaceSwitcher`'s
 * fire-and-forget mount refresh rely on that). Instead it records a
 * `lastRefreshOutcome` on the space store, which `boot()` reads right
 * after its own `await` returns. These tests mock `@/stores/space` to
 * drive that outcome directly, independent of the space store's own
 * hard-vs-soft classification logic (covered separately).
 *
 * Covers:
 *  - happy path: `boot()` awaits `refreshAvailableSpaces()`, sees
 *    `{ kind: 'ok' }`, and flips to `'ready'`.
 *  - hard failure: `{ kind: 'hard-error', error }` flips `boot()` to
 *    `'error'`, carrying a display-ready message.
 *  - retry: re-invoking `boot()` (the BootGate retry button's path) after
 *    a hard failure can recover to `'ready'` on a subsequent success.
 *  - a non-Error hard-error value falls back to the generic
 *    `boot.spacesLoadFailed` copy instead of a useless `String(err)`.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useBootStore } from '@/stores/boot'
import type { SpaceRefreshOutcome } from '@/stores/space'

let mockOutcome: SpaceRefreshOutcome = { kind: 'ok' }
const mockRefreshAvailableSpaces = vi.fn(async () => {})

vi.mock('@/stores/space', () => ({
  useSpaceStore: {
    getState: () => ({
      refreshAvailableSpaces: mockRefreshAvailableSpaces,
      lastRefreshOutcome: mockOutcome,
    }),
  },
}))

beforeEach(() => {
  useBootStore.setState({ state: 'booting', error: null })
  mockRefreshAvailableSpaces.mockClear()
  mockOutcome = { kind: 'ok' }
})

describe('useBootStore', () => {
  it('boot() awaits refreshAvailableSpaces and flips to ready on a { kind: "ok" } outcome', async () => {
    mockOutcome = { kind: 'ok' }

    await useBootStore.getState().boot()

    expect(mockRefreshAvailableSpaces).toHaveBeenCalledTimes(1)
    expect(useBootStore.getState().state).toBe('ready')
    expect(useBootStore.getState().error).toBeNull()
  })

  it('boot() flips to error on a hard-error outcome, carrying the error message', async () => {
    mockOutcome = { kind: 'hard-error', error: new Error('backend unreachable') }

    await useBootStore.getState().boot()

    expect(useBootStore.getState().state).toBe('error')
    expect(useBootStore.getState().error).toBe('backend unreachable')
  })

  it('falls back to the generic boot.spacesLoadFailed copy for an unrecognized error value', async () => {
    // Not an Error, not a string/number — formatErrorForDisplay has
    // nothing readable to show, so it uses the fallback boot.ts supplies
    // instead of a useless `String(undefined)`.
    mockOutcome = { kind: 'hard-error', error: undefined }

    await useBootStore.getState().boot()

    expect(useBootStore.getState().state).toBe('error')
    expect(useBootStore.getState().error).toBe(
      'Could not load your spaces. Check your connection and try again.',
    )
  })

  it('retry: a subsequent successful boot() recovers from error to ready', async () => {
    mockOutcome = { kind: 'hard-error', error: new Error('backend unreachable') }
    await useBootStore.getState().boot()
    expect(useBootStore.getState().state).toBe('error')
    expect(useBootStore.getState().error).toBe('backend unreachable')

    // Retry re-invokes boot() (BootGate's retry button path); this time
    // the space store's refresh outcome is ok.
    mockOutcome = { kind: 'ok' }
    await useBootStore.getState().boot()

    expect(mockRefreshAvailableSpaces).toHaveBeenCalledTimes(2)
    expect(useBootStore.getState().state).toBe('ready')
    expect(useBootStore.getState().error).toBeNull()
  })
})
