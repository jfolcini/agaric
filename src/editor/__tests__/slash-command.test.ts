import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PickerItem } from '../SuggestionList'

// --- Mocks ---

let capturedSuggestionConfig: Record<string, unknown> = {}

vi.mock('@tiptap/suggestion', () => ({
  Suggestion: (config: Record<string, unknown>) => {
    capturedSuggestionConfig = config
    return {}
  },
}))

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

// --- Import after mocks ---
import { SlashCommand } from '../extensions/slash-command'

/** Trigger addProseMirrorPlugins and return the render lifecycle object. */
function getLifecycle() {
  const ctx = {
    editor: {},
    options: { items: () => [], onCommand: vi.fn() },
  }
  // biome-ignore lint/suspicious/noExplicitAny: test helper — call with mock context
  ;(SlashCommand as any).addProseMirrorPlugins.call(ctx)
  const render = capturedSuggestionConfig['render'] as () => {
    onStart: (props: Record<string, unknown>) => void
    onUpdate: (props: Record<string, unknown>) => void
    onKeyDown: (props: Record<string, unknown>) => boolean
    onExit: () => void
  }
  return render()
}

describe('slash-command auto-execute', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('auto-executes when exactly 1 item and query >= 3 chars after 200ms', () => {
    const lifecycle = getLifecycle()
    const command = vi.fn()
    const item: PickerItem = { id: 'todo', label: 'TODO' }

    lifecycle.onUpdate({ items: [item], query: 'tod', command })
    expect(command).not.toHaveBeenCalled()

    vi.advanceTimersByTime(200)
    expect(command).toHaveBeenCalledWith(item)
  })

  it('does not auto-execute when multiple items', () => {
    const lifecycle = getLifecycle()
    const command = vi.fn()
    const items: PickerItem[] = [
      { id: 'todo', label: 'TODO' },
      { id: 'today', label: 'Today' },
    ]

    lifecycle.onUpdate({ items, query: 'tod', command })
    vi.advanceTimersByTime(200)
    expect(command).not.toHaveBeenCalled()
  })

  it('does not auto-execute when query < 3 chars', () => {
    const lifecycle = getLifecycle()
    const command = vi.fn()
    const item: PickerItem = { id: 'todo', label: 'TODO' }

    lifecycle.onUpdate({ items: [item], query: 'to', command })
    vi.advanceTimersByTime(200)
    expect(command).not.toHaveBeenCalled()
  })

  it('cancels auto-execute timer on keyDown', () => {
    const lifecycle = getLifecycle()
    const command = vi.fn()
    const item: PickerItem = { id: 'todo', label: 'TODO' }

    lifecycle.onUpdate({ items: [item], query: 'tod', command })
    lifecycle.onKeyDown({ event: new KeyboardEvent('keydown', { key: 'ArrowDown' }) })
    vi.advanceTimersByTime(200)
    expect(command).not.toHaveBeenCalled()
  })

  it('cancels auto-execute timer on exit', () => {
    const lifecycle = getLifecycle()
    const command = vi.fn()
    const item: PickerItem = { id: 'todo', label: 'TODO' }

    lifecycle.onUpdate({ items: [item], query: 'tod', command })
    lifecycle.onExit()
    vi.advanceTimersByTime(200)
    expect(command).not.toHaveBeenCalled()
  })

  it('resets timer on onUpdate with new items', () => {
    const lifecycle = getLifecycle()
    const command1 = vi.fn()
    const command2 = vi.fn()
    const item1: PickerItem = { id: 'todo', label: 'TODO' }
    const item2: PickerItem = { id: 'done', label: 'DONE' }

    // First update starts a timer
    lifecycle.onUpdate({ items: [item1], query: 'tod', command: command1 })
    vi.advanceTimersByTime(100) // halfway through first timer

    // Second update resets the timer
    lifecycle.onUpdate({ items: [item2], query: 'don', command: command2 })
    vi.advanceTimersByTime(100) // 100ms into second timer — not yet
    expect(command1).not.toHaveBeenCalled()
    expect(command2).not.toHaveBeenCalled()

    vi.advanceTimersByTime(100) // now 200ms into second timer
    expect(command1).not.toHaveBeenCalled()
    expect(command2).toHaveBeenCalledWith(item2)
  })

  it('defensively clears a pending timer on onStart (BUG-33)', () => {
    const lifecycle = getLifecycle()
    const command = vi.fn()
    const item: PickerItem = { id: 'todo', label: 'TODO' }

    // First session: onUpdate arms the auto-exec timer
    lifecycle.onUpdate({ items: [item], query: 'tod', command })
    vi.advanceTimersByTime(100) // timer not yet fired

    // Re-entry without a prior onExit (defensive scenario): onStart should
    // cancel the lingering timer so the stale command does not fire.
    lifecycle.onStart({ items: [item], query: '', command })

    // Advance past the original 200ms delay — nothing should fire.
    vi.advanceTimersByTime(200)
    expect(command).not.toHaveBeenCalled()
  })

  // ── Lifecycle breadcrumbs (MAINT-121) ────────────────────────────
  //
  // The auto-execute timer used to be a silent setTimeout — we now
  // emit logger.debug breadcrumbs for scheduling, cancellation, and
  // firing so a future session can trace why a slash command did or
  // did not auto-fire.

  it('emits a debug breadcrumb when scheduling and firing the auto-execute timer', async () => {
    const { logger } = await import('../../lib/logger')
    const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {})

    const lifecycle = getLifecycle()
    const command = vi.fn()
    const item: PickerItem = { id: 'todo', label: 'TODO' }

    lifecycle.onUpdate({ items: [item], query: 'tod', command })
    expect(debugSpy).toHaveBeenCalledWith(
      'slash-command',
      'auto-execute timer scheduled',
      expect.objectContaining({ delayMs: 200, query: 'tod', itemId: 'todo' }),
    )

    vi.advanceTimersByTime(200)
    expect(debugSpy).toHaveBeenCalledWith(
      'slash-command',
      'auto-execute timer fired',
      expect.objectContaining({ query: 'tod', itemId: 'todo' }),
    )

    debugSpy.mockRestore()
  })

  it('emits a debug breadcrumb when the timer is cleared on keyDown / exit / start', async () => {
    const { logger } = await import('../../lib/logger')
    const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {})

    const lifecycle = getLifecycle()
    const command = vi.fn()
    const item: PickerItem = { id: 'todo', label: 'TODO' }

    // onKeyDown clears
    lifecycle.onUpdate({ items: [item], query: 'tod', command })
    lifecycle.onKeyDown({ event: new KeyboardEvent('keydown', { key: 'ArrowDown' }) })
    expect(debugSpy).toHaveBeenCalledWith(
      'slash-command',
      'auto-execute timer cleared on onKeyDown',
      expect.objectContaining({ reason: 'user-keypress', key: 'ArrowDown' }),
    )

    // onExit clears
    lifecycle.onUpdate({ items: [item], query: 'tod', command })
    lifecycle.onExit()
    expect(debugSpy).toHaveBeenCalledWith(
      'slash-command',
      'auto-execute timer cleared on onExit',
      expect.objectContaining({ reason: 'session-exit' }),
    )

    // onStart clears (defensive, on re-entry)
    lifecycle.onUpdate({ items: [item], query: 'tod', command })
    lifecycle.onStart({ items: [item], query: '', command })
    expect(debugSpy).toHaveBeenCalledWith(
      'slash-command',
      'auto-execute timer cleared on onStart',
      expect.objectContaining({ reason: 'lingering-timer-from-previous-session' }),
    )

    debugSpy.mockRestore()
  })
})
