import { describe, expect, it, vi } from 'vitest'
import { dispatchPriorityEvent, replaceDocSilently } from '../use-roving-editor'

// -- dispatchPriorityEvent ----------------------------------------------------

describe('dispatchPriorityEvent', () => {
  it('dispatches set-priority-1 on document for level 1', () => {
    const spy = vi.fn()
    document.addEventListener('set-priority-1', spy)
    dispatchPriorityEvent(1)
    expect(spy).toHaveBeenCalledOnce()
    document.removeEventListener('set-priority-1', spy)
  })

  it('dispatches set-priority-2 on document for level 2', () => {
    const spy = vi.fn()
    document.addEventListener('set-priority-2', spy)
    dispatchPriorityEvent(2)
    expect(spy).toHaveBeenCalledOnce()
    document.removeEventListener('set-priority-2', spy)
  })

  it('dispatches set-priority-3 on document for level 3', () => {
    const spy = vi.fn()
    document.addEventListener('set-priority-3', spy)
    dispatchPriorityEvent(3)
    expect(spy).toHaveBeenCalledOnce()
    document.removeEventListener('set-priority-3', spy)
  })

  it('dispatches a CustomEvent instance', () => {
    let receivedEvent: Event | null = null
    const handler = (e: Event) => {
      receivedEvent = e
    }
    document.addEventListener('set-priority-1', handler)
    dispatchPriorityEvent(1)
    expect(receivedEvent).toBeInstanceOf(CustomEvent)
    document.removeEventListener('set-priority-1', handler)
  })
})

// -- replaceDocSilently -------------------------------------------------------

describe('replaceDocSilently', () => {
  function makeMockEditor() {
    const mockContent = { size: 42, mock: true }
    const mockPmDoc = { content: mockContent }
    const tr = {
      replaceWith: vi.fn().mockReturnThis(),
      setMeta: vi.fn().mockReturnThis(),
    }
    const editor = {
      schema: { nodeFromJSON: vi.fn().mockReturnValue(mockPmDoc) },
      state: {
        doc: { content: { size: 100 } },
        get tr() {
          return tr
        },
      },
      view: { dispatch: vi.fn() },
    }
    return { editor, tr, mockContent }
  }

  it('calls schema.nodeFromJSON with the JSON argument', () => {
    const { editor } = makeMockEditor()
    const json = { type: 'doc', content: [{ type: 'paragraph' }] }

    replaceDocSilently(editor as never, json)

    expect(editor.schema.nodeFromJSON).toHaveBeenCalledOnce()
    expect(editor.schema.nodeFromJSON).toHaveBeenCalledWith(json)
  })

  it('replaces entire document content (position 0 to docSize)', () => {
    const { editor, tr, mockContent } = makeMockEditor()

    replaceDocSilently(editor as never, { type: 'doc' })

    expect(tr.replaceWith).toHaveBeenCalledOnce()
    expect(tr.replaceWith).toHaveBeenCalledWith(0, 100, mockContent)
  })

  it('sets addToHistory:false meta to avoid polluting undo stack', () => {
    const { editor, tr } = makeMockEditor()

    replaceDocSilently(editor as never, { type: 'doc' })

    expect(tr.setMeta).toHaveBeenCalledOnce()
    expect(tr.setMeta).toHaveBeenCalledWith('addToHistory', false)
  })

  it('dispatches the transaction via editor.view.dispatch', () => {
    const { editor, tr } = makeMockEditor()

    replaceDocSilently(editor as never, { type: 'doc' })

    expect(editor.view.dispatch).toHaveBeenCalledOnce()
    expect(editor.view.dispatch).toHaveBeenCalledWith(tr)
  })

  it('chains correctly: replaceWith -> setMeta -> dispatch', () => {
    const { editor, tr } = makeMockEditor()
    const callOrder: string[] = []
    tr.replaceWith = vi.fn(() => {
      callOrder.push('replaceWith')
      return tr
    })
    tr.setMeta = vi.fn(() => {
      callOrder.push('setMeta')
      return tr
    })
    editor.view.dispatch = vi.fn(() => {
      callOrder.push('dispatch')
    })

    replaceDocSilently(editor as never, { type: 'doc' })

    expect(callOrder).toEqual(['replaceWith', 'setMeta', 'dispatch'])
  })
})
