/**
 * #2671 — dedicated test for the browse-grid picker's lazy-dataset loading
 * window: `<EmojiPicker>` must render usably (search box, skin-tone
 * swatches, an empty grid with a "Loading emoji…" placeholder) BEFORE
 * `loadEmojiDataset()` resolves, then populate the grid once it does —
 * instead of racing the async gap or crashing on it.
 *
 * A dedicated file (rather than a case in `EmojiPicker.test.tsx`) because the
 * `vi.mock('@/editor/emoji-data', …)` factory below holds the dataset promise
 * open until the test manually resolves it — every other EmojiPicker test
 * wants the real, already-resolving loader, not a deferred one.
 */
import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { mockReactVirtual } from '@/__tests__/mocks/react-virtual'
import type { EmojiDataset } from '@/editor/emoji-data'
import { logger } from '@/lib/logger'

vi.mock('@tanstack/react-virtual', () => mockReactVirtual({ windowSize: 80 }))

/** Set by the mocked `loadEmojiDataset()` below; each test settles it explicitly. */
let resolveDataset: ((dataset: EmojiDataset) => void) | undefined
let rejectDataset: ((err: unknown) => void) | undefined
let loadCalls = 0

// `vi.mock` factories are hoisted above every import in this file (including
// the `EmojiPicker` import below), so the component picks up this deferred
// loader rather than the real, already-resolving one.
vi.mock('@/editor/emoji-data', async () => {
  const actual = await vi.importActual<typeof import('@/editor/emoji-data')>('@/editor/emoji-data')
  return {
    ...actual,
    loadEmojiDataset: () => {
      loadCalls++
      return new Promise<EmojiDataset>((resolve, reject) => {
        resolveDataset = resolve
        rejectDataset = reject
      })
    },
  }
})

import { EmojiPicker } from '@/components/EmojiPicker/EmojiPicker'

afterEach(() => {
  resolveDataset = undefined
  rejectDataset = undefined
  loadCalls = 0
  vi.restoreAllMocks()
})

describe('<EmojiPicker> — lazy dataset loading window (#2671)', () => {
  it('renders search + skin-tone + a loading placeholder before the dataset resolves, then populates the grid', async () => {
    const { rerender } = render(<EmojiPicker onSelect={vi.fn()} autoFocusSearch={false} />)

    // Search box, skin-tone swatches, and the grid container mount
    // immediately — none of them need the dataset.
    expect(screen.getByRole('searchbox', { name: /search emoji/i })).toBeInTheDocument()
    expect(screen.getByRole('radiogroup', { name: /skin tone/i })).toBeInTheDocument()
    expect(screen.getByRole('grid', { name: /emoji/i })).toBeInTheDocument()
    // The dataset promise is deliberately held open (mocked above) — no rows
    // yet, and the loading placeholder is shown in their place.
    expect(screen.getByTestId('emoji-loading')).toBeInTheDocument()
    expect(screen.queryByRole('gridcell', { name: 'grinning' })).not.toBeInTheDocument()
    expect(screen.queryByRole('tablist', { name: /emoji categories/i })).not.toBeInTheDocument()

    // A re-render while still loading must not re-invoke the loader (the
    // mount effect has an empty dep array).
    rerender(<EmojiPicker onSelect={vi.fn()} autoFocusSearch={false} />)
    expect(loadCalls).toBe(1)

    // Resolve with the REAL dataset (so the eventual content is meaningful),
    // simulating the dynamic import settling after first paint.
    const actual =
      await vi.importActual<typeof import('@/editor/emoji-data')>('@/editor/emoji-data')
    const dataset = await actual.loadEmojiDataset()
    resolveDataset?.(dataset)

    expect(await screen.findByRole('gridcell', { name: 'grinning' })).toBeInTheDocument()
    expect(screen.queryByTestId('emoji-loading')).not.toBeInTheDocument()
    expect(screen.getByRole('tablist', { name: /emoji categories/i })).toBeInTheDocument()
  })

  // #4445 — the loader is a dynamic `import()`, so it CAN reject (a chunk that
  // fails to fetch). Without a `.catch` that rejection was unhandled: no log,
  // no toast, and the grid sits on its placeholder with nothing to diagnose.
  it('logs the failure and keeps the picker usable when the dataset load rejects', async () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {})
    const loadErr = new Error('chunk load failed')

    render(<EmojiPicker onSelect={vi.fn()} autoFocusSearch={false} />)
    rejectDataset?.(loadErr)

    await waitFor(() => {
      expect(errorSpy).toHaveBeenCalledWith(
        'EmojiPicker',
        'Failed to load emoji dataset',
        undefined,
        loadErr,
      )
    })
    // The picker stays mounted on its loading placeholder rather than crashing.
    expect(screen.getByRole('searchbox', { name: /search emoji/i })).toBeInTheDocument()
    expect(screen.getByTestId('emoji-loading')).toBeInTheDocument()
  })
})
