import { describe, expect, it } from 'vitest'

import { chooseSuggestionSide, placeSuggestionPopup } from '@/editor/suggestion-placement'

const viewport = { width: 1000, height: 800 }
const base = { viewport, popupWidth: 352, gap: 4, padding: 8 }

describe('chooseSuggestionSide', () => {
  it('opens below when the popup fits there', () => {
    expect(chooseSuggestionSide({ left: 0, top: 80, bottom: 100 }, 800, 340, 4, 8)).toBe('below')
  })

  it('opens above when below is too short and above has more room', () => {
    expect(chooseSuggestionSide({ left: 0, top: 600, bottom: 620 }, 800, 340, 4, 8)).toBe('above')
  })

  it('stays below when neither side fits but below has more room', () => {
    expect(chooseSuggestionSide({ left: 0, top: 150, bottom: 170 }, 400, 340, 4, 8)).toBe('below')
  })
})

describe('placeSuggestionPopup', () => {
  it('pins the top edge under the lowest line when below', () => {
    expect(
      placeSuggestionPopup({ ...base, anchor: { left: 120, top: 80, bottom: 120 }, side: 'below' }),
    ).toEqual({ left: 120, edge: 124, maxHeight: 668 })
  })

  it('pins the bottom edge over the highest line when above', () => {
    expect(
      placeSuggestionPopup({
        ...base,
        anchor: { left: 120, top: 600, bottom: 640 },
        side: 'above',
      }),
    ).toEqual({ left: 120, edge: 596, maxHeight: 588 })
  })

  it('keeps the popup inside the viewport horizontally', () => {
    const right = placeSuggestionPopup({
      ...base,
      anchor: { left: 900, top: 80, bottom: 100 },
      side: 'below',
    })
    expect(right?.left).toBe(1000 - 352 - 8)
    const left = placeSuggestionPopup({
      ...base,
      anchor: { left: -5, top: 80, bottom: 100 },
      side: 'below',
    })
    expect(left?.left).toBe(8)
  })

  it('never returns a negative height', () => {
    expect(
      placeSuggestionPopup({ ...base, anchor: { left: 0, top: 2, bottom: 20 }, side: 'above' })
        ?.maxHeight,
    ).toBe(0)
  })

  it('returns null for an anchor with no finite coordinates', () => {
    expect(
      placeSuggestionPopup({
        ...base,
        anchor: { left: Number.NaN, top: 0, bottom: 20 },
        side: 'below',
      }),
    ).toBeNull()
  })
})
