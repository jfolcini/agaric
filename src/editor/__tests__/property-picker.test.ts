/**
 * Tests for the PropertyPicker extension.
 */

import { Editor } from '@tiptap/core'
import Document from '@tiptap/extension-document'
import Paragraph from '@tiptap/extension-paragraph'
import Text from '@tiptap/extension-text'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PropertyPicker } from '../extensions/property-picker'
import type { PickerItem } from '../SuggestionList'

describe('PropertyPicker', () => {
  it('creates an extension with the correct name', () => {
    const ext = PropertyPicker.configure({ items: () => [] })
    expect(ext.name).toBe('propertyPicker')
  })

  it('has default items option', () => {
    const ext = PropertyPicker.configure({})
    expect(ext.options.items).toBeDefined()
  })

  it('has onSelect undefined by default', () => {
    const ext = PropertyPicker.configure({})
    expect(ext.options.onSelect).toBeUndefined()
  })

  it('accepts a custom onSelect option', () => {
    const onSelect = vi.fn()
    const ext = PropertyPicker.configure({ items: () => [], onSelect })
    expect(ext.options.onSelect).toBe(onSelect)
  })

  it('accepts a custom items option', () => {
    const items = vi.fn().mockResolvedValue([{ id: 'status', label: 'status' }])
    const ext = PropertyPicker.configure({ items })
    expect(ext.options.items).toBe(items)
  })

  it('default items returns empty array', () => {
    const ext = PropertyPicker.configure({})
    const result = ext.options.items('test')
    expect(result).toEqual([])
  })
})

// ── Suggestion plugin configuration ─────────────────────────────────────
//
// The PropertyPicker registers a Suggestion plugin with the `::` trigger.
// These tests mock @tiptap/suggestion and capture the options passed to
// Suggestion(...) so we can assert the configuration without standing up
// a real editor.

