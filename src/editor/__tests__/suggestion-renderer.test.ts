import { PluginKey } from '@tiptap/pm/state'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MockInstance } from 'vitest'

import { createSuggestionRenderer } from '@/editor/suggestion-renderer'

const { mockReactRenderer } = vi.hoisted(() => {
  const reactRenderer = vi.fn().mockImplementation(function (this: any) {
    this.element = document.createElement('div')
    this.ref = null
    this.updateProps = vi.fn()
    this.destroy = vi.fn()
  })
  return { mockReactRenderer: reactRenderer }
})

vi.mock('@tiptap/react', () => ({
  ReactRenderer: mockReactRenderer,
}))

vi.mock('@floating-ui/dom', () => ({
  autoUpdate: vi.fn(() => vi.fn()),
}))

vi.mock('@/lib/keyboard-config', () => ({
  getShortcutKeys: vi.fn((id: string) => {
    const defaults: Record<string, string> = {
      suggestionClose: 'Escape',
      suggestionPassSpace: 'Space',
      suggestionAutocomplete: 'Tab',
    }
    return defaults[id] ?? ''
  }),
}))

// Mock requestAnimationFrame to execute synchronously so the deferred
// outside-click registration doesn't leak callbacks across tests.
vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
  cb(0)
  return 0
})

