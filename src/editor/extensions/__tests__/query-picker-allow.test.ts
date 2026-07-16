/**
 * Regression: the `{{` query picker must yield to manual `{{query …}}`
 * typing by GATING activation (an `allow` callback), not just by emptying
 * its item list — returning [] from `items` leaves the Suggestion plugin
 * active, so a generic floating 'No results' popup hovers over the user's
 * manual `{{query` typing until the first space or Escape. Mirrors the
 * emoji picker's allow-gate rule.
 */

import { describe, expect, it, vi } from 'vitest'

import type { PickerItem } from '@/editor/SuggestionList'

let capturedPickerConfig: Record<string, unknown> = {}

vi.mock('@tiptap/pm/state', () => ({
  PluginKey: vi.fn(),
}))

vi.mock('@tiptap/core', () => ({
  Extension: {
    create: (spec: Record<string, unknown>) => spec,
  },
}))

vi.mock('@/editor/extensions/picker-plugin', () => ({
  createPickerPlugin: (config: Record<string, unknown>) => {
    capturedPickerConfig = config
    return {}
  },
}))

// --- Import after mocks ---
import { QueryPicker } from '@/editor/extensions/query-picker'

type AllowFn = (props: { state: unknown; range: { from: number; to: number } }) => boolean

function setup() {
  const ctx = {
    editor: { view: { isDestroyed: false } },
    options: { onCommand: vi.fn() },
  }
  ;(
    QueryPicker as unknown as { addProseMirrorPlugins: (this: unknown) => unknown }
  ).addProseMirrorPlugins.call(ctx)
  return capturedPickerConfig
}

/** Minimal state stub: `allow` reads the matched text via doc.textBetween. */
function stateFor(text: string) {
  return { doc: { textBetween: vi.fn(() => text) } }
}

describe('query-picker — allow gate hands off to manual {{query typing', () => {
  it('registers an allow gate that only activates on the bare `{{`', () => {
    const cfg = setup()
    const allow = cfg['allow'] as AllowFn
    expect(allow).toBeTypeOf('function')

    // Immediately after `{{` — the affordance popup may open.
    expect(allow({ state: stateFor('{{'), range: { from: 0, to: 2 } })).toBe(true)
    // The instant the user types manual syntax, the plugin must deactivate
    // (popup closes) instead of rendering an empty 'No results' state.
    expect(allow({ state: stateFor('{{q'), range: { from: 0, to: 3 } })).toBe(false)
    expect(allow({ state: stateFor('{{query'), range: { from: 0, to: 7 } })).toBe(false)
  })

  it('keeps the empty-query items gate (affordance item only while query is empty)', () => {
    const cfg = setup()
    const items = cfg['items'] as (query: string) => PickerItem[]
    expect(items('')).toEqual([{ id: 'query', label: 'Insert query…' }])
    expect(items('query tag:foo')).toEqual([])
  })
})
