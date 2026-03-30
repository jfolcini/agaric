import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSuggestionRenderer } from '../suggestion-renderer'

vi.mock('@tiptap/react', () => ({
  ReactRenderer: vi.fn().mockImplementation(function (this: any) {
    this.element = document.createElement('div')
    this.ref = null
    this.updateProps = vi.fn()
    this.destroy = vi.fn()
  }),
}))

describe('createSuggestionRenderer', () => {
  it('returns an object with the four lifecycle methods', () => {
    const renderer = createSuggestionRenderer()
    expect(renderer.onStart).toBeTypeOf('function')
    expect(renderer.onUpdate).toBeTypeOf('function')
    expect(renderer.onKeyDown).toBeTypeOf('function')
    expect(renderer.onExit).toBeTypeOf('function')
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
      editor: {} as any,
      query: '',
      range: { from: 0, to: 2 },
      text: '[[',
      decorationNode: null,
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
      editor: {} as any,
      query: '',
      range: { from: 0, to: 1 },
      text: '@',
      decorationNode: null,
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
      editor: {} as any,
      query: '',
      range: { from: 0, to: 2 },
      text: '[[',
      decorationNode: null,
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
      editor: {} as any,
      query: '',
      range: { from: 0, to: 2 },
      text: '[[',
      decorationNode: null,
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
      editor: {} as any,
      query: '',
      range: { from: 0, to: 2 },
      text: '[[',
      decorationNode: null,
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
      editor: {} as any,
      query: '',
      range: { from: 0, to: 2 },
      text: '[[',
      decorationNode: null,
    } as any)

    const popup = document.querySelector('.suggestion-popup') as HTMLElement
    expect(popup.style.left).toBe('70px')

    // Update with new position
    const mockRect2 = { left: 200, right: 220, top: 80, bottom: 100, width: 20, height: 20 }
    renderer.onUpdate({
      items: [],
      command: vi.fn(),
      clientRect: () => mockRect2 as DOMRect,
      editor: {} as any,
      query: 'a',
      range: { from: 0, to: 3 },
      text: '[[a',
      decorationNode: null,
    } as any)

    expect(popup.style.left).toBe('220px')
  })
})
