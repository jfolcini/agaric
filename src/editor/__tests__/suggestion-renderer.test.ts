import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSuggestionRenderer } from '../suggestion-renderer'

const { mockReactRenderer } = vi.hoisted(() => {
  // biome-ignore lint/suspicious/noExplicitAny: mock constructor requires dynamic this
  const mockReactRenderer = vi.fn().mockImplementation(function (this: any) {
    this.element = document.createElement('div')
    this.ref = null
    this.updateProps = vi.fn()
    this.destroy = vi.fn()
  })
  return { mockReactRenderer }
})

vi.mock('@tiptap/react', () => ({
  ReactRenderer: mockReactRenderer,
}))

describe('createSuggestionRenderer', () => {
  it('returns an object with the four lifecycle methods', () => {
    const renderer = createSuggestionRenderer()
    expect(renderer.onStart).toBeTypeOf('function')
    expect(renderer.onUpdate).toBeTypeOf('function')
    expect(renderer.onKeyDown).toBeTypeOf('function')
    expect(renderer.onExit).toBeTypeOf('function')
  })

  it('passes label prop to ReactRenderer when label is provided', () => {
    const renderer = createSuggestionRenderer('Tags')
    const mockRect = { left: 100, right: 120, top: 80, bottom: 100, width: 20, height: 20 }

    renderer.onStart({
      items: [],
      command: vi.fn(),
      clientRect: () => mockRect as DOMRect,
      // biome-ignore lint/suspicious/noExplicitAny: mock editor object
      editor: {} as any,
      query: '',
      range: { from: 0, to: 1 },
      text: '@',
      decorationNode: null,
      // biome-ignore lint/suspicious/noExplicitAny: partial mock of SuggestionProps
    } as any)

    expect(mockReactRenderer).toHaveBeenCalled()
    const lastCall = mockReactRenderer.mock.calls[mockReactRenderer.mock.calls.length - 1]
    expect(lastCall[1].props.label).toBe('Tags')

    // Clean up popup
    renderer.onExit()
  })

  it('onKeyDown returns false for non-Escape keys when no renderer exists', () => {
    const renderer = createSuggestionRenderer()
    // Before onStart is called, renderer.ref is null
    const result = renderer.onKeyDown({
      event: new KeyboardEvent('keydown', { key: 'ArrowUp' }),
      view: {} as never,
      range: { from: 0, to: 0 },
    })
    expect(result).toBe(false)
  })

  it('onExit is safe to call without prior onStart', () => {
    const renderer = createSuggestionRenderer()
    // Should not throw
    expect(() => renderer.onExit()).not.toThrow()
  })
})

