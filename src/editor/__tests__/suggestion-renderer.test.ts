import { describe, expect, it } from 'vitest'
import { createSuggestionRenderer } from '../suggestion-renderer'

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
