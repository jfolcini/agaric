/**
 * Tests for the shared `createPickerPlugin(cfg)` helper.
 *
 * The 5 picker extensions (AtTagPicker, BlockLinkPicker, BlockRefPicker,
 * SlashCommand, PropertyPicker) all delegate their `addProseMirrorPlugins`
 * shell to this helper. These tests exercise the helper directly to lock
 * down the wrapped items behaviour, the renderer wiring, and the
 * passthrough of allowSpaces / allowedPrefixes / pluginKey.
 */

import { PluginKey } from '@tiptap/pm/state'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { PickerItem } from '../SuggestionList'

type CapturedOptions = Record<string, unknown>

afterEach(() => {
  vi.doUnmock('@tiptap/suggestion')
  vi.doUnmock('../suggestion-renderer')
  vi.resetModules()
})

/**
 * Mocks `@tiptap/suggestion` to capture options and `../suggestion-renderer`
 * with a stub that returns lifecycle hooks tagged with the call args.
 * Returns the freshly-loaded helper module.
 */
async function loadHelper(): Promise<{
  createPickerPlugin: typeof import('../extensions/picker-plugin').createPickerPlugin
  captured: { current: CapturedOptions | undefined }
  rendererArgs: {
    current: { label: unknown; key: unknown; triggerChar: unknown } | undefined
  }
}> {
  const captured: { current: CapturedOptions | undefined } = { current: undefined }
  const rendererArgs: {
    current: { label: unknown; key: unknown; triggerChar: unknown } | undefined
  } = {
    current: undefined,
  }
  vi.resetModules()
  vi.doMock('@tiptap/suggestion', () => ({
    Suggestion: (opts: CapturedOptions) => {
      captured.current = opts
      return { spec: { key: opts['pluginKey'] } }
    },
  }))
  vi.doMock('../suggestion-renderer', () => ({
    createSuggestionRenderer: (label: unknown, key: unknown, triggerChar: unknown) => {
      rendererArgs.current = { label, key, triggerChar }
      return {
        onStart: vi.fn(),
        onUpdate: vi.fn(),
        onKeyDown: vi.fn(() => false),
        onExit: vi.fn(),
      }
    },
  }))
  const mod = await import('../extensions/picker-plugin')
  return { createPickerPlugin: mod.createPickerPlugin, captured, rendererArgs }
}

/** Build a baseline cfg with placeholders for the test under inspection. */
function makeCfg(
  overrides: Partial<
    Parameters<typeof import('../extensions/picker-plugin').createPickerPlugin>[0]
  > = {},
): Parameters<typeof import('../extensions/picker-plugin').createPickerPlugin>[0] {
  const pluginKey = new PluginKey('testPicker')
  return {
    loggerComponent: 'TestPicker',
    displayName: 'Test',
    pluginKey,
    char: '@',
    editor: {} as never,
    items: () => [],
    command: () => {},
    ...overrides,
  }
}

describe('createPickerPlugin — smoke', () => {
  it('returns the value produced by Suggestion(...) (ProseMirror plugin stub)', async () => {
    const { createPickerPlugin, captured } = await loadHelper()
    const result = createPickerPlugin(makeCfg())
    expect(captured.current).toBeDefined()
    expect(result).toEqual({ spec: { key: captured.current?.['pluginKey'] } })
  })

  it('forwards pluginKey, char, editor, and command unchanged to Suggestion(...)', async () => {
    const { createPickerPlugin, captured } = await loadHelper()
    const pluginKey = new PluginKey('myPicker')
    const editor = { id: 'editor-stub' } as never
    const command = vi.fn()
    createPickerPlugin(makeCfg({ pluginKey, char: '[[', editor, command }))
    expect(captured.current?.['pluginKey']).toBe(pluginKey)
    expect(captured.current?.['char']).toBe('[[')
    expect(captured.current?.['editor']).toBe(editor)
    expect(captured.current?.['command']).toBe(command)
  })
})