describe('createSuggestionRenderer', () => {
  it('returns an object with the four lifecycle methods', () => {
    const renderer = createSuggestionRenderer()
    expect(typeof renderer.onStart).toBe('function')
    expect(typeof renderer.onUpdate).toBe('function')
    expect(typeof renderer.onKeyDown).toBe('function')
    expect(typeof renderer.onExit).toBe('function')
  })

  it('passes label prop to ReactRenderer when label is provided', async () => {
    const renderer = createSuggestionRenderer('Tags')
    const mockRect = { left: 100, right: 120, top: 80, bottom: 100, width: 20, height: 20 }

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

    expect(mockReactRenderer).toHaveBeenCalled()
    const lastCall = mockReactRenderer.mock.calls.at(-1)
    expect(lastCall?.[1].props.label).toBe('Tags')

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

  it('onKeyDown returns false for Space so it passes through to editor as text', () => {
    const renderer = createSuggestionRenderer()
    const mockRect = { left: 100, right: 120, top: 80, bottom: 100, width: 20, height: 20 }

    renderer.onStart({
      items: [],
      command: vi.fn(),
      clientRect: () => mockRect as DOMRect,
      editor: {} as any,
      query: 'multi',
      range: { from: 0, to: 7 },
      text: '[[multi',
      decorationNode: null,
    } as any)

    const result = renderer.onKeyDown({
      event: new KeyboardEvent('keydown', { key: ' ' }),
      view: {} as never,
      range: { from: 0, to: 7 },
    })

    // Space must NOT be consumed — it should pass through so the user can
    // type multi-word queries like [[multi word page]]
    expect(result).toBe(false)

    renderer.onExit()
  })

  it('onExit is safe to call without prior onStart', () => {
    const renderer = createSuggestionRenderer()
    // Should not throw
    expect(() => renderer.onExit()).not.toThrow()
  })

  it('popup has role=region attribute', () => {
    const renderer = createSuggestionRenderer()
    const mockRect = { left: 100, right: 120, top: 80, bottom: 100, width: 20, height: 20 }

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
    expect(popup).toBeInTheDocument()
    expect(popup.getAttribute('role')).toBe('region')

    renderer.onExit()
  })

  it('popup has aria-label from label parameter', () => {
    const renderer = createSuggestionRenderer('Tags')
    const mockRect = { left: 100, right: 120, top: 80, bottom: 100, width: 20, height: 20 }

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
    expect(popup).toBeInTheDocument()
    expect(popup.getAttribute('aria-label')).toBe('Tags')

    renderer.onExit()
  })

  it('popup has default aria-label when no label provided', () => {
    const renderer = createSuggestionRenderer()
    const mockRect = { left: 100, right: 120, top: 80, bottom: 100, width: 20, height: 20 }

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
    expect(popup).toBeInTheDocument()
    expect(popup.getAttribute('aria-label')).toBe('Suggestions')

    renderer.onExit()
  })
})

describe('positioning', () => {
  const VIEW_W = 1000
  const VIEW_H = 800

  /** An editor whose `coordsAtPos(pos)` reads from `coords`, so a test can move the text. */
  function editorWith(coords: (pos: number) => { left: number; top: number; bottom: number }) {
    const dom = document.createElement('div')
    return { view: { dom, coordsAtPos: vi.fn(coords) } }
  }

  function props(editor: unknown, overrides: Record<string, unknown> = {}): any {
    return {
      items: [],
      command: vi.fn(),
      clientRect: null,
      editor,
      query: '',
      range: { from: 10, to: 12 },
      text: '[[',
      decorationNode: null,
      loading: true,
      ...overrides,
    }
  }

  /** The `update` callback the renderer handed to `autoUpdate`: what a scroll or resize runs. */
  async function layoutChange(): Promise<void> {
    const { autoUpdate } = await import('@floating-ui/dom')
    const update = vi.mocked(autoUpdate).mock.calls.at(-1)?.[2]
    if (!update) throw new Error('autoUpdate was not wired')
    update()
  }

  function popupEl(): HTMLElement {
    return document.querySelector('.suggestion-popup') as HTMLElement
  }

  beforeEach(() => {
    Object.defineProperty(document.documentElement, 'clientWidth', {
      configurable: true,
      value: VIEW_W,
    })
    Object.defineProperty(document.documentElement, 'clientHeight', {
      configurable: true,
      value: VIEW_H,
    })
  })

  afterEach(() => {
    for (const el of document.querySelectorAll('.suggestion-popup')) el.remove()
    Reflect.deleteProperty(document.documentElement, 'clientWidth')
    Reflect.deleteProperty(document.documentElement, 'clientHeight')
    vi.restoreAllMocks()
  })

  it('anchors to the trigger, not the caret, below the line', () => {
    const renderer = createSuggestionRenderer()
    renderer.onStart(props(editorWith((pos) => ({ left: pos * 10, top: 80, bottom: 100 }))))

    const popup = popupEl()
    expect(popup.style.position).toBe('fixed')
    expect(popup.style.zIndex).toBe('50')
    // range.from = 10 → left 100, not range.to = 12 → 120.
    expect(popup.style.left).toBe('100px')
    expect(popup.style.top).toBe('104px')
    expect(popup.style.bottom).toBe('')
    renderer.onExit()
  })

  it('follows the trigger when the query wraps it onto the next line', () => {
    let lineTop = 80
    const editor = editorWith(() => ({ left: 900, top: lineTop, bottom: lineTop + 20 }))
    const renderer = createSuggestionRenderer()
    renderer.onStart(props(editor))
    const popup = popupEl()
    expect(popup.style.top).toBe('104px')

    // The trigger word no longer fits its line and moves under it, but the
    // editor keeps its height, so no `autoUpdate` callback fires.
    lineTop = 100
    renderer.onUpdate(props(editor, { query: 'abc', range: { from: 10, to: 15 }, loading: true }))
    expect(popup.style.top).toBe('124px')
    renderer.onExit()
  })

  it('re-places on a layout change', async () => {
    let lineTop = 80
    const editor = editorWith(() => ({ left: 100, top: lineTop, bottom: lineTop + 20 }))
    const renderer = createSuggestionRenderer()
    renderer.onStart(props(editor))
    lineTop = 300
    await layoutChange()
    expect(popupEl().style.top).toBe('324px')
    renderer.onExit()
  })

  it('opens above when there is no room below, pinning its bottom edge, and stays above', async () => {
    let lineTop = 740
    const editor = editorWith(() => ({ left: 100, top: lineTop, bottom: lineTop + 20 }))
    const renderer = createSuggestionRenderer()
    renderer.onStart(props(editor))
    const popup = popupEl()
    // Bottom edge 4px above the line's top (740) → 800 - 736.
    expect(popup.style.top).toBe('')
    expect(popup.style.bottom).toBe('64px')
    expect(popup.style.maxHeight).toBe('728px')

    // Scrolled to where below would have room: the side holds.
    lineTop = 400
    await layoutChange()
    expect(popup.style.bottom).toBe('404px')
    expect(popup.style.top).toBe('')
    renderer.onExit()
  })

  it('sits below the lowest line when the query wraps', () => {
    const editor = editorWith((pos) =>
      pos === 10 ? { left: 900, top: 80, bottom: 100 } : { left: 20, top: 100, bottom: 120 },
    )
    const renderer = createSuggestionRenderer()
    renderer.onStart(props(editor))
    expect(popupEl().style.top).toBe('124px')
    renderer.onExit()
  })

  it('falls back to the plugin rect when coordsAtPos throws', () => {
    const editor = editorWith(() => {
      throw new Error('Position out of range')
    })
    const renderer = createSuggestionRenderer()
    renderer.onStart(
      props(editor, { clientRect: () => ({ left: 50, top: 80, bottom: 100 }) as DOMRect }),
    )
    expect(popupEl().style.left).toBe('50px')
    expect(popupEl().style.top).toBe('104px')
    renderer.onExit()
  })

  it('stays off-screen when nothing can be measured', () => {
    const renderer = createSuggestionRenderer()
    expect(() => renderer.onStart(props({}))).not.toThrow()
    expect(popupEl().style.left).toBe('-9999px')
    expect(popupEl().style.top).toBe('-9999px')
    renderer.onExit()
  })

  it('caps the height at 60vh with a 16px edge on coarse pointers', () => {
    vi.spyOn(window, 'matchMedia').mockImplementation(
      (query: string) => ({ matches: query === '(pointer: coarse)' }) as MediaQueryList,
    )
    const renderer = createSuggestionRenderer()
    renderer.onStart(props(editorWith(() => ({ left: 0, top: 80, bottom: 100 }))))
    const popup = popupEl()
    expect(popup.style.left).toBe('16px')
    expect(popup.style.maxHeight).toBe(`${window.innerHeight * 0.6}px`)
    expect(popup.style.overflowY).toBe('auto')
    renderer.onExit()
  })

  it('caps the height at the room left below on fine pointers', () => {
    const renderer = createSuggestionRenderer()
    renderer.onStart(props(editorWith(() => ({ left: 0, top: 80, bottom: 100 }))))
    const popup = popupEl()
    expect(popup.style.left).toBe('8px')
    expect(popup.style.maxHeight).toBe('688px')
    renderer.onExit()
  })

  it('stops layout tracking on onExit and on Escape', async () => {
    const { autoUpdate } = await import('@floating-ui/dom')
    const stops: Array<ReturnType<typeof vi.fn>> = []
    vi.mocked(autoUpdate).mockImplementation(() => {
      const stop = vi.fn()
      stops.push(stop)
      return stop
    })
    const editor = editorWith(() => ({ left: 0, top: 80, bottom: 100 }))

    const first = createSuggestionRenderer()
    first.onStart(props(editor))
    first.onExit()

    const second = createSuggestionRenderer()
    second.onStart(props(editor))
    second.onKeyDown({ event: new KeyboardEvent('keydown', { key: 'Escape' }) } as any)

    expect(stops).toHaveLength(2)
    expect(stops.map((stop) => stop.mock.calls.length)).toEqual([1, 1])
  })
})

describe('results while the next ones load', () => {
  const A = { id: 'A', label: 'Alpha' }

  function props(overrides: Record<string, unknown>): any {
    return {
      items: [],
      command: vi.fn(),
      clientRect: null,
      editor: {},
      query: '',
      range: { from: 0, to: 2 },
      text: '[[',
      decorationNode: null,
      loading: true,
      ...overrides,
    }
  }

  function lastRenderedItems(): unknown {
    const instance = mockReactRenderer.mock.instances.at(-1) as any
    return instance.updateProps.mock.calls.at(-1)?.[0].items
  }

  afterEach(() => {
    for (const el of document.querySelectorAll('.suggestion-popup')) el.remove()
  })

  it('stays hidden until the first results, then reveals once', () => {
    const renderer = createSuggestionRenderer()
    renderer.onStart(props({}))
    const popup = document.querySelector('.suggestion-popup') as HTMLElement
    expect(popup.style.visibility).toBe('hidden')
    expect(popup.dataset['open']).toBeUndefined()

    renderer.onUpdate(props({ loading: true }))
    expect(popup.style.visibility).toBe('hidden')

    renderer.onUpdate(props({ items: [A], loading: false }))
    expect(popup.style.visibility).toBe('')
    expect(popup.dataset['open']).toBe('')
    renderer.onExit()
  })

  it('keeps showing the previous results while the plugin fetches, then swaps', () => {
    const B = { id: 'B', label: 'Beta' }
    const renderer = createSuggestionRenderer()
    renderer.onStart(props({}))
    renderer.onUpdate(props({ items: [A], loading: false }))

    renderer.onUpdate(props({ query: 'b', items: [], loading: true }))
    expect(lastRenderedItems()).toEqual([A])

    renderer.onUpdate(props({ query: 'b', items: [B], loading: false }))
    expect(lastRenderedItems()).toEqual([B])

    // A settled empty result is shown as empty.
    renderer.onUpdate(props({ query: 'bz', items: [], loading: false }))
    expect(lastRenderedItems()).toEqual([])
    renderer.onExit()
  })
})

describe('outside-click dismissal', () => {
  function makeProps(): any {
    return {
      items: [],
      command: vi.fn(),
      clientRect: () =>
        ({ left: 100, right: 120, top: 80, bottom: 100, width: 20, height: 20 }) as DOMRect,
      editor: {} as any,
      query: '',
      range: { from: 0, to: 1 },
      text: '/',
      decorationNode: null,
    }
  }

  let addSpy: MockInstance
  let removeSpy: MockInstance

  beforeEach(() => {
    addSpy = vi.spyOn(document, 'addEventListener')
    removeSpy = vi.spyOn(document, 'removeEventListener')
  })

  afterEach(() => {
    addSpy.mockRestore()
    removeSpy.mockRestore()
    for (const el of document.querySelectorAll('.suggestion-popup')) {
      el.remove()
    }
  })

  it('registers a pointerdown listener on document in capture phase', () => {
    const renderer = createSuggestionRenderer()
    renderer.onStart(makeProps())

    expect(addSpy).toHaveBeenCalledWith('pointerdown', expect.any(Function), true)

    renderer.onExit()
  })

  it('removes popup when pointerdown fires outside', () => {
    const renderer = createSuggestionRenderer()
    renderer.onStart(makeProps())

    expect(document.querySelector('.suggestion-popup')).toBeInTheDocument()

    // Dispatch pointerdown on body (outside the popup)
    const event = new PointerEvent('pointerdown', { bubbles: true })
    document.body.dispatchEvent(event)

    expect(document.querySelector('.suggestion-popup')).toBeNull()
  })

  it('keeps popup open when pointerdown fires inside it', () => {
    const renderer = createSuggestionRenderer()
    renderer.onStart(makeProps())

    const popup = document.querySelector('.suggestion-popup') as HTMLElement
    expect(popup).toBeInTheDocument()

    // Dispatch pointerdown on the popup itself (inside click)
    const event = new PointerEvent('pointerdown', { bubbles: true })
    popup.dispatchEvent(event)

    expect(document.querySelector('.suggestion-popup')).toBeInTheDocument()
  })

  it('keeps popup open when pointerdown fires on a child of the popup', () => {
    const renderer = createSuggestionRenderer()
    renderer.onStart(makeProps())

    const popup = document.querySelector('.suggestion-popup') as HTMLElement
    const child = popup.querySelector('div') // ReactRenderer element
    expect(child).toBeInTheDocument()

    const event = new PointerEvent('pointerdown', { bubbles: true })
    child?.dispatchEvent(event)

    expect(document.querySelector('.suggestion-popup')).toBeInTheDocument()
  })

  it('removes the pointerdown listener on onExit', () => {
    const renderer = createSuggestionRenderer()
    renderer.onStart(makeProps())

    renderer.onExit()

    expect(removeSpy).toHaveBeenCalledWith('pointerdown', expect.any(Function), true)
  })

  it('removes the pointerdown listener when dismissed via outside click', () => {
    const renderer = createSuggestionRenderer()
    renderer.onStart(makeProps())

    removeSpy.mockClear()

    const event = new PointerEvent('pointerdown', { bubbles: true })
    document.body.dispatchEvent(event)

    expect(removeSpy).toHaveBeenCalledWith('pointerdown', expect.any(Function), true)
  })

  it('does not leak listeners across multiple open/close cycles', () => {
    const renderer = createSuggestionRenderer()

    // Cycle 1: open then outside-click dismiss
    renderer.onStart(makeProps())
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    expect(document.querySelector('.suggestion-popup')).toBeNull()

    // Cycle 2: open again, should work normally
    renderer.onStart(makeProps())
    expect(document.querySelector('.suggestion-popup')).toBeInTheDocument()

    // Close via onExit
    renderer.onExit()
    expect(document.querySelector('.suggestion-popup')).toBeNull()

    // Cycle 3: open and outside-click again
    renderer.onStart(makeProps())
    expect(document.querySelector('.suggestion-popup')).toBeInTheDocument()
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    expect(document.querySelector('.suggestion-popup')).toBeNull()
  })

  it('calls destroy on ReactRenderer when dismissed via outside click', () => {
    const renderer = createSuggestionRenderer()
    renderer.onStart(makeProps())

    // Get the last ReactRenderer instance
    const lastInstance: any = mockReactRenderer.mock.instances.at(-1)
    expect(lastInstance.destroy).not.toHaveBeenCalled()

    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))

    expect(lastInstance.destroy).toHaveBeenCalled()
  })

  it('removes popup and listener when Escape key is pressed', () => {
    const renderer = createSuggestionRenderer()
    renderer.onStart(makeProps())

    removeSpy.mockClear()
    expect(document.querySelector('.suggestion-popup')).toBeInTheDocument()

    const result = renderer.onKeyDown({
      event: new KeyboardEvent('keydown', { key: 'Escape' }),
      view: {} as never,
      range: { from: 0, to: 0 },
    })

    expect(result).toBe(true)
    expect(document.querySelector('.suggestion-popup')).toBeNull()
    expect(removeSpy).toHaveBeenCalledWith('pointerdown', expect.any(Function), true)
  })

  it('does not leak listeners when closed via Escape then reopened', () => {
    const renderer = createSuggestionRenderer()

    // Cycle 1: open then Escape
    renderer.onStart(makeProps())
    renderer.onKeyDown({
      event: new KeyboardEvent('keydown', { key: 'Escape' }),
      view: {} as never,
      range: { from: 0, to: 0 },
    })
    expect(document.querySelector('.suggestion-popup')).toBeNull()

    // Cycle 2: open again, outside-click should still work
    renderer.onStart(makeProps())
    expect(document.querySelector('.suggestion-popup')).toBeInTheDocument()
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    expect(document.querySelector('.suggestion-popup')).toBeNull()
  })

  // #727 — the closeKey (Escape) path previously destroyed the renderer + popup
  // but NEVER dispatched the plugin's `{ exit: true }` meta the way the
  // outside-click path does. The Suggestion plugin therefore stayed ACTIVE:
  // continued typing extended the query against a null renderer (the onUpdate
  // "plugin state desync" warn). These pin the exit dispatch on the close path.
  it('#727 dispatches {exit:true} on the plugin when closed via closeKey (Escape)', () => {
    const pluginKey = new PluginKey('test-suggestion')
    const setMeta = vi.fn().mockReturnThis()
    const dispatch = vi.fn()
    const mockEditor = {
      state: { tr: { setMeta } },
      view: { isDestroyed: false, dispatch },
    } as any

    const renderer = createSuggestionRenderer('Tags', pluginKey)
    const props = makeProps()
    props.editor = mockEditor
    renderer.onStart(props)

    const handled = renderer.onKeyDown({
      event: new KeyboardEvent('keydown', { key: 'Escape' }),
      view: {} as never,
      range: { from: 0, to: 0 },
    })

    // Close handled, plugin deactivated via exit meta, popup torn down.
    expect(handled).toBe(true)
    expect(setMeta).toHaveBeenCalledWith(pluginKey, { exit: true })
    expect(setMeta).toHaveBeenCalledWith('addToHistory', false)
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(document.querySelector('.suggestion-popup')).toBeNull()
  })

  it('#727 skips the closeKey exit dispatch when the view is destroyed but still cleans up', () => {
    const pluginKey = new PluginKey('test-suggestion')
    const dispatch = vi.fn()
    const mockEditor = {
      state: { tr: { setMeta: vi.fn().mockReturnThis() } },
      view: { isDestroyed: true, dispatch },
    } as any

    const renderer = createSuggestionRenderer('Tags', pluginKey)
    const props = makeProps()
    props.editor = mockEditor
    renderer.onStart(props)

    const handled = renderer.onKeyDown({
      event: new KeyboardEvent('keydown', { key: 'Escape' }),
      view: {} as never,
      range: { from: 0, to: 0 },
    })

    expect(handled).toBe(true)
    expect(dispatch).not.toHaveBeenCalled()
    expect(document.querySelector('.suggestion-popup')).toBeNull()
  })

  // Regression for the closePopup refactor: the old, per-path handlers only
  // ever nulled `editorRef` inside `onExit()`. The shared `closePopup()`
  // helper nulled it unconditionally, so a `dispatchExitMeta()` failure on
  // the Escape path (caught internally, logged, no re-entrant `onExit()`)
  // left no `editorRef` for a second Escape to retry with.
  it('retains editorRef so a second Escape can retry a failed dispatchExitMeta', () => {
    const pluginKey = new PluginKey('test-suggestion')
    const setMeta = vi.fn().mockReturnThis()
    const dispatch = vi.fn(() => {
      throw new Error('dispatch failed')
    })
    const mockEditor = {
      state: { tr: { setMeta } },
      view: { isDestroyed: false, dispatch },
    } as any

    const renderer = createSuggestionRenderer('Tags', pluginKey)
    const props = makeProps()
    props.editor = mockEditor
    renderer.onStart(props)

    // First Escape: dispatchExitMeta() throws internally (caught + logged).
    // The popup is still torn down, but editorRef must survive for a retry.
    const firstHandled = renderer.onKeyDown({
      event: new KeyboardEvent('keydown', { key: 'Escape' }),
      view: {} as never,
      range: { from: 0, to: 0 },
    })
    expect(firstHandled).toBe(true)
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(document.querySelector('.suggestion-popup')).toBeNull()

    // Second Escape: if editorRef survived the failed dispatch, this attempts
    // the dispatch again. If editorRef was wrongly nulled by the first call,
    // `dispatchExitMeta()` early-returns and dispatch is never retried.
    const secondHandled = renderer.onKeyDown({
      event: new KeyboardEvent('keydown', { key: 'Escape' }),
      view: {} as never,
      range: { from: 0, to: 0 },
    })
    expect(secondHandled).toBe(true)
    expect(dispatch).toHaveBeenCalledTimes(2)
  })

  it('skips view.dispatch when editor view is destroyed but still cleans up popup', () => {
    const pluginKey = new PluginKey('test-suggestion')
    const dispatch = vi.fn()
    const mockEditor = {
      state: { tr: { setMeta: vi.fn().mockReturnThis() } },
      view: { isDestroyed: true, dispatch },
    } as any

    const renderer = createSuggestionRenderer('Tags', pluginKey)
    const props = makeProps()
    props.editor = mockEditor
    renderer.onStart(props)

    expect(document.querySelector('.suggestion-popup')).toBeInTheDocument()

    removeSpy.mockClear()

    // Outside click while the captured editor's view is destroyed
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))

    // Dispatch must be skipped because the view is destroyed
    expect(dispatch).not.toHaveBeenCalled()

    // Cleanup must still happen: popup gone, listener removed
    expect(document.querySelector('.suggestion-popup')).toBeNull()
    expect(removeSpy).toHaveBeenCalledWith('pointerdown', expect.any(Function), true)

    // Confirm renderer was destroyed too
    const lastInstance: any = mockReactRenderer.mock.instances.at(-1)
    expect(lastInstance.destroy).toHaveBeenCalled()
  })
})

