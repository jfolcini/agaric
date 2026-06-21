import { describe, expect, it, vi } from 'vitest'

import type { PickerItem } from '../SuggestionList'

// --- Mocks ---

let capturedPickerConfig: Record<string, unknown> = {}

vi.mock('@tiptap/pm/state', () => ({
  PluginKey: vi.fn(),
}))

vi.mock('@tiptap/core', () => ({
  Extension: {
    create: (spec: Record<string, unknown>) => spec,
  },
}))

// Capture the config handed to createPickerPlugin so we can assert the
// trigger char, the empty-query gate, and the command delegation. The plugin
// itself is unit-tested separately in picker-plugin.test.ts.
vi.mock('../extensions/picker-plugin', () => ({
  createPickerPlugin: (config: Record<string, unknown>) => {
    capturedPickerConfig = config
    return {}
  },
}))

// --- Import after mocks ---
import { QueryPicker } from '../extensions/query-picker'

function setup(options?: { onCommand?: ReturnType<typeof vi.fn> }) {
  const onCommand = options?.onCommand ?? vi.fn()
  const ctx = {
    editor: { view: { isDestroyed: false } },
    options: { onCommand },
  }
  ;(QueryPicker as any).addProseMirrorPlugins.call(ctx)
  const items = capturedPickerConfig['items'] as (query: string) => PickerItem[]
  const command = capturedPickerConfig['command'] as (args: {
    editor: unknown
    range: unknown
  }) => void
  return { items, command, onCommand }
}

describe('query-picker — `{{` embed-query affordance', () => {
  it('triggers on `{{` and is not gated to whitespace prefixes', () => {
    setup()
    expect(capturedPickerConfig['char']).toBe('{{')
    expect(capturedPickerConfig['allowedPrefixes']).toBeNull()
    expect(capturedPickerConfig['allowSpaces']).toBe(false)
  })

  it('offers a single `query` item only while the query is empty', () => {
    const { items } = setup()
    // Immediately after `{{` — surface the affordance.
    expect(items('')).toEqual([{ id: 'query', label: 'Insert query…' }])
    // Once the user types, yield to manual `{{query …}}` + QueryHint.
    expect(items('q')).toEqual([])
    expect(items('query tag:foo')).toEqual([])
  })

  it('deletes the `{{` range and delegates to onCommand with the query item', () => {
    const onCommand = vi.fn()
    const { command } = setup({ onCommand })
    const deleteRange = vi.fn(() => ({ run: vi.fn() }))
    const editor = {
      chain: () => ({ focus: () => ({ deleteRange }) }),
    }

    command({ editor, range: { from: 0, to: 2 } })

    expect(deleteRange).toHaveBeenCalledWith({ from: 0, to: 2 })
    expect(onCommand).toHaveBeenCalledWith({ id: 'query', label: 'Insert query…' })
  })
})