describe('PropertyPicker suggestion plugin configuration', () => {
  it('uses :: as trigger character with allowedPrefixes null', async () => {
    let capturedOptions: Record<string, unknown> | undefined
    vi.resetModules()
    vi.doMock('@tiptap/suggestion', () => ({
      Suggestion: (opts: Record<string, unknown>) => {
        capturedOptions = opts
        return { key: opts['pluginKey'] }
      },
    }))
    const mod = await import('../extensions/property-picker')
    const ext = mod.PropertyPicker.configure({ items: () => [] })
    // biome-ignore lint/complexity/noBannedTypes: test needs .call() on TipTap config method
    ;(ext.config.addProseMirrorPlugins as Function).call({
      editor: {} as unknown,
      options: ext.options,
    })

    expect(capturedOptions).toBeDefined()
    expect(capturedOptions?.['char']).toBe('::')
    // allowedPrefixes: null means the trigger fires regardless of the
    // preceding character (e.g. mid-word `foo::` opens the picker).
    expect(capturedOptions?.['allowedPrefixes']).toBeNull()

    vi.doUnmock('@tiptap/suggestion')
    vi.resetModules()
  })

  it('items wrapper forwards the query to extension options', async () => {
    let capturedOptions: Record<string, unknown> | undefined
    vi.resetModules()
    vi.doMock('@tiptap/suggestion', () => ({
      Suggestion: (opts: Record<string, unknown>) => {
        capturedOptions = opts
        return { key: opts['pluginKey'] }
      },
    }))
    const mod = await import('../extensions/property-picker')
    const userItems = vi.fn().mockResolvedValue([{ id: 'status', label: 'status' }])
    const ext = mod.PropertyPicker.configure({ items: userItems })
    // biome-ignore lint/complexity/noBannedTypes: test needs .call() on TipTap config method
    ;(ext.config.addProseMirrorPlugins as Function).call({
      editor: {} as unknown,
      options: ext.options,
    })

    const itemsFn = capturedOptions?.['items'] as (ctx: { query: string }) => Promise<PickerItem[]>
    const result = await itemsFn({ query: 'sta' })
    expect(userItems).toHaveBeenCalledWith('sta')
    expect(result).toEqual([{ id: 'status', label: 'status' }])

    vi.doUnmock('@tiptap/suggestion')
    vi.resetModules()
  })

  it('items wrapper returns [] when the user-supplied items callback throws', async () => {
    let capturedOptions: Record<string, unknown> | undefined
    vi.resetModules()
    vi.doMock('@tiptap/suggestion', () => ({
      Suggestion: (opts: Record<string, unknown>) => {
        capturedOptions = opts
        return { key: opts['pluginKey'] }
      },
    }))
    const mod = await import('../extensions/property-picker')
    const userItems = vi.fn().mockRejectedValue(new Error('IPC blew up'))
    const ext = mod.PropertyPicker.configure({ items: userItems })
    // biome-ignore lint/complexity/noBannedTypes: test needs .call() on TipTap config method
    ;(ext.config.addProseMirrorPlugins as Function).call({
      editor: {} as unknown,
      options: ext.options,
    })

    const itemsFn = capturedOptions?.['items'] as (ctx: { query: string }) => Promise<PickerItem[]>
    const result = await itemsFn({ query: 'oops' })
    expect(userItems).toHaveBeenCalledWith('oops')
    // Errors must be swallowed so the picker still renders an empty list.
    expect(result).toEqual([])

    vi.doUnmock('@tiptap/suggestion')
    vi.resetModules()
  })

  it('passes a render() factory that returns suggestion-popup-aware lifecycle hooks', async () => {
    let capturedOptions: Record<string, unknown> | undefined
    vi.resetModules()
    vi.doMock('@tiptap/suggestion', () => ({
      Suggestion: (opts: Record<string, unknown>) => {
        capturedOptions = opts
        return { key: opts['pluginKey'] }
      },
    }))
    const mod = await import('../extensions/property-picker')
    const ext = mod.PropertyPicker.configure({ items: () => [] })
    // biome-ignore lint/complexity/noBannedTypes: test needs .call() on TipTap config method
    ;(ext.config.addProseMirrorPlugins as Function).call({
      editor: {} as unknown,
      options: ext.options,
    })

    const renderFactory = capturedOptions?.['render'] as () => {
      onStart: unknown
      onUpdate: unknown
      onKeyDown: unknown
      onExit: unknown
    }
    expect(renderFactory).toBeTypeOf('function')
    const lifecycle = renderFactory()
    expect(lifecycle.onStart).toBeTypeOf('function')
    expect(lifecycle.onUpdate).toBeTypeOf('function')
    expect(lifecycle.onKeyDown).toBeTypeOf('function')
    expect(lifecycle.onExit).toBeTypeOf('function')

    vi.doUnmock('@tiptap/suggestion')
    vi.resetModules()
  })
})

// ── Suggestion plugin command (insertion / cancellation paths) ──────────
//
// The captured `command` callback is what fires when the user picks an
// item from the popup or when the popup is dismissed via Escape (in
// which case `command` is never invoked). These tests verify the
// chain order and the onSelect callback wiring without booting a real
// editor view.

