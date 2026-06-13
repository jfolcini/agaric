/**
 * Tests for the `:` inline emoji-picker extension (T2 / #1023).
 *
 * The 6th suggestion trigger. Its coexistence with `::` (property trigger) and
 * ordinary colons (`http://`, `3:30`, `key:value`) is handled by TWO gates, not
 * by the items callback:
 *   1. `allowedPrefixes` — space / NBSP / newline / start-of-block.
 *   2. `allow` — `:` + ≥2 of [word|+|-] (the `EMOJI_QUERY_RE`), AND a LIVE read
 *      of `isEmojiPickerEnabled()` so the Settings toggle takes effect with no
 *      remount.
 *
 * On select, the command chain is `deleteRange(range) → insertContent(emoji)`.
 *
 * The extension delegates to `@tiptap/suggestion` via `createPickerPlugin`, so
 * we mock `@tiptap/suggestion` to capture the options object and exercise its
 * `allow` / `items` / `command` callbacks directly.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { EMOJI_PICKER_ENABLED_KEY } from '../../lib/editor-preferences'

type CapturedOptions = Record<string, unknown>

/** Load the extension with `@tiptap/suggestion` stubbed to capture options. */
async function loadWithCapturedOptions(): Promise<CapturedOptions> {
  const captured: { current: CapturedOptions | undefined } = { current: undefined }
  vi.resetModules()
  vi.doMock('@tiptap/suggestion', () => ({
    Suggestion: (opts: CapturedOptions) => {
      captured.current = opts
      return { spec: { key: opts['pluginKey'] } }
    },
  }))
  const mod = await import('../extensions/emoji-picker')
  const ext = mod.EmojiPicker
  ;(ext.config.addProseMirrorPlugins as (this: unknown) => unknown).call({
    editor: {} as unknown,
    options: ext.options,
  })
  if (!captured.current) throw new Error('Suggestion options were not captured')
  return captured.current
}

/** Build a fake editor `state` whose `textBetween` returns `text`. */
function stateReturning(text: string) {
  return {
    doc: {
      textBetween: () => text,
    },
  }
}

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  vi.doUnmock('@tiptap/suggestion')
  vi.resetModules()
  vi.clearAllMocks()
  localStorage.clear()
})

describe('EmojiPicker — identity', () => {
  it('is an Extension named "emojiPicker"', async () => {
    const mod = await import('../extensions/emoji-picker')
    expect(mod.EmojiPicker.type).toBe('extension')
    expect(mod.EmojiPicker.name).toBe('emojiPicker')
  })
})

describe('EmojiPicker — suggestion configuration', () => {
  it('triggers on ":" and restricts allowedPrefixes to whitespace/start-of-block', async () => {
    const opts = await loadWithCapturedOptions()
    expect(opts['char']).toBe(':')
    // Space, NBSP (ProseMirror trailing-space normalisation), newline. This is
    // what stops `http://`, `3:30`, `key:value` from ever opening the picker.
    expect(opts['allowedPrefixes']).toEqual([' ', ' ', '\n'])
  })
})

describe('EmojiPicker — EMOJI_QUERY_RE gate (allow)', () => {
  // `:` followed by ≥2 word/+/- chars opens; everything else stays dormant.
  const OPENS = [':joy', ':smile', ':+1', ':wave', ':e_mail', ':a1', ':100']
  const DORMANT = [
    ':', // bare colon
    ':x', // only 1 trailing char
    ': ', // trailing colon + space
    '::', // the property trigger (second char is ':', not a word char)
    'key:value', // mid-word colon (textBetween would still be the whole token)
    ':!!', // punctuation only
  ]

  it.each(OPENS)('opens for %j', async (text) => {
    const opts = await loadWithCapturedOptions()
    const allow = opts['allow'] as (ctx: { state: unknown; range: unknown }) => boolean
    expect(allow({ state: stateReturning(text), range: { from: 0, to: text.length } })).toBe(true)
  })

  it.each(DORMANT)('stays dormant for %j', async (text) => {
    const opts = await loadWithCapturedOptions()
    const allow = opts['allow'] as (ctx: { state: unknown; range: unknown }) => boolean
    expect(allow({ state: stateReturning(text), range: { from: 0, to: text.length } })).toBe(false)
  })
})