describe('createPickerPlugin — wrapped items callback', () => {
  it('invokes the configured items and returns its resolved result', async () => {
    const { createPickerPlugin, captured } = await loadHelper()
    const userItems = vi
      .fn<(query: string) => Promise<PickerItem[]>>()
      .mockResolvedValue([{ id: 'A', label: 'Alpha' }])
    createPickerPlugin(makeCfg({ items: userItems }))

    const wrapped = captured.current?.['items'] as (ctx: { query: string }) => Promise<PickerItem[]>
    const result = await wrapped({ query: 'al' })

    expect(userItems).toHaveBeenCalledWith('al')
    expect(result).toEqual([{ id: 'A', label: 'Alpha' }])
  })

  it('also accepts a synchronous items callback (returns array directly)', async () => {
    const { createPickerPlugin, captured } = await loadHelper()
    const userItems = vi.fn().mockReturnValue([{ id: 'B', label: 'Beta' }])
    createPickerPlugin(makeCfg({ items: userItems }))

    const wrapped = captured.current?.['items'] as (ctx: { query: string }) => Promise<PickerItem[]>
    const result = await wrapped({ query: 'b' })

    expect(userItems).toHaveBeenCalledWith('b')
    expect(result).toEqual([{ id: 'B', label: 'Beta' }])
  })

  it('catches thrown errors, logs logger.warn with loggerComponent, and returns []', async () => {
    const { createPickerPlugin, captured } = await loadHelper()
    // Import the logger AFTER loadHelper() — vi.resetModules() inside the
    // loader drops the module cache, so the picker-plugin and the test
    // must share the same fresh logger instance for the spy to apply.
    const { logger } = await import('../../lib/logger')
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})

    const userItems = vi.fn().mockRejectedValue(new Error('IPC down'))
    createPickerPlugin(makeCfg({ loggerComponent: 'MyPicker', items: userItems }))

    const wrapped = captured.current?.['items'] as (ctx: { query: string }) => Promise<PickerItem[]>
    const result = await wrapped({ query: 'oops' })

    expect(result).toEqual([])
    expect(userItems).toHaveBeenCalledWith('oops')
    expect(warnSpy).toHaveBeenCalledWith(
      'MyPicker',
      'items callback failed, returning empty',
      { query: 'oops' },
      expect.any(Error),
    )

    warnSpy.mockRestore()
  })
})

describe('createPickerPlugin — defaulting', () => {
  it('does not pass `allowSpaces` when omitted (TipTap default applies)', async () => {
    const { createPickerPlugin, captured } = await loadHelper()
    createPickerPlugin(makeCfg())
    expect(captured.current).toBeDefined()
    expect(captured.current).not.toHaveProperty('allowSpaces')
  })

  it('passes `allowSpaces: true` through when specified', async () => {
    const { createPickerPlugin, captured } = await loadHelper()
    createPickerPlugin(makeCfg({ allowSpaces: true }))
    expect(captured.current?.['allowSpaces']).toBe(true)
  })

  it('passes `allowSpaces: false` through when specified', async () => {
    const { createPickerPlugin, captured } = await loadHelper()
    createPickerPlugin(makeCfg({ allowSpaces: false }))
    expect(captured.current?.['allowSpaces']).toBe(false)
  })

  it('does not pass `allowedPrefixes` when omitted (TipTap default applies)', async () => {
    const { createPickerPlugin, captured } = await loadHelper()
    createPickerPlugin(makeCfg())
    expect(captured.current).toBeDefined()
    expect(captured.current).not.toHaveProperty('allowedPrefixes')
  })

  it('passes `allowedPrefixes: null` through when specified', async () => {
    const { createPickerPlugin, captured } = await loadHelper()
    createPickerPlugin(makeCfg({ allowedPrefixes: null }))
    expect(captured.current?.['allowedPrefixes']).toBeNull()
  })

  it('passes a custom `allowedPrefixes` array through when specified', async () => {
    const { createPickerPlugin, captured } = await loadHelper()
    createPickerPlugin(makeCfg({ allowedPrefixes: [' ', '\u00A0', '\n'] }))
    expect(captured.current?.['allowedPrefixes']).toEqual([' ', '\u00A0', '\n'])
  })
})

describe('createPickerPlugin — render', () => {
  it('default render() invokes createSuggestionRenderer(displayName, pluginKey, char)', async () => {
    const { createPickerPlugin, captured, rendererArgs } = await loadHelper()
    const pluginKey = new PluginKey('renderTest')
    createPickerPlugin(makeCfg({ displayName: 'Block links', pluginKey, char: '[[' }))

    const renderFactory = captured.current?.['render'] as () => {
      onStart: unknown
      onUpdate: unknown
      onKeyDown: unknown
      onExit: unknown
    }
    expect(renderFactory).toBeTypeOf('function')
    const lifecycle = renderFactory()
    expect(rendererArgs.current).toEqual({
      label: 'Block links',
      key: pluginKey,
      triggerChar: '[[',
    })
    expect(lifecycle.onStart).toBeTypeOf('function')
    expect(lifecycle.onUpdate).toBeTypeOf('function')
    expect(lifecycle.onKeyDown).toBeTypeOf('function')
    expect(lifecycle.onExit).toBeTypeOf('function')
  })

  it('passes a caller-supplied `render` override straight through to Suggestion(...)', async () => {
    const { createPickerPlugin, captured, rendererArgs } = await loadHelper()
    const customRender = vi.fn(() => ({
      onStart: vi.fn(),
      onUpdate: vi.fn(),
      onKeyDown: vi.fn(() => false),
      onExit: vi.fn(),
    }))
    createPickerPlugin(makeCfg({ render: customRender }))

    expect(captured.current?.['render']).toBe(customRender)
    // The default factory must not have been called when an override is provided.
    expect(rendererArgs.current).toBeUndefined()
  })
})

