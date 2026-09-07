/**
 * Tests for useLanguage (#4555) — the UI-language preference and the
 * side effect that actually applies it.
 */

import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useLanguage } from '@/hooks/useLanguage'
import { i18n } from '@/lib/i18n'

const KEY = 'agaric-language'

beforeEach(() => {
  localStorage.clear()
  vi.clearAllMocks()
})

afterEach(async () => {
  localStorage.clear()
  // i18next is a singleton shared by every suite in this worker.
  await act(async () => {
    await i18n.changeLanguage('en')
  })
})

describe('useLanguage', () => {
  it('defaults to English, NOT to the device', () => {
    const { result } = renderHook(() => useLanguage())
    // Phase 1 ships 42 of 3,056 keys. `'system'` would put a device set to
    // `es` into `<html lang="es">` over a ~99% English UI — the exact
    // mis-announcement `applyDocumentLang` exists to prevent — and hand
    // `SpeechRecognition.lang = 'es'` to someone dictating English, for a
    // user who never opened Settings and never saw the help text explaining
    // the gap. Flip this to `'system'` when a second catalog is substantially
    // translated, and change this test in the same commit.
    expect(result.current.language).toBe('en')
  })

  it('reads an explicit stored preference', () => {
    localStorage.setItem(KEY, 'es')
    const { result } = renderHook(() => useLanguage())
    expect(result.current.language).toBe('es')
  })

  it('falls back to the default for an unsupported stored value', () => {
    localStorage.setItem(KEY, 'fr')
    const { result } = renderHook(() => useLanguage())
    expect(result.current.language).toBe('en')
  })

  it('persists the choice and switches i18next to it', async () => {
    const { result } = renderHook(() => useLanguage())

    await act(async () => {
      result.current.setLanguage('es')
    })

    expect(localStorage.getItem(KEY)).toBe('es')
    await waitFor(() => {
      expect(i18n.language).toBe('es')
    })
    // The catalog is really there, not just the tag. The ORDERING claim
    // (the chunk is awaited before `changeLanguage`, so the UI never
    // flashes English mid-switch) is not what this proves — the `waitFor`
    // above would let a fire-and-forget load settle too. That claim is
    // pinned by `locales.test.ts`, which asserts the bundle synchronously
    // on `setLocale`'s own resolution.
    expect(i18n.t('error.generic')).toBe('Algo ha salido mal')
    // …and the DOM attribute the screen reader and `useVoiceInput` read
    // followed along.
    expect(document.documentElement.lang).toBe('es')
  })

  it('switches back to English, restoring English strings', async () => {
    localStorage.setItem(KEY, 'es')
    const { result } = renderHook(() => useLanguage())
    await waitFor(() => {
      expect(i18n.language).toBe('es')
    })

    await act(async () => {
      result.current.setLanguage('en')
    })

    await waitFor(() => {
      expect(i18n.language).toBe('en')
    })
    expect(i18n.t('error.generic')).toBe('Something went wrong')
    expect(document.documentElement.lang).toBe('en')
  })

  it('does no work when the stored preference already matches i18next', async () => {
    const changeLanguage = vi.spyOn(i18n, 'changeLanguage')
    renderHook(() => useLanguage())
    await waitFor(() => {
      expect(i18n.language).toBe('en')
    })
    expect(changeLanguage).not.toHaveBeenCalled()
    changeLanguage.mockRestore()
  })
})
