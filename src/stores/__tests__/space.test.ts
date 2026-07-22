/**
 * Tests for `useSpaceStore` (Phase 1).
 *
 * Covers:
 *  - Fresh-state defaults
 *  - `refreshAvailableSpaces` happy path
 *  - IPC error path — logs warn, flips `isReady`, leaves `availableSpaces`
 *  - Stale `currentSpaceId` reconciliation on rehydrate
 *  - `setCurrentSpace` updates state + persists via middleware
 */

import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { logger } from '@/lib/logger'
import type { SpaceRow } from '@/lib/tauri'
import { listSpaces } from '@/lib/tauri'
import { useSpaceStore } from '@/stores/space'

vi.mock('@/lib/tauri', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/tauri')>()
  return {
    ...actual,
    listSpaces: vi.fn(),
  }
})

const mockedListSpaces = vi.mocked(listSpaces)

const STORAGE_KEY = 'agaric:space'

const PERSONAL: SpaceRow = { id: 'SPACE_AAAA', name: 'Personal', accent_color: 'accent-emerald' }
const WORK: SpaceRow = { id: 'SPACE_ZZZZ', name: 'Work', accent_color: 'accent-blue' }

beforeEach(() => {
  useSpaceStore.setState({
    currentSpaceId: null,
    availableSpaces: [],
    isReady: false,
  })
  localStorage.clear()
  vi.clearAllMocks()
})