describe('outside-click deferred registration', () => {
  function makeProps(): any {
    return {
      items: [],
      command: vi.fn(),
      clientRect: () =>
        ({ left: 100, right: 120, top: 80, bottom: 100, width: 20, height: 20 }) as DOMRect,
      editor: {} as any,
      query: '',
      range: { from: 0, to: 1 },
      text: '/',
      decorationNode: null,
    }
  }

  let rafCallbacks: Array<FrameRequestCallback>
  let rafIdCounter: number
  let originalRaf: typeof requestAnimationFrame

  beforeEach(() => {
    rafCallbacks = []
    rafIdCounter = 1
    // Save the current (globally-mocked) rAF so we can restore it
    originalRaf = window.requestAnimationFrame
    // Override rAF to capture callbacks without executing them
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      rafCallbacks.push(cb)
      return rafIdCounter++
    })
    vi.stubGlobal(
      'cancelAnimationFrame',
      vi.fn((id: number) => {
        // Neutralize the callback at index (id - 1)
        const idx = id - 1
        if (idx >= 0 && idx < rafCallbacks.length) {
          rafCallbacks[idx] = () => {}
        }
      }),
    )
  })

  afterEach(() => {
    // Restore the synchronous rAF mock for other test suites
    vi.stubGlobal('requestAnimationFrame', originalRaf)
    for (const el of document.querySelectorAll('.suggestion-popup')) {
      el.remove()
    }
  })

  /** Flush all pending rAF callbacks. */
  function flushRaf() {
    let safety = 10
    while (rafCallbacks.length > 0 && safety-- > 0) {
      const batch = [...rafCallbacks]
      rafCallbacks = []
      for (const cb of batch) cb(0)
    }
  }

  it('pointerdown during first frame does NOT dismiss popup', () => {
    const renderer = createSuggestionRenderer()
    renderer.onStart(makeProps())

    // Popup exists but rAF hasn't fired yet — listener not registered
    expect(document.querySelector('.suggestion-popup')).toBeInTheDocument()

    // Simulate an outside pointerdown before the frame fires
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))

    // Popup should still be there — the listener wasn't active yet
    expect(document.querySelector('.suggestion-popup')).toBeInTheDocument()

    // Cleanup
    flushRaf()
    renderer.onExit()
  })

  it('pointerdown AFTER first frame DOES dismiss popup', () => {
    const renderer = createSuggestionRenderer()
    renderer.onStart(makeProps())

    // Flush rAF to register the listener
    flushRaf()

    expect(document.querySelector('.suggestion-popup')).toBeInTheDocument()

    // Now an outside click should dismiss
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    expect(document.querySelector('.suggestion-popup')).toBeNull()
  })

  it('onExit before rAF fires does not leak listeners', () => {
    const addSpy = vi.spyOn(document, 'addEventListener')
    const renderer = createSuggestionRenderer()
    renderer.onStart(makeProps())

    // Exit immediately — before rAF fires
    renderer.onExit()

    // The rAF callback should have been cancelled; flush to confirm it doesn't register
    addSpy.mockClear()
    flushRaf()

    // No pointerdown listener should have been registered after onExit
    const pointerdownCalls = addSpy.mock.calls.filter(([event]) => event === 'pointerdown')
    expect(pointerdownCalls).toHaveLength(0)

    addSpy.mockRestore()
  })

  it('rapid onStart → onExit → onStart cycle does not break', () => {
    const renderer = createSuggestionRenderer()

    // Cycle 1: start then immediately exit (before rAF)
    renderer.onStart(makeProps())
    renderer.onExit()
    expect(document.querySelector('.suggestion-popup')).toBeNull()

    // Cycle 2: start again
    renderer.onStart(makeProps())
    flushRaf()
    expect(document.querySelector('.suggestion-popup')).toBeInTheDocument()

    // Outside click should still work after the rapid cycle
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    expect(document.querySelector('.suggestion-popup')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// #1102 — WCAG editable-combobox wiring on the FOCUSED contenteditable.
// ---------------------------------------------------------------------------
describe('editable-combobox ARIA wiring (#1102)', () => {
  /**
   * Build a mock editor whose `view.dom` is a REAL contenteditable carrying the
   * resting `role="textbox"` (mirrors `use-roving-editor.ts` EDITOR_PROPS), so
   * we can assert the renderer flips it to a combobox and back without any
   * `instanceof` on ProseMirror types (it manipulates DOM attrs directly).
   */
  function makeComboboxEditor() {
    const dom = document.createElement('div')
    dom.setAttribute('role', 'textbox')
    dom.setAttribute('aria-multiline', 'true')
    dom.setAttribute('aria-label', 'Block editor')
    document.body.append(dom)
    const editor = { view: { dom, isDestroyed: false } } as any
    return { editor, dom }
  }

  function makeProps(editor: any, query = ''): any {
    return {
      items: [],
      command: vi.fn(),
      clientRect: () =>
        ({ left: 100, right: 120, top: 80, bottom: 100, width: 20, height: 20 }) as DOMRect,
      editor,
      query,
      range: { from: 0, to: 1 },
      text: '@',
      decorationNode: null,
    }
  }

  /** The `onActiveDescendantChange` callback handed to the most recent SuggestionList. */
  function lastActiveDescendantCb(): (id: string | null) => void {
    const calls = mockReactRenderer.mock.calls
    const last = calls.at(-1)
    if (!last) throw new Error('ReactRenderer was never constructed')
    return (last[1] as any).props.onActiveDescendantChange
  }

  afterEach(() => {
    for (const el of document.querySelectorAll('.suggestion-popup')) el.remove()
    document.body.querySelectorAll('[role="textbox"],[role="combobox"]').forEach((el) => {
      el.remove()
    })
  })

  it('onStart promotes the contenteditable to a combobox with controls + autocomplete', () => {
    const { editor, dom } = makeComboboxEditor()
    const renderer = createSuggestionRenderer('Tags')

    renderer.onStart(makeProps(editor))

    expect(dom.getAttribute('role')).toBe('combobox')
    expect(dom.getAttribute('aria-expanded')).toBe('true')
    expect(dom.getAttribute('aria-controls')).toBe('suggestion-listbox')
    expect(dom.getAttribute('aria-autocomplete')).toBe('list')
    // A textbox's attribute: axe's `aria-allowed-attr` refuses it on a combobox.
    expect(dom.hasAttribute('aria-multiline')).toBe(false)

    renderer.onExit()
  })

  it('passes a stable listboxId to the SuggestionList so aria-controls has a target', () => {
    const { editor } = makeComboboxEditor()
    const renderer = createSuggestionRenderer('Tags')

    renderer.onStart(makeProps(editor))

    const calls = mockReactRenderer.mock.calls
    const last = calls.at(-1)
    if (!last) throw new Error('ReactRenderer was never constructed')
    expect((last[1] as any).props.listboxId).toBe('suggestion-listbox')

    renderer.onExit()
  })

  it('onExit restores role=textbox and strips every combobox attribute', () => {
    const { editor, dom } = makeComboboxEditor()
    const renderer = createSuggestionRenderer('Tags')

    renderer.onStart(makeProps(editor))
    // Simulate a highlighted option mid-session.
    lastActiveDescendantCb()('suggestion-2')
    expect(dom.getAttribute('aria-activedescendant')).toBe('suggestion-2')

    renderer.onExit()

    expect(dom.getAttribute('role')).toBe('textbox')
    expect(dom.getAttribute('aria-multiline')).toBe('true')
    expect(dom.hasAttribute('aria-expanded')).toBe(false)
    expect(dom.hasAttribute('aria-controls')).toBe(false)
    expect(dom.hasAttribute('aria-autocomplete')).toBe(false)
    expect(dom.hasAttribute('aria-activedescendant')).toBe(false)
  })

  it('Escape close restores role=textbox on the contenteditable', () => {
    const { editor, dom } = makeComboboxEditor()
    const renderer = createSuggestionRenderer('Tags')

    renderer.onStart(makeProps(editor))
    expect(dom.getAttribute('role')).toBe('combobox')

    renderer.onKeyDown({
      event: new KeyboardEvent('keydown', { key: 'Escape' }),
      view: {} as never,
      range: { from: 0, to: 0 },
    })

    expect(dom.getAttribute('role')).toBe('textbox')
    expect(dom.hasAttribute('aria-expanded')).toBe(false)
  })

  it('outside click restores role=textbox on the contenteditable', () => {
    const { editor, dom } = makeComboboxEditor()
    const renderer = createSuggestionRenderer('Tags')

    renderer.onStart(makeProps(editor))
    expect(dom.getAttribute('role')).toBe('combobox')

    // rAF is synchronous in this suite, so the outside-click listener is live.
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))

    expect(dom.getAttribute('role')).toBe('textbox')
    expect(dom.hasAttribute('aria-expanded')).toBe(false)
  })

  it('synchronous onExit re-entry during Escape teardown is idempotent and can reopen', () => {
    const pluginKey = new PluginKey('reentrant-suggestion')
    const { editor, dom } = makeComboboxEditor()
    const setMeta = vi.fn().mockReturnThis()
    const dispatch = vi.fn(() => renderer.onExit())
    editor.state = { tr: { setMeta } }
    editor.view.dispatch = dispatch
    const renderer = createSuggestionRenderer('Tags', pluginKey)
    const removeListenerSpy = vi.spyOn(document, 'removeEventListener')

    renderer.onStart(makeProps(editor))
    const firstInstance: any = mockReactRenderer.mock.instances.at(-1)
    expect(dom.getAttribute('role')).toBe('combobox')
    removeListenerSpy.mockClear()

    const handled = renderer.onKeyDown({
      event: new KeyboardEvent('keydown', { key: 'Escape' }),
      view: {} as never,
      range: { from: 0, to: 0 },
    })

    expect(handled).toBe(true)
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(firstInstance.destroy).toHaveBeenCalledTimes(1)
    expect(removeListenerSpy).toHaveBeenCalledTimes(1)
    expect(removeListenerSpy).toHaveBeenCalledWith('pointerdown', expect.any(Function), true)
    expect(document.querySelector('.suggestion-popup')).toBeNull()
    expect(dom.getAttribute('role')).toBe('textbox')
    expect(dom.hasAttribute('aria-expanded')).toBe(false)

    // A late duplicate lifecycle exit is a no-op after the re-entrant close.
    renderer.onExit()
    expect(firstInstance.destroy).toHaveBeenCalledTimes(1)
    expect(removeListenerSpy).toHaveBeenCalledTimes(1)

    // The nested onExit cleared every captured reference, so the same lifecycle
    // object can start a fresh popup without retaining the first renderer.
    renderer.onStart(makeProps(editor, 'again'))
    const secondInstance: any = mockReactRenderer.mock.instances.at(-1)
    expect(secondInstance).not.toBe(firstInstance)
    expect(document.querySelector('.suggestion-popup')).toBeInTheDocument()
    expect(dom.getAttribute('role')).toBe('combobox')

    renderer.onExit()
    expect(secondInstance.destroy).toHaveBeenCalledTimes(1)
    expect(dom.getAttribute('role')).toBe('textbox')
    removeListenerSpy.mockRestore()
  })

  it('aria-activedescendant on the contenteditable tracks the highlighted option id', () => {
    const { editor, dom } = makeComboboxEditor()
    const renderer = createSuggestionRenderer('Tags')

    renderer.onStart(makeProps(editor))
    const report = lastActiveDescendantCb()

    // No active option yet → attribute absent (never points at a stale id).
    expect(dom.hasAttribute('aria-activedescendant')).toBe(false)

    report('suggestion-1')
    expect(dom.getAttribute('aria-activedescendant')).toBe('suggestion-1')

    // Arrow navigation moves the highlight → the contenteditable follows.
    report('suggestion-3')
    expect(dom.getAttribute('aria-activedescendant')).toBe('suggestion-3')

    // List emptied (query with no matches) → attribute removed.
    report(null)
    expect(dom.hasAttribute('aria-activedescendant')).toBe(false)

    renderer.onExit()
  })

  it('does not throw when the editor view is unavailable (no contenteditable)', () => {
    const renderer = createSuggestionRenderer('Tags')
    expect(() => renderer.onStart(makeProps({} as any))).not.toThrow()
    renderer.onExit()
  })
})
