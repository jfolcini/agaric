import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { getActiveEditor } from '@/editor/active-editor'
import { useScrollIntoViewOnFocus } from '@/hooks/useScrollIntoViewOnFocus'

vi.mock('@/editor/active-editor', () => ({ getActiveEditor: vi.fn() }))

const revealCaret = vi.fn()

let scrollIntoView: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  revealCaret.mockClear()
  vi.mocked(getActiveEditor).mockReturnValue({
    commands: { scrollIntoView: revealCaret },
  } as unknown as ReturnType<typeof getActiveEditor>)
  scrollIntoView = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))

describe('useScrollIntoViewOnFocus', () => {
  it('scrolls the element into view a frame after it takes focus', async () => {
    const el = document.createElement('div')
    renderHook(() => useScrollIntoViewOnFocus({ current: el }, true))
    expect(scrollIntoView).not.toHaveBeenCalled()
    await nextFrame()
    expect(scrollIntoView).toHaveBeenCalledTimes(1)
    expect(scrollIntoView.mock.contexts[0]).toBe(el)
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' })
  })

  it("scrolls the editor's caret into view when the window resizes, as the keyboard opens", async () => {
    renderHook(() => useScrollIntoViewOnFocus({ current: document.createElement('div') }, true))
    await nextFrame()
    expect(revealCaret).not.toHaveBeenCalled()
    window.dispatchEvent(new Event('resize'))
    expect(revealCaret).toHaveBeenCalledTimes(1)
  })

  it('does not scroll an element without focus', async () => {
    renderHook(() => useScrollIntoViewOnFocus({ current: document.createElement('div') }, false))
    await nextFrame()
    window.dispatchEvent(new Event('resize'))
    expect(scrollIntoView).not.toHaveBeenCalled()
    expect(revealCaret).not.toHaveBeenCalled()
  })

  it('stops scrolling once focus has gone, even before the first frame', async () => {
    const { rerender } = renderHook(
      ({ focused }) =>
        useScrollIntoViewOnFocus({ current: document.createElement('div') }, focused),
      { initialProps: { focused: true } },
    )
    rerender({ focused: false })
    await nextFrame()
    window.dispatchEvent(new Event('resize'))
    expect(scrollIntoView).not.toHaveBeenCalled()
    expect(revealCaret).not.toHaveBeenCalled()
  })
})
