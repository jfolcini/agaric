import { describe, expect, it, vi } from 'vitest'

import type { PickerItem } from '@/editor/SuggestionList'

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
// trigger char, the activation gate, and the command delegation. The plugin
// itself is unit-tested separately in picker-plugin.test.ts.
vi.mock('@/editor/extensions/picker-plugin', () => ({
  createPickerPlugin: (config: Record<string, unknown>) => {
    capturedPickerConfig = config
    return {}
  },
}))

// --- Import after mocks ---
import { QueryPicker } from '@/editor/extensions/query-picker'

interface AllowArgs {
  state: { doc: { textBetween: (from: number, to: number) => string } }
  range: { from: number; to: number }
}

function setup(options?: {
  onCommand?: ReturnType<typeof vi.fn>
  embedItems?: ReturnType<typeof vi.fn>
}) {
  const onCommand = options?.onCommand ?? vi.fn()
  const embedItems = options?.embedItems ?? vi.fn(() => [])
  const ctx = {
    editor: { view: { isDestroyed: false } },
    options: { onCommand, embedItems },
  }
  ;(QueryPicker as any).addProseMirrorPlugins.call(ctx)
  const items = capturedPickerConfig['items'] as (
    query: string,
  ) => PickerItem[] | Promise<PickerItem[]>
  const command = capturedPickerConfig['command'] as (args: {
    editor: unknown
    range: unknown
    props?: unknown
  }) => void
  const allow = capturedPickerConfig['allow'] as (args: AllowArgs) => boolean
  return { items, command, allow, onCommand, embedItems }
}

/** An `allow` invocation over trigger text the user has typed. */
function allowFor(allow: (args: AllowArgs) => boolean, text: string): boolean {
  return allow({
    state: { doc: { textBetween: () => text } },
    range: { from: 0, to: text.length },
  })
}

/** A `.chain().focus()` recorder covering the three terminals the picker uses. */
function makeEditorRecorder() {
  const calls: Array<[string, unknown]> = []
  const api: Record<string, unknown> = {}
  const record = (name: string) => (arg?: unknown) => {
    calls.push([name, arg])
    return api
  }
  api['deleteRange'] = record('deleteRange')
  api['insertContent'] = record('insertContent')
  api['insertBlockRef'] = record('insertBlockRef')
  api['run'] = record('run')
  return { calls, editor: { chain: () => ({ focus: () => api }) } }
}

describe('query-picker — `{{` brace affordance', () => {
  it('triggers on `{{` and is not gated to whitespace prefixes', () => {
    setup()
    expect(capturedPickerConfig['char']).toBe('{{')
    expect(capturedPickerConfig['allowedPrefixes']).toBeNull()
    // #4550 — spaces must survive the match because `{{embed ` has one and an
    // embed search is free text. The `allow` gate below is what closes the
    // popup for manual `{{query …}}`, not the space.
    expect(capturedPickerConfig['allowSpaces']).toBe(true)
  })

  it('activates for the bare `{{` and for an `{{embed …}}` trigger only', () => {
    const { allow } = setup()
    expect(allowFor(allow, '{{')).toBe(true)
    expect(allowFor(allow, '{{embed')).toBe(true)
    expect(allowFor(allow, '{{embed ')).toBe(true)
    expect(allowFor(allow, '{{embed sprint plan')).toBe(true)
    // Manual query syntax must DEACTIVATE the plugin so QueryHint takes over;
    // emptying the item list alone would leave a floating 'No results' popup.
    expect(allowFor(allow, '{{q')).toBe(false)
    expect(allowFor(allow, '{{query tag:foo')).toBe(false)
    expect(allowFor(allow, '{{ ')).toBe(false)
  })

  it('offers the query and embed affordances only while the query is empty', async () => {
    const { items } = setup()
    expect(await items('')).toEqual([
      { id: 'query', label: 'Insert query…' },
      { id: 'embed', label: 'Insert embed…' },
    ])
    // Once the user types anything that is not the embed prefix, yield to
    // manual `{{query …}}` + QueryHint.
    expect(await items('q')).toEqual([])
    expect(await items('query tag:foo')).toEqual([])
  })

  it('routes an `{{embed …}}` query to the embed target search', async () => {
    const embedItems = vi.fn(() => [{ id: 'BLK1', label: 'Sprint plan' }])
    const { items } = setup({ embedItems })

    expect(await items('embed')).toEqual([{ id: 'BLK1', label: 'Sprint plan' }])
    expect(embedItems).toHaveBeenLastCalledWith('')
    await items('embed sprint')
    expect(embedItems).toHaveBeenLastCalledWith('sprint')
  })

  it('deletes the `{{` range and delegates to onCommand with the query item', () => {
    const onCommand = vi.fn()
    const { command } = setup({ onCommand })
    const { calls, editor } = makeEditorRecorder()

    command({ editor, range: { from: 0, to: 2 }, props: { id: 'query' } })

    expect(calls).toContainEqual(['deleteRange', { from: 0, to: 2 }])
    expect(onCommand).toHaveBeenCalledWith({ id: 'query', label: 'Insert query…' })
  })

  it('rewrites the trigger to `{{embed ` when the embed affordance is chosen', () => {
    const onCommand = vi.fn()
    const { command } = setup({ onCommand })
    const { calls, editor } = makeEditorRecorder()

    command({ editor, range: { from: 0, to: 2 }, props: { id: 'embed' } })

    expect(calls).toContainEqual(['deleteRange', { from: 0, to: 2 }])
    expect(calls).toContainEqual(['insertContent', '{{embed '])
    // Deliberately NOT routed through the slash dispatch: the picker re-opens
    // itself in embed mode.
    expect(onCommand).not.toHaveBeenCalled()
  })

  it('writes the token with a real block_ref NODE, never as literal text', () => {
    const { command } = setup()
    const { calls, editor } = makeEditorRecorder()

    command({ editor, range: { from: 0, to: 10 }, props: { id: 'BLK1', label: 'Sprint plan' } })

    // Literal `((ULID))` TEXT is deliberately escaped on serialize
    // (`markdown-roundtrip-fidelity` finding 11), and `{{embed \((ULID))}}`
    // matches neither `parseEmbedToken` nor the backend's `ULID_LINK_RE` —
    // an embed written as text would render as inert text AND contribute no
    // backlink, silently, on the first blur.
    expect(calls).toEqual([
      ['deleteRange', { from: 0, to: 10 }],
      ['insertContent', '{{embed '],
      ['insertBlockRef', 'BLK1'],
      ['insertContent', '}}'],
      ['run', undefined],
    ])
  })
})