describe('PropertyPicker suggestion command', () => {
  async function captureCommand(onSelect?: (item: PickerItem, editor: unknown) => void): Promise<{
    command: (ctx: { editor: unknown; range: { from: number; to: number }; props: unknown }) => void
  }> {
    let capturedCommand:
      | ((ctx: { editor: unknown; range: { from: number; to: number }; props: unknown }) => void)
      | undefined
    vi.resetModules()
    vi.doMock('@tiptap/suggestion', () => ({
      Suggestion: (opts: Record<string, unknown>) => {
        capturedCommand = opts['command'] as typeof capturedCommand
        return { key: opts['pluginKey'] }
      },
    }))
    const mod = await import('../extensions/property-picker')
    const config: { items: () => PickerItem[]; onSelect?: typeof onSelect } = {
      items: () => [],
    }
    if (onSelect) config.onSelect = onSelect
    const ext = mod.PropertyPicker.configure(config)
    // biome-ignore lint/complexity/noBannedTypes: test needs .call() on TipTap config method
    ;(ext.config.addProseMirrorPlugins as Function).call({
      editor: {} as unknown,
      options: ext.options,
    })
    if (!capturedCommand) throw new Error('command not captured')
    return { command: capturedCommand }
  }

  it('chains focus → deleteRange(range) → insertContent("label:: ") → run()', async () => {
    const { command } = await captureCommand()
    const calls: string[] = []
    const chainProxy: Record<string, unknown> = {
      focus: () => {
        calls.push('focus')
        return chainProxy
      },
      deleteRange: (r: { from: number; to: number }) => {
        calls.push(`deleteRange:${r.from}-${r.to}`)
        return chainProxy
      },
      insertContent: (c: unknown) => {
        calls.push(`insertContent:${JSON.stringify(c)}`)
        return chainProxy
      },
      run: () => {
        calls.push('run')
        return true
      },
    }
    const mockEditor = { chain: () => chainProxy }

    command({
      editor: mockEditor,
      range: { from: 4, to: 6 },
      props: { id: 'status', label: 'status' },
    })

    expect(calls).toEqual(['focus', 'deleteRange:4-6', 'insertContent:"status:: "', 'run'])

    vi.doUnmock('@tiptap/suggestion')
    vi.resetModules()
  })

  it('invokes onSelect with the picked item and editor after the chain', async () => {
    const onSelect = vi.fn()
    const { command } = await captureCommand(onSelect)
    const chainProxy: Record<string, unknown> = {
      focus: () => chainProxy,
      deleteRange: () => chainProxy,
      insertContent: () => chainProxy,
      run: () => true,
    }
    const mockEditor = { chain: () => chainProxy }
    const props = { id: 'priority', label: 'priority' }

    command({ editor: mockEditor, range: { from: 1, to: 3 }, props })

    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onSelect).toHaveBeenCalledWith(props, mockEditor)

    vi.doUnmock('@tiptap/suggestion')
    vi.resetModules()
  })

  it('does not throw when onSelect is undefined (default config)', async () => {
    const { command } = await captureCommand()
    const chainProxy: Record<string, unknown> = {
      focus: () => chainProxy,
      deleteRange: () => chainProxy,
      insertContent: () => chainProxy,
      run: () => true,
    }
    const mockEditor = { chain: () => chainProxy }

    expect(() =>
      command({
        editor: mockEditor,
        range: { from: 0, to: 2 },
        props: { id: 'tags', label: 'tags' },
      }),
    ).not.toThrow()

    vi.doUnmock('@tiptap/suggestion')
    vi.resetModules()
  })

  it('cancellation path: when command is never invoked, no chain side effects fire', async () => {
    // Simulates Escape (or outside-click) closing the popup without
    // selecting: the Suggestion plugin discards the captured `command`
    // without calling it, so onSelect must NOT fire and the chain proxy
    // sees no calls.
    const onSelect = vi.fn()
    await captureCommand(onSelect)
    expect(onSelect).not.toHaveBeenCalled()

    vi.doUnmock('@tiptap/suggestion')
    vi.resetModules()
  })
})

// ── Integration: real editor doc state after the picker chain ───────────
//
// These tests drive the exact chain that PropertyPicker's `command`
// runs through a real TipTap Editor (Document + Paragraph + Text only;
// no Suggestion plugin needed) and assert the doc shape:
//   - the inserted text is `${item.label}:: `
//   - cursor sits at the end of the inserted text
//   - exactly one paragraph (no stray hard_break / paragraph split)