describe('positioning', () => {
  afterEach(() => {
    // Clean up popup elements
    for (const el of document.querySelectorAll('.suggestion-popup')) {
      el.remove()
    }
  })

  it('positions popup at rect.right for multi-char triggers like [[', () => {
    const renderer = createSuggestionRenderer()
    const mockRect = { left: 50, right: 70, top: 80, bottom: 100, width: 20, height: 20 }

    renderer.onStart({
      items: [],
      command: vi.fn(),
      clientRect: () => mockRect as DOMRect,
      // biome-ignore lint/suspicious/noExplicitAny: mock editor object
      editor: {} as any,
      query: '',
      range: { from: 0, to: 2 },
      text: '[[',
      decorationNode: null,
      // biome-ignore lint/suspicious/noExplicitAny: partial mock of SuggestionProps
    } as any)

    const popup = document.querySelector('.suggestion-popup') as HTMLElement
    expect(popup).toBeTruthy()
    // Should use rect.right (70) since width > 1
    expect(popup.style.left).toBe('70px')
  })

  it('positions popup at rect.left for caret-width triggers', () => {
    const renderer = createSuggestionRenderer()
    const mockRect = { left: 100, right: 101, top: 80, bottom: 100, width: 1, height: 20 }

    renderer.onStart({
      items: [],
      command: vi.fn(),
      clientRect: () => mockRect as DOMRect,
      // biome-ignore lint/suspicious/noExplicitAny: mock editor object
      editor: {} as any,
      query: '',
      range: { from: 0, to: 1 },
      text: '@',
      decorationNode: null,
      // biome-ignore lint/suspicious/noExplicitAny: partial mock of SuggestionProps
    } as any)

    const popup = document.querySelector('.suggestion-popup') as HTMLElement
    expect(popup).toBeTruthy()
    // Should use rect.left (100) since width <= 1
    expect(popup.style.left).toBe('100px')
  })

  it('places popup below trigger by default', () => {
    const renderer = createSuggestionRenderer()
    const mockRect = { left: 100, right: 120, top: 80, bottom: 100, width: 20, height: 20 }

    renderer.onStart({
      items: [],
      command: vi.fn(),
      clientRect: () => mockRect as DOMRect,
      // biome-ignore lint/suspicious/noExplicitAny: mock editor object
      editor: {} as any,
      query: '',
      range: { from: 0, to: 2 },
      text: '[[',
      decorationNode: null,
      // biome-ignore lint/suspicious/noExplicitAny: partial mock of SuggestionProps
    } as any)

    const popup = document.querySelector('.suggestion-popup') as HTMLElement
    expect(popup).toBeTruthy()
    // top = rect.bottom + 4 = 104
    expect(popup.style.top).toBe('104px')
  })

  it('enforces minimum left of 8px', () => {
    const renderer = createSuggestionRenderer()
    const mockRect = { left: 2, right: 4, top: 80, bottom: 100, width: 2, height: 20 }

    renderer.onStart({
      items: [],
      command: vi.fn(),
      clientRect: () => mockRect as DOMRect,
      // biome-ignore lint/suspicious/noExplicitAny: mock editor object
      editor: {} as any,
      query: '',
      range: { from: 0, to: 2 },
      text: '[[',
      decorationNode: null,
      // biome-ignore lint/suspicious/noExplicitAny: partial mock of SuggestionProps
    } as any)

    const popup = document.querySelector('.suggestion-popup') as HTMLElement
    expect(popup).toBeTruthy()
    // left should be clamped to at least 8
    expect(popup.style.left).toBe('8px')
  })

  it('cleans up popup on onExit', () => {
    const renderer = createSuggestionRenderer()
    const mockRect = { left: 100, right: 120, top: 80, bottom: 100, width: 20, height: 20 }

    renderer.onStart({
      items: [],
      command: vi.fn(),
      clientRect: () => mockRect as DOMRect,
      // biome-ignore lint/suspicious/noExplicitAny: mock editor object
      editor: {} as any,
      query: '',
      range: { from: 0, to: 2 },
      text: '[[',
      decorationNode: null,
      // biome-ignore lint/suspicious/noExplicitAny: partial mock of SuggestionProps
    } as any)

    expect(document.querySelector('.suggestion-popup')).toBeTruthy()
    renderer.onExit()
    expect(document.querySelector('.suggestion-popup')).toBeNull()
  })

  it('updates position on onUpdate', () => {
    const renderer = createSuggestionRenderer()
    const mockRect1 = { left: 50, right: 70, top: 80, bottom: 100, width: 20, height: 20 }

    renderer.onStart({
      items: [],
      command: vi.fn(),
      clientRect: () => mockRect1 as DOMRect,
      // biome-ignore lint/suspicious/noExplicitAny: mock editor object
      editor: {} as any,
      query: '',
      range: { from: 0, to: 2 },
      text: '[[',
      decorationNode: null,
      // biome-ignore lint/suspicious/noExplicitAny: partial mock of SuggestionProps
    } as any)

    const popup = document.querySelector('.suggestion-popup') as HTMLElement
    expect(popup.style.left).toBe('70px')

    // Update with new position
    const mockRect2 = { left: 200, right: 220, top: 80, bottom: 100, width: 20, height: 20 }
    renderer.onUpdate({
      items: [],
      command: vi.fn(),
      clientRect: () => mockRect2 as DOMRect,
      // biome-ignore lint/suspicious/noExplicitAny: mock editor object
      editor: {} as any,
      query: 'a',
      range: { from: 0, to: 3 },
      text: '[[a',
      decorationNode: null,
      // biome-ignore lint/suspicious/noExplicitAny: partial mock of SuggestionProps
    } as any)

    expect(popup.style.left).toBe('220px')
  })

  it('does not throw when clientRect returns null', () => {
    const renderer = createSuggestionRenderer()

    expect(() => {
      renderer.onStart({
        items: [],
        command: vi.fn(),
        clientRect: () => null,
        // biome-ignore lint/suspicious/noExplicitAny: mock editor object
        editor: {} as any,
        query: '',
        range: { from: 0, to: 1 },
        text: '@',
        decorationNode: null,
        // biome-ignore lint/suspicious/noExplicitAny: partial mock of SuggestionProps
      } as any)
    }).not.toThrow()

    // Popup is created but no positioning styles are applied (early return)
    const popup = document.querySelector('.suggestion-popup') as HTMLElement
    expect(popup).toBeTruthy()
    expect(popup.style.position).toBe('')

    renderer.onExit()
  })

  it('falls back to window.innerHeight when visualViewport is null', () => {
    const original = window.visualViewport
    Object.defineProperty(window, 'visualViewport', {
      value: null,
      writable: true,
      configurable: true,
    })

    const renderer = createSuggestionRenderer()
    const mockRect = { left: 100, right: 120, top: 80, bottom: 100, width: 20, height: 20 }

    renderer.onStart({
      items: [],
      command: vi.fn(),
      clientRect: () => mockRect as DOMRect,
      // biome-ignore lint/suspicious/noExplicitAny: mock editor object
      editor: {} as any,
      query: '',
      range: { from: 0, to: 2 },
      text: '[[',
      decorationNode: null,
      // biome-ignore lint/suspicious/noExplicitAny: partial mock of SuggestionProps
    } as any)

    const popup = document.querySelector('.suggestion-popup') as HTMLElement
    expect(popup).toBeTruthy()
    // Should still position correctly using window.innerHeight fallback
    expect(popup.style.top).toBe('104px')

    renderer.onExit()

    Object.defineProperty(window, 'visualViewport', {
      value: original,
      writable: true,
      configurable: true,
    })
  })

  it('clamps top to minimum 8px when popup is taller than available space', () => {
    const renderer = createSuggestionRenderer()
    // In jsdom, el.offsetHeight is 0 so popupHeight defaults to 200.
    // Default window.innerHeight is 768 so viewportHeight = 768.
    // Place below: top = 600 + 4 = 604, 604 + 200 = 804 > 760 → flip above.
    // Place above: top = 100 - 200 - 4 = -104 → Math.max(8, -104) = 8.
    const mockRect = { left: 100, right: 120, top: 100, bottom: 600, width: 20, height: 500 }

    renderer.onStart({
      items: [],
      command: vi.fn(),
      clientRect: () => mockRect as DOMRect,
      // biome-ignore lint/suspicious/noExplicitAny: mock editor object
      editor: {} as any,
      query: '',
      range: { from: 0, to: 2 },
      text: '[[',
      decorationNode: null,
      // biome-ignore lint/suspicious/noExplicitAny: partial mock of SuggestionProps
    } as any)

    const popup = document.querySelector('.suggestion-popup') as HTMLElement
    expect(popup).toBeTruthy()
    expect(popup.style.top).toBe('8px')

    renderer.onExit()
  })
})
