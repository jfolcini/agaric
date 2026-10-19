/**
 * The search sheet's embedded segments load with the sheet's own chunk, so the
 * sheet's first open renders its segment without suspending. A segment that
 * suspends commits the fallback, and React holds it back 300 ms after that.
 *
 * Its own file because the lazy segments are module singletons: once any test
 * renders a segment, its chunk counts as loaded for the rest of the file.
 */

import { act, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { SearchSheet } from '@/components/mobile/SearchSheet'
import { useInPageFindStore } from '@/stores/useInPageFindStore'
import { useSearchSheetStore } from '@/stores/useSearchSheetStore'

vi.mock('@/components/query/InPageFind', () => ({
  InPageFind: () => <div data-testid="in-page-find-stub" />,
}))
vi.mock('@/components/common/CommandPalette', () => ({
  PaletteBody: () => <div data-testid="palette-body-stub" />,
}))

describe('SearchSheet — segment preload', () => {
  it('renders each segment on its first open without suspending', async () => {
    // Let the module-level preload settle, as it does at idle in the app.
    await act(async () => {
      await Promise.all([
        import('@/components/query/InPageFind'),
        import('@/components/common/CommandPalette'),
      ])
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    act(() => useSearchSheetStore.getState().open$('all-pages'))
    render(<SearchSheet />)
    // Synchronous: a segment that suspends is still absent right after the render.
    expect(screen.getByTestId('palette-body-stub')).toBeInTheDocument()

    act(() => {
      useInPageFindStore.setState({ container: document.body })
      useSearchSheetStore.getState().setMode('in-page')
    })
    expect(screen.getByTestId('in-page-find-stub')).toBeInTheDocument()
  })
})