// ── MAINT-203 — resolveAndInsertPickerToken ─────────────────────────────────
//
// Focused tests for the shared FE-M-15 race-guard helper. The per-picker
// suites (at-tag-picker.test.ts, block-link-picker.test.ts,
// block-ref-picker.test.ts) exercise the end-to-end input-rule + command
// paths through their picker; these tests pin down the helper's branches
// directly so the next race-fix lands with confidence.

import { resolveAndInsertPickerToken } from '../extensions/picker-plugin'

/** Build a chainProxy mock that records insertContent / insertContentAt calls. */
function makeChainProxy() {
  const calls: {
    insertContent: unknown[]
    insertContentAt: Array<{ pos: number; content: unknown }>
  } = { insertContent: [], insertContentAt: [] }
  const chain: Record<string, unknown> = {
    focus: () => chain,
    insertContent: (content: unknown) => {
      calls.insertContent.push(content)
      return chain
    },
    insertContentAt: (pos: number, content: unknown) => {
      calls.insertContentAt.push({ pos, content })
      return chain
    },
    run: () => true,
  }
  return { chain, calls }
}

function makeEditor(docSize: number, viewOverride?: { isDestroyed: boolean }) {
  const { chain, calls } = makeChainProxy()
  const editor = {
    chain: () => chain,
    state: { doc: { content: { size: docSize } } },
    ...(viewOverride ? { view: viewOverride } : {}),
  } as unknown as Parameters<typeof resolveAndInsertPickerToken>[0]['editor']
  return { editor, calls }
}

describe('resolveAndInsertPickerToken — happy path', () => {
  it('inserts the token at insertPos on exact match', async () => {
    const { editor, calls } = makeEditor(1000)
    await resolveAndInsertPickerToken({
      editor,
      text: 'myTag',
      insertPos: 5,
      items: () => [{ id: 'ULID_1', label: 'myTag' }],
      matchItem: (items, text) => items.find((i) => i.label.toLowerCase() === text.toLowerCase()),
      tokenFor: (id) => ({ type: 'tag_ref', attrs: { id } }),
      loggerComponent: 'TestPicker',
      errorMessage: 'failed',
    })
    expect(calls.insertContentAt).toEqual([
      { pos: 5, content: { type: 'tag_ref', attrs: { id: 'ULID_1' } } },
    ])
    expect(calls.insertContent).toEqual([])
  })
})

describe('resolveAndInsertPickerToken — onCreate path', () => {
  it('invokes onCreate when no exact match and inserts the new token', async () => {
    const { editor, calls } = makeEditor(1000)
    const onCreate = vi.fn().mockResolvedValue('NEW_ULID')
    await resolveAndInsertPickerToken({
      editor,
      text: 'brand new',
      insertPos: 7,
      items: () => [],
      matchItem: () => undefined,
      tokenFor: (id) => ({ type: 'block_link', attrs: { id } }),
      onCreate,
      loggerComponent: 'TestPicker',
      errorMessage: 'failed',
    })
    expect(onCreate).toHaveBeenCalledWith('brand new')
    expect(calls.insertContentAt).toEqual([
      { pos: 7, content: { type: 'block_link', attrs: { id: 'NEW_ULID' } } },
    ])
  })

  it('falls back to plain text at insertPos when no match and no onCreate', async () => {
    const { editor, calls } = makeEditor(1000)
    await resolveAndInsertPickerToken({
      editor,
      text: 'orphan',
      insertPos: 3,
      items: () => [],
      matchItem: () => undefined,
      tokenFor: (id) => ({ type: 'tag_ref', attrs: { id } }),
      loggerComponent: 'TestPicker',
      errorMessage: 'failed',
    })
    expect(calls.insertContentAt).toEqual([{ pos: 3, content: 'orphan' }])
    expect(calls.insertContent).toEqual([])
  })
})