describe('EmojiPicker — live isEmojiPickerEnabled read', () => {
  it('allow returns false when the picker is disabled in Settings, regardless of query', async () => {
    localStorage.setItem(EMOJI_PICKER_ENABLED_KEY, JSON.stringify(false))
    const opts = await loadWithCapturedOptions()
    const allow = opts['allow'] as (ctx: { state: unknown; range: unknown }) => boolean
    // `:joy` would otherwise open — the live preference gate overrides it.
    expect(allow({ state: stateReturning(':joy'), range: { from: 0, to: 4 } })).toBe(false)
  })

  it('allow returns true again once re-enabled, with no plugin rebuild', async () => {
    const opts = await loadWithCapturedOptions()
    const allow = opts['allow'] as (ctx: { state: unknown; range: unknown }) => boolean
    // Default (absent key) is enabled.
    expect(allow({ state: stateReturning(':joy'), range: { from: 0, to: 4 } })).toBe(true)
    // Disable mid-session: the SAME captured callback reads the new value.
    localStorage.setItem(EMOJI_PICKER_ENABLED_KEY, JSON.stringify(false))
    expect(allow({ state: stateReturning(':joy'), range: { from: 0, to: 4 } })).toBe(false)
    // Re-enable.
    localStorage.setItem(EMOJI_PICKER_ENABLED_KEY, JSON.stringify(true))
    expect(allow({ state: stateReturning(':joy'), range: { from: 0, to: 4 } })).toBe(true)
  })
})

describe('EmojiPicker — items mapping', () => {
  // `createPickerPlugin` wraps the extension's `items` in an async
  // `({ query }) => …` (with a try/catch). Drive that wrapped form.
  it('maps searchEmoji results to {id, label, emoji}', async () => {
    const opts = await loadWithCapturedOptions()
    const items = opts['items'] as (ctx: {
      query: string
    }) => Promise<Array<{ id: string; label: string; emoji: string }>>
    const result = await items({ query: 'joy' })
    expect(result.length).toBeGreaterThan(0)
    const first = result[0]
    // `joy` resolves to 😂; id and label are the shortcode name, emoji the glyph.
    expect(first?.emoji).toBe('\u{1F602}')
    expect(first?.id).toBe('joy')
    expect(first?.label).toBe('joy')
  })

  it('returns an empty list for a no-match query', async () => {
    const opts = await loadWithCapturedOptions()
    const items = opts['items'] as (ctx: { query: string }) => Promise<unknown[]>
    expect(await items({ query: 'zzzznotanemoji' })).toEqual([])
  })
})

describe('EmojiPicker — command chain (deleteRange → insertContent)', () => {
  function chainRecorder() {
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
        calls.push(`insertContent:${String(c)}`)
        return chainProxy
      },
      run: () => {
        calls.push('run')
        return true
      },
    }
    return { calls, editor: { chain: () => chainProxy } }
  }

  it('replaces :query with the native emoji glyph from item.emoji', async () => {
    const opts = await loadWithCapturedOptions()
    const command = opts['command'] as (ctx: {
      editor: unknown
      range: { from: number; to: number }
      props: unknown
    }) => void
    const { calls, editor } = chainRecorder()

    command({
      editor,
      range: { from: 3, to: 8 },
      props: { id: 'joy', label: 'joy', emoji: '\u{1F602}' },
    })

    expect(calls).toEqual(['focus', 'deleteRange:3-8', 'insertContent:\u{1F602}', 'run'])
  })

  it('falls back to item.label when emoji is absent', async () => {
    const opts = await loadWithCapturedOptions()
    const command = opts['command'] as (ctx: {
      editor: unknown
      range: { from: number; to: number }
      props: unknown
    }) => void
    const { calls, editor } = chainRecorder()

    command({ editor, range: { from: 1, to: 4 }, props: { id: 'x', label: 'FALLBACK' } })

    expect(calls).toEqual(['focus', 'deleteRange:1-4', 'insertContent:FALLBACK', 'run'])
  })
})
