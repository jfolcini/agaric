/**
 * Tests for `activeSpaceKey()` — the shared 3-line helper extracted in
 * PEND-30 L-1 from the four per-space partition stores
 * (`navigation.ts`, `journal.ts`, `tabs.ts`, `recent-pages.ts`).
 *
 * Verifies the two branches: returns `currentSpaceId` when set, falls
 * back to `LEGACY_SPACE_KEY` when null.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LEGACY_SPACE_KEY, useSpaceStore } from '../../stores/space'
import { activeSpaceKey } from '../active-space'

const initial = useSpaceStore.getState()

beforeEach(() => {
  useSpaceStore.setState({ ...initial, currentSpaceId: null })
})

afterEach(() => {
  useSpaceStore.setState({ ...initial })
})

describe('activeSpaceKey', () => {
  it('returns currentSpaceId when a space is selected', () => {
    useSpaceStore.setState({ currentSpaceId: 'SPACE_PERSONAL' })
    expect(activeSpaceKey()).toBe('SPACE_PERSONAL')
  })

  it('falls back to LEGACY_SPACE_KEY when currentSpaceId is null', () => {
    useSpaceStore.setState({ currentSpaceId: null })
    expect(activeSpaceKey()).toBe(LEGACY_SPACE_KEY)
  })
})