describe('resolveAndInsertPickerToken — stale insertPos guard (FE-M-15)', () => {
  it('falls back to insertContent at cursor when insertPos > doc.content.size (exact match)', async () => {
    // Doc shrank: captured insertPos (10) is past live doc size (5).
    const { editor, calls } = makeEditor(5)
    await resolveAndInsertPickerToken({
      editor,
      text: 'myTag',
      insertPos: 10,
      items: () => [{ id: 'ULID_1', label: 'myTag' }],
      matchItem: (items, text) => items.find((i) => i.label.toLowerCase() === text.toLowerCase()),
      tokenFor: (id) => ({ type: 'tag_ref', attrs: { id } }),
      loggerComponent: 'TestPicker',
      errorMessage: 'failed',
    })
    expect(calls.insertContent).toEqual(['myTag'])
    expect(calls.insertContentAt).toEqual([])
  })

  it('falls back to insertContent at cursor when insertPos stale on onCreate path', async () => {
    const { editor, calls } = makeEditor(5)
    const onCreate = vi.fn().mockResolvedValue('NEW_ULID')
    await resolveAndInsertPickerToken({
      editor,
      text: 'fresh',
      insertPos: 10,
      items: () => [],
      matchItem: () => undefined,
      tokenFor: (id) => ({ type: 'block_link', attrs: { id } }),
      onCreate,
      loggerComponent: 'TestPicker',
      errorMessage: 'failed',
    })
    expect(onCreate).toHaveBeenCalledWith('fresh')
    expect(calls.insertContent).toEqual(['fresh'])
    expect(calls.insertContentAt).toEqual([])
  })

  it('falls back to insertContent when stale and no match and no onCreate', async () => {
    const { editor, calls } = makeEditor(5)
    await resolveAndInsertPickerToken({
      editor,
      text: 'orphan',
      insertPos: 10,
      items: () => [],
      matchItem: () => undefined,
      tokenFor: (id) => ({ type: 'tag_ref', attrs: { id } }),
      loggerComponent: 'TestPicker',
      errorMessage: 'failed',
    })
    expect(calls.insertContent).toEqual(['orphan'])
    expect(calls.insertContentAt).toEqual([])
  })

  it('falls back to insertContent at cursor when stale on error path', async () => {
    const { editor, calls } = makeEditor(5)
    await resolveAndInsertPickerToken({
      editor,
      text: 'broken',
      insertPos: 10,
      items: () => {
        throw new Error('network')
      },
      matchItem: () => undefined,
      tokenFor: (id) => ({ type: 'tag_ref', attrs: { id } }),
      loggerComponent: 'TestPicker',
      errorMessage: 'failed',
    })
    expect(calls.insertContent).toEqual(['broken'])
    expect(calls.insertContentAt).toEqual([])
  })
})

describe('resolveAndInsertPickerToken — error fallback', () => {
  it('logs and re-inserts plain text at insertPos when items() throws', async () => {
    // vi.resetModules() in afterEach drops the module cache, so the
    // top-level `resolveAndInsertPickerToken` import binds to a stale
    // logger instance. Re-import both together inside the test so the
    // spy applies to the logger the helper actually calls.
    vi.resetModules()
    const { resolveAndInsertPickerToken: helper } = await import('../extensions/picker-plugin')
    const { logger } = await import('../../lib/logger')
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})

    const { editor, calls } = makeEditor(1000)
    await helper({
      editor,
      text: 'broken',
      insertPos: 7,
      items: () => {
        throw new Error('IPC down')
      },
      matchItem: () => undefined,
      tokenFor: (id) => ({ type: 'tag_ref', attrs: { id } }),
      loggerComponent: 'MyPicker',
      errorMessage: 'oops, fell back',
    })
    expect(calls.insertContentAt).toEqual([{ pos: 7, content: 'broken' }])
    expect(warnSpy).toHaveBeenCalledWith(
      'MyPicker',
      'oops, fell back',
      { text: 'broken' },
      expect.any(Error),
    )
    warnSpy.mockRestore()
  })
})

describe('resolveAndInsertPickerToken — editor destroyed mid-resolve', () => {
  it('returns early after items resolve if editor.view.isDestroyed', async () => {
    const { editor, calls } = makeEditor(1000, { isDestroyed: true })
    await resolveAndInsertPickerToken({
      editor,
      text: 'myTag',
      insertPos: 5,
      items: () => [{ id: 'ULID_1', label: 'myTag' }],
      matchItem: (items, text) => items.find((i) => i.label.toLowerCase() === text.toLowerCase()),
      tokenFor: (id) => ({ type: 'tag_ref', attrs: { id } }),
      loggerComponent: 'TestPicker',
      errorMessage: 'failed',
    })
    expect(calls.insertContent).toEqual([])
    expect(calls.insertContentAt).toEqual([])
  })

  it('returns early after onCreate resolves if editor.view.isDestroyed', async () => {
    const { editor, calls } = makeEditor(1000, { isDestroyed: true })
    await resolveAndInsertPickerToken({
      editor,
      text: 'fresh',
      insertPos: 5,
      items: () => [],
      matchItem: () => undefined,
      tokenFor: (id) => ({ type: 'block_link', attrs: { id } }),
      onCreate: async () => 'NEW_ULID',
      loggerComponent: 'TestPicker',
      errorMessage: 'failed',
    })
    expect(calls.insertContent).toEqual([])
    expect(calls.insertContentAt).toEqual([])
  })
})
