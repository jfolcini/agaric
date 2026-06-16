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

vi.mock('../suggestion-renderer', () => ({
  createSuggestionRenderer: () => ({
    onStart: vi.fn(),
    onUpdate: vi.fn(),
    onKeyDown: vi.fn(() => false),
    onExit: vi.fn(),
  }),
}))

// The picker plugin is exercised here only to capture the `command` config
// it is handed, so we can assert that an explicit selection delegates to
// onCommand. The plugin itself is unit-tested separately.
vi.mock('../extensions/picker-plugin', () => ({
  createPickerPlugin: (config: Record<string, unknown>) => {
    capturedPickerConfig = config
    return {}
  },
}))

// --- Import after mocks ---
import { SlashCommand } from '../extensions/slash-command'

interface Lifecycle {
  onStart: (props: Record<string, unknown>) => void
  onUpdate: (props: Record<string, unknown>) => void
  onKeyDown: (props: Record<string, unknown>) => boolean
  onExit: () => void
}

/**
 * Trigger addProseMirrorPlugins with a mock context and return both the
 * render lifecycle object and the picker `command` callback / onCommand spy.
 */
function setup(options?: { onCommand?: ReturnType<typeof vi.fn> }) {
  const onCommand = options?.onCommand ?? vi.fn()
  const ctx = {
    editor: { view: { isDestroyed: false } },
    options: { items: () => [], onCommand },
  }
  // oxlint-disable-next-line typescript/no-explicit-any -- test helper — call with mock context
  ;(SlashCommand as any).addProseMirrorPlugins.call(ctx)
  const render = capturedPickerConfig['render'] as () => Lifecycle
  const command = capturedPickerConfig['command'] as (args: {
    editor: unknown
    range: unknown
    props: PickerItem
  }) => void
  return { lifecycle: render(), command, onCommand }
}

describe('slash-command — explicit selection only (no auto-execute)', () => {
  it('exposes no AUTO_EXEC_DELAY_MS constant', async () => {
    const mod = (await import('../extensions/slash-command')) as Record<string, unknown>
    expect(mod['AUTO_EXEC_DELAY_MS']).toBeUndefined()
  })

  it('does NOT run a command on update, even for a single ≥4-char match', () => {
    vi.useFakeTimers()
    try {
      const { lifecycle, onCommand } = setup()
      const command = vi.fn()
      const item: PickerItem = { id: 'todo', label: 'TODO' }

      // Single match, long query — the old code would have armed a 200ms timer.
      lifecycle.onUpdate({ items: [item], query: 'todo', command })

      // Advance well past the former auto-execute delay.
      vi.advanceTimersByTime(5000)

      expect(command).not.toHaveBeenCalled()
      expect(onCommand).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does NOT run a command when the user pauses on a single match', () => {
    vi.useFakeTimers()
    try {
      const { lifecycle } = setup()
      const command = vi.fn()
      const item: PickerItem = { id: 'heading-1', label: 'Heading 1' }

      lifecycle.onStart({ items: [item], query: '', command })
      lifecycle.onUpdate({ items: [item], query: 'heading', command })
      vi.advanceTimersByTime(5000) // a long idle pause
      expect(command).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('runs onCommand on an explicit selection via the picker command path', () => {
    const onCommand = vi.fn()
    const { command } = setup({ onCommand })
    const item: PickerItem = { id: 'todo', label: 'TODO' }

    const editor = {
      chain: () => ({
        focus: () => ({
          deleteRange: () => ({ run: vi.fn() }),
        }),
      }),
    }

    command({ editor, range: { from: 0, to: 5 }, props: item })

    expect(onCommand).toHaveBeenCalledWith(item, editor)
  })

  // #1344 — the slash menu must not trigger mid-word (URLs, `6/15`,
  // "and/or"). The picker-plugin's `allowedPrefixes` gates the trigger to
  // a block start or after whitespace; the trigger logic itself lives in
  // picker-plugin (unit-tested there), so here we assert the config value
  // the slash extension hands to `createPickerPlugin` matches the AtTagPicker
  // whitelist exactly (regular space, NBSP, newline) — i.e. NOT `null`.
  it('gates the trigger to whitespace prefixes, matching AtTagPicker (#1344)', () => {
    setup()
    expect(capturedPickerConfig['char']).toBe('/')
    expect(capturedPickerConfig['allowedPrefixes']).toEqual([' ', ' ', '\n'])
    // Guard against a regression back to the unrestricted (mid-word) config.
    expect(capturedPickerConfig['allowedPrefixes']).not.toBeNull()
  })

  it('lifecycle has no timer side effects — onKeyDown/onExit are inert pass-throughs', () => {
    vi.useFakeTimers()
    try {
      const { lifecycle } = setup()
      const command = vi.fn()
      const item: PickerItem = { id: 'todo', label: 'TODO' }

      lifecycle.onUpdate({ items: [item], query: 'todo', command })
      lifecycle.onKeyDown({ event: new KeyboardEvent('keydown', { key: 'ArrowDown' }) })
      lifecycle.onExit()
      vi.advanceTimersByTime(5000)

      expect(command).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})
