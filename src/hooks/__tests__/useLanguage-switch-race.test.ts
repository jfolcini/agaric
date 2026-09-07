/**
 * #4812 — the user picks Espanol, changes their mind, and picks English
 * again before the Spanish catalog chunk has loaded.
 *
 * Its own file because the whole point is a catalog load that is still in
 * flight when the second pick happens, and `loadLocale` memoizes per module
 * graph: once any test in a file has loaded `es`, the chunk settles inside
 * the same `act` and the two picks never interleave — the shape the issue
 * says makes a naive test pass with or without the fix. The mock below holds
 * `import('@/lib/i18n/es')` open until the test releases it, so the settle
 * ORDER is the test's to choose: request `es`, request `en`, let `en` land,
 * then let `es` settle late.
 */

import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useLanguage } from '@/hooks/useLanguage'
import { i18n } from '@/lib/i18n'

const spanishChunk = vi.hoisted(() => {
  let release = (): void => {}
  const settled = new Promise<void>((resolve) => {
    release = resolve
  })
  return { release, settled }
})

vi.mock('@/lib/i18n/es', async () => {
  await spanishChunk.settled
  return { es: { 'error.generic': 'Algo ha salido mal' } }
})

beforeEach(() => {
  localStorage.clear()
})

afterEach(async () => {
  localStorage.clear()
  // A test that failed before releasing would otherwise leave the chunk —
  // and the worker's module graph — waiting forever.
  spanishChunk.release()
  vi.restoreAllMocks()
  await act(async () => {
    await i18n.changeLanguage('en')
  })
})

describe('switching language twice before the first catalog settles', () => {
  it('ends in the language picked last, not the one abandoned mid-load', async () => {
    const changeLanguage = vi.spyOn(i18n, 'changeLanguage')
    const { result } = renderHook(() => useLanguage())

    await act(async () => {
      result.current.setLanguage('es')
    })
    expect(i18n.language).toBe('en') // the chunk is still hanging

    await act(async () => {
      result.current.setLanguage('en')
    })
    // `en` is bundled, so its switch lands immediately. Asserted on the call
    // rather than on `i18n.language`, which never left 'en' and so cannot
    // tell "switched back" from "never switched"; it also pins the ordering
    // the rest of the test depends on.
    expect(changeLanguage).toHaveBeenCalledTimes(1)
    expect(changeLanguage).toHaveBeenCalledWith('en')

    await act(async () => {
      spanishChunk.release()
      await spanishChunk.settled
    })
    // The abandoned load really did settle — without this the assertions
    // below would pass before the race had even happened.
    await waitFor(() => {
      expect(i18n.hasResourceBundle('es', 'translation')).toBe(true)
    })

    expect(i18n.language).toBe('en')
    expect(i18n.t('error.generic')).toBe('Something went wrong')
    expect(document.documentElement.lang).toBe('en')
    expect(result.current.language).toBe('en')
  })
})