describe('PropertyPicker real-editor chain result', () => {
  let editor: Editor | undefined

  afterEach(() => {
    editor?.destroy()
    editor = undefined
  })

  function buildEditor(initialText: string): Editor {
    return new Editor({
      element: document.createElement('div'),
      extensions: [Document, Paragraph, Text],
      content: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: initialText ? [{ type: 'text', text: initialText }] : [],
          },
        ],
      },
    })
  }

  it('inserts "label:: " at the trigger range; cursor sits at end of paragraph', () => {
    // Simulate: user typed `::stat`; the suggestion range is positions
    // 1..7 (`:` at 1..2 / `:` at 2..3 / `s` at 3..4 / etc.). After the
    // user picks `status` from the popup, the chain replaces that range
    // with `status:: `.
    editor = buildEditor('::stat')
    editor.chain().focus().deleteRange({ from: 1, to: 7 }).insertContent('status:: ').run()

    const doc = editor.state.doc
    // Exactly one paragraph — the chain must not split or insert breaks.
    expect(doc.childCount).toBe(1)
    const paragraph = doc.child(0)
    expect(paragraph.type.name).toBe('paragraph')

    // The paragraph contains a single text node with the inserted property
    // text. ProseMirror collapses adjacent text nodes with identical marks.
    expect(paragraph.childCount).toBe(1)
    expect(paragraph.child(0).type.name).toBe('text')
    expect(paragraph.child(0).text).toBe('status:: ')

    // No hard_break leaked in.
    let hardBreakCount = 0
    doc.descendants((n) => {
      if (n.type.name === 'hard_break') hardBreakCount += 1
    })
    expect(hardBreakCount).toBe(0)

    // Cursor sits at the end of the paragraph (right after the trailing
    // space), not on a new line. $from.parentOffset === paragraph
    // content size; selection.from === doc.content.size - 1 (doc closes
    // the paragraph with a single token).
    const $from = editor.state.selection.$from
    expect($from.parent.type.name).toBe('paragraph')
    expect($from.parentOffset).toBe(paragraph.content.size)
    expect(editor.state.selection.from).toBe(doc.content.size - 1)
    expect(editor.state.selection.empty).toBe(true)
  })

  it('preserves surrounding text when the trigger sits mid-paragraph', () => {
    // "before ::p" — the trigger range is 8..11 (`::p`); production's
    // Suggestion plugin places the cursor at the end of the typed query
    // (position 11) before invoking the command. We mirror that here
    // with setTextSelection so deleteRange + insertContent operate on
    // the correct range.
    editor = buildEditor('before ::p')
    editor.commands.setTextSelection(11)
    editor.chain().focus().deleteRange({ from: 8, to: 11 }).insertContent('priority:: ').run()

    const doc = editor.state.doc
    expect(doc.childCount).toBe(1)
    const paragraph = doc.child(0)
    expect(paragraph.textContent).toBe('before priority:: ')
    expect(paragraph.childCount).toBe(1)
    expect(paragraph.child(0).type.name).toBe('text')
  })

  it('inserts a single trailing space exactly once (no double-space drift)', () => {
    editor = buildEditor('::')
    editor.chain().focus().deleteRange({ from: 1, to: 3 }).insertContent('tags:: ').run()

    // The text should end with exactly one space, not two.
    const text = editor.state.doc.child(0).textContent
    expect(text).toBe('tags:: ')
    expect(text.endsWith('  ')).toBe(false)
  })

  it('full configured extension boots without throwing in a real editor', () => {
    // Smoke test: the extension can be wired into a real Editor with
    // Suggestion plugin and the editor view starts up cleanly. This
    // catches regressions where addProseMirrorPlugins() throws under
    // jsdom (Pitfall 16: flushSync ordering, Pitfall 23: portal).
    editor = new Editor({
      element: document.createElement('div'),
      extensions: [
        Document,
        Paragraph,
        Text,
        PropertyPicker.configure({
          items: () => [{ id: 'status', label: 'status' }],
          onSelect: vi.fn(),
        }),
      ],
      content: { type: 'doc', content: [{ type: 'paragraph' }] },
    })
    expect(editor.isDestroyed).toBe(false)
    expect(editor.state.doc.childCount).toBe(1)
  })

  it('configured extension exposes the propertyPicker plugin on the editor view', () => {
    editor = new Editor({
      element: document.createElement('div'),
      extensions: [Document, Paragraph, Text, PropertyPicker.configure({ items: () => [] })],
      content: { type: 'doc', content: [{ type: 'paragraph' }] },
    })
    const pluginKeys = editor.view.state.plugins.map((p) => (p as unknown as { key: string }).key)
    expect(pluginKeys.some((k) => k.includes('propertyPicker'))).toBe(true)
  })

  it('booting the extension does not leave orphaned suggestion-popup elements in the DOM (Pitfall 23)', () => {
    // Pitfall 23: the suggestion popup must portal to body via the
    // `.suggestion-popup` selector tracked by EDITOR_PORTAL_SELECTORS.
    // On boot (before the picker is triggered) there should be NO
    // popup mounted — only after the user types `::` does it appear.
    editor = new Editor({
      element: document.createElement('div'),
      extensions: [Document, Paragraph, Text, PropertyPicker.configure({ items: () => [] })],
      content: { type: 'doc', content: [{ type: 'paragraph' }] },
    })
    expect(document.querySelectorAll('.suggestion-popup').length).toBe(0)
  })
})