describe('useSpaceStore', () => {
  describe('initial state', () => {
    it('starts with null currentSpaceId, empty availableSpaces, and isReady=false', () => {
      const state = useSpaceStore.getState()
      expect(state.currentSpaceId).toBeNull()
      expect(state.availableSpaces).toEqual([])
      expect(state.isReady).toBe(false)
    })
  })

  describe('refreshAvailableSpaces', () => {
    it('fetches spaces, populates availableSpaces, and flips isReady to true', async () => {
      mockedListSpaces.mockResolvedValueOnce([PERSONAL, WORK])

      await useSpaceStore.getState().refreshAvailableSpaces()

      const state = useSpaceStore.getState()
      expect(state.availableSpaces).toEqual([PERSONAL, WORK])
      expect(state.isReady).toBe(true)
      // With no prior currentSpaceId, the store falls back to the first
      // alphabetical entry — Personal.
      expect(state.currentSpaceId).toBe(PERSONAL.id)
    })

    it('preserves a valid currentSpaceId across refresh', async () => {
      useSpaceStore.setState({ currentSpaceId: WORK.id })
      mockedListSpaces.mockResolvedValueOnce([PERSONAL, WORK])

      await useSpaceStore.getState().refreshAvailableSpaces()

      expect(useSpaceStore.getState().currentSpaceId).toBe(WORK.id)
    })

    it('on IPC error, logs warn, flips isReady, and leaves availableSpaces unchanged', async () => {
      const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
      // Seed a prior snapshot so we can verify it is untouched.
      useSpaceStore.setState({ availableSpaces: [PERSONAL], currentSpaceId: PERSONAL.id })

      mockedListSpaces.mockRejectedValueOnce(new Error('fail'))

      await useSpaceStore.getState().refreshAvailableSpaces()

      const state = useSpaceStore.getState()
      expect(state.isReady).toBe(true)
      expect(state.availableSpaces).toEqual([PERSONAL])
      expect(state.currentSpaceId).toBe(PERSONAL.id)
      expect(warnSpy).toHaveBeenCalledWith(
        'stores/space',
        expect.stringContaining('failed to load spaces'),
        undefined,
        expect.any(Error),
      )
    })

    // #2921 — hard-vs-soft failure classification.
    describe('#2921 hard vs soft failure', () => {
      it('SOFT: a usable prior snapshot (availableSpaces) survives — stays ready and fires a deduped toast once', async () => {
        useSpaceStore.setState({ availableSpaces: [PERSONAL], currentSpaceId: PERSONAL.id })
        mockedListSpaces.mockRejectedValueOnce(new Error('network down'))

        await useSpaceStore.getState().refreshAvailableSpaces()

        const state = useSpaceStore.getState()
        expect(state.isReady).toBe(true)
        expect(state.availableSpaces).toEqual([PERSONAL])
        expect(toast.error).toHaveBeenCalledTimes(1)
        expect(toast.error).toHaveBeenCalledWith(expect.any(String), { id: 'spaces-load-failed' })
      })

      it('SOFT: a usable prior snapshot (persisted currentSpaceId, empty availableSpaces) also stays ready', async () => {
        // Rehydrated-but-not-yet-refreshed shape: currentSpaceId came back
        // from persisted storage but availableSpaces hasn't been fetched
        // yet this session.
        useSpaceStore.setState({ availableSpaces: [], currentSpaceId: WORK.id })
        mockedListSpaces.mockRejectedValueOnce(new Error('network down'))

        await useSpaceStore.getState().refreshAvailableSpaces()

        expect(useSpaceStore.getState().isReady).toBe(true)
        expect(toast.error).toHaveBeenCalledTimes(1)
      })

      it('HARD: no prior snapshot (empty availableSpaces AND null currentSpaceId) still resolves (never rejects), flips isReady, records a hard-error outcome, and does not toast', async () => {
        useSpaceStore.setState({ availableSpaces: [], currentSpaceId: null })
        const err = new Error('backend unreachable')
        mockedListSpaces.mockRejectedValueOnce(err)

        // `refreshAvailableSpaces` never rejects — SpaceSwitcher's
        // fire-and-forget `void refreshAvailableSpaces()` mount refresh
        // and SpaceManageDialog's awaited-but-uncaught refresh both rely
        // on that contract holding even on a hard failure.
        await expect(useSpaceStore.getState().refreshAvailableSpaces()).resolves.toBeUndefined()

        const state = useSpaceStore.getState()
        // `isReady` still flips (never freeze the UI here) — the boot
        // store is the one that reacts to `lastRefreshOutcome` and
        // decides whether to gate rendering on it via BootGate's `error`
        // state instead.
        expect(state.isReady).toBe(true)
        expect(state.lastRefreshOutcome).toEqual({ kind: 'hard-error', error: err })
        expect(toast.error).not.toHaveBeenCalled()
      })

      it('a subsequent successful refresh clears a prior hard-error outcome', async () => {
        useSpaceStore.setState({ availableSpaces: [], currentSpaceId: null })
        mockedListSpaces.mockRejectedValueOnce(new Error('backend unreachable'))
        await useSpaceStore.getState().refreshAvailableSpaces()
        expect(useSpaceStore.getState().lastRefreshOutcome.kind).toBe('hard-error')

        mockedListSpaces.mockResolvedValueOnce([PERSONAL, WORK])
        await useSpaceStore.getState().refreshAvailableSpaces()

        expect(useSpaceStore.getState().lastRefreshOutcome).toEqual({ kind: 'ok' })
      })
    })

    it('falls back to the first available space when the persisted id no longer exists', async () => {
      // Persisted `BOGUS` id (e.g. space deleted on another device).
      useSpaceStore.setState({ currentSpaceId: 'BOGUS' })
      mockedListSpaces.mockResolvedValueOnce([PERSONAL, WORK])

      await useSpaceStore.getState().refreshAvailableSpaces()

      expect(useSpaceStore.getState().currentSpaceId).toBe(PERSONAL.id)
    })

    // Sub-fix 3: when sync brings down the deletion of the
    // active space we silently switch to the first available one.
    // Surface a one-shot toast so the user understands why they're now
    // looking at a different space without having clicked anything.
    describe('active-space-deleted toast', () => {
      it('fires a warning toast when the active space disappears mid-session', async () => {
        useSpaceStore.setState({ currentSpaceId: WORK.id })
        // Sync brings down a list that no longer contains WORK.
        mockedListSpaces.mockResolvedValueOnce([PERSONAL])

        await useSpaceStore.getState().refreshAvailableSpaces()

        expect(useSpaceStore.getState().currentSpaceId).toBe(PERSONAL.id)
        expect(toast.warning).toHaveBeenCalledTimes(1)
        expect(toast.warning).toHaveBeenCalledWith(
          'Your active space was deleted on another device. Switched to Personal.',
        )
      })

      it('does not toast on first boot when no prior space was set', async () => {
        // currentSpaceId is null (default).
        mockedListSpaces.mockResolvedValueOnce([PERSONAL, WORK])

        await useSpaceStore.getState().refreshAvailableSpaces()

        expect(useSpaceStore.getState().currentSpaceId).toBe(PERSONAL.id)
        expect(toast.warning).not.toHaveBeenCalled()
      })

      it('does not toast when the active space is preserved', async () => {
        useSpaceStore.setState({ currentSpaceId: WORK.id })
        mockedListSpaces.mockResolvedValueOnce([PERSONAL, WORK])

        await useSpaceStore.getState().refreshAvailableSpaces()

        expect(toast.warning).not.toHaveBeenCalled()
      })

      it('does not toast when the fallback finds no space at all', async () => {
        useSpaceStore.setState({ currentSpaceId: WORK.id })
        mockedListSpaces.mockResolvedValueOnce([])

        await useSpaceStore.getState().refreshAvailableSpaces()

        expect(useSpaceStore.getState().currentSpaceId).toBeNull()
        expect(toast.warning).not.toHaveBeenCalled()
      })
    })

    it('sets currentSpaceId to null when no spaces exist', async () => {
      useSpaceStore.setState({ currentSpaceId: 'WHATEVER' })
      mockedListSpaces.mockResolvedValueOnce([])

      await useSpaceStore.getState().refreshAvailableSpaces()

      expect(useSpaceStore.getState().currentSpaceId).toBeNull()
      expect(useSpaceStore.getState().availableSpaces).toEqual([])
      expect(useSpaceStore.getState().isReady).toBe(true)
    })
  })

  describe('setCurrentSpace', () => {
    it('updates currentSpaceId', () => {
      useSpaceStore.getState().setCurrentSpace(WORK.id)
      expect(useSpaceStore.getState().currentSpaceId).toBe(WORK.id)
    })

    it('persists currentSpaceId via zustand-persist middleware', () => {
      useSpaceStore.getState().setCurrentSpace(WORK.id)

      const raw = localStorage.getItem(STORAGE_KEY)
      expect(raw).not.toBeNull()
      const parsed = JSON.parse(raw as string)
      expect(parsed.state.currentSpaceId).toBe(WORK.id)
    })

    it('does not persist availableSpaces (server truth only)', async () => {
      mockedListSpaces.mockResolvedValueOnce([PERSONAL, WORK])
      await useSpaceStore.getState().refreshAvailableSpaces()

      const raw = localStorage.getItem(STORAGE_KEY)
      expect(raw).not.toBeNull()
      const parsed = JSON.parse(raw as string)
      // partialize() excludes availableSpaces + isReady.
      expect(parsed.state).not.toHaveProperty('availableSpaces')
      expect(parsed.state).not.toHaveProperty('isReady')
    })
  })

  describe('getCurrentAccent', () => {
    it('returns the active space accent token', () => {
      useSpaceStore.setState({
        currentSpaceId: PERSONAL.id,
        availableSpaces: [PERSONAL, WORK],
        isReady: true,
      })
      expect(useSpaceStore.getState().getCurrentAccent()).toBe('accent-emerald')
    })

    it('updates when the active space changes', () => {
      useSpaceStore.setState({
        currentSpaceId: PERSONAL.id,
        availableSpaces: [PERSONAL, WORK],
        isReady: true,
      })
      expect(useSpaceStore.getState().getCurrentAccent()).toBe('accent-emerald')
      useSpaceStore.getState().setCurrentSpace(WORK.id)
      expect(useSpaceStore.getState().getCurrentAccent()).toBe('accent-blue')
    })

    it('returns the fallback token when no space is active', () => {
      useSpaceStore.setState({
        currentSpaceId: null,
        availableSpaces: [],
        isReady: false,
      })
      // The fallback (`accent-blue`) lines up with Work's seed default
      // and the brand `--primary`. Defined as `DEFAULT_ACCENT_TOKEN`
      // in the store.
      expect(useSpaceStore.getState().getCurrentAccent()).toBe('accent-blue')
    })

    it('returns the fallback token when the active space has no accent_color', () => {
      const noAccent: SpaceRow = { id: 'SPACE_NA', name: 'NA', accent_color: null }
      useSpaceStore.setState({
        currentSpaceId: noAccent.id,
        availableSpaces: [noAccent],
        isReady: true,
      })
      expect(useSpaceStore.getState().getCurrentAccent()).toBe('accent-blue')
    })

    it('returns the fallback token when accent_color is an empty string', () => {
      const blankAccent: SpaceRow = { id: 'SPACE_B', name: 'Blank', accent_color: '' }
      useSpaceStore.setState({
        currentSpaceId: blankAccent.id,
        availableSpaces: [blankAccent],
        isReady: true,
      })
      expect(useSpaceStore.getState().getCurrentAccent()).toBe('accent-blue')
    })

    it('refreshes the selector after a refresh that changes the accent', async () => {
      // Initial state: Personal carries emerald.
      useSpaceStore.setState({
        currentSpaceId: PERSONAL.id,
        availableSpaces: [PERSONAL, WORK],
        isReady: true,
      })
      expect(useSpaceStore.getState().getCurrentAccent()).toBe('accent-emerald')

      // Sync brings down a recoloured Personal (emerald → violet).
      const recoloured: SpaceRow = {
        id: PERSONAL.id,
        name: PERSONAL.name,
        accent_color: 'accent-violet',
      }
      mockedListSpaces.mockResolvedValueOnce([recoloured, WORK])
      await useSpaceStore.getState().refreshAvailableSpaces()

      expect(useSpaceStore.getState().getCurrentAccent()).toBe('accent-violet')
    })
  })

  describe('rehydrate reconciliation', () => {
    it('keeps stored currentSpaceId when it still appears in the fresh list', async () => {
      // Simulate a prior session that persisted Work as the current space.
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ state: { currentSpaceId: WORK.id }, version: 0 }),
      )
      await useSpaceStore.persist.rehydrate()
      expect(useSpaceStore.getState().currentSpaceId).toBe(WORK.id)

      mockedListSpaces.mockResolvedValueOnce([PERSONAL, WORK])
      await useSpaceStore.getState().refreshAvailableSpaces()

      expect(useSpaceStore.getState().currentSpaceId).toBe(WORK.id)
    })

    it('falls back to first alphabetical space when stored id was deleted elsewhere', async () => {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ state: { currentSpaceId: 'BOGUS' }, version: 0 }),
      )
      await useSpaceStore.persist.rehydrate()

      mockedListSpaces.mockResolvedValueOnce([PERSONAL, WORK])
      await useSpaceStore.getState().refreshAvailableSpaces()

      expect(useSpaceStore.getState().currentSpaceId).toBe(PERSONAL.id)
    })
  })
})
