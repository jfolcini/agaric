/**
 * TipTap extension: `:` inline emoji picker (#130 Phase 2).
 *
 * The 6th suggestion trigger (after `@`, `[[`, `((`, `::`, `/`). Typing
 * `:shortcode` opens a fuzzy-matched emoji list; Enter/click replaces the
 * `:query` with the native Unicode emoji. No sprite sheet, no new
 * dependency — see `emoji-data.ts`.
 *
 * Coexistence with the existing `::` property trigger and ordinary colons is
 * handled by two gates, not by the items callback (so no spurious "No
 * results" popup ever flashes):
 *   1. `allowedPrefixes` (space / NBSP / newline / start-of-block) — mirrors
 *      AtTagPicker, so `http://`, `3:30`, `key:value` never trigger (their
 *      `:` isn't preceded by whitespace; NBSP covers ProseMirror's
 *      trailing-space normalisation).
 *   2. `allow` requires `:` + >=2 word-chars — so a bare `:`, a trailing
 *      `: `, `:x`, and the `::` property trigger (its second char is `:`, not
 *      a word char) all stay dormant and fall through to plain text / the
 *      property picker.
 */

import { Extension, InputRule } from '@tiptap/core'
import { PluginKey } from '@tiptap/pm/state'

import { pushEmojiRecent } from '../../hooks/useEmojiRecents'
import { isEmojiPickerEnabled } from '../../lib/editor-preferences'
import { emojiByShortcode, searchEmoji } from '../emoji-data'
import type { PickerItem } from '../SuggestionList'
import { createPickerPlugin } from './picker-plugin'

export const emojiPickerPluginKey = new PluginKey('emojiPicker')

/** `:` + >=2 of [word | + | -] and nothing else (rejects `::`, `:`, `: `). */
const EMOJI_QUERY_RE = /^:[A-Za-z0-9_+-]{2,}$/

export const EmojiPicker = Extension.create({
  name: 'emojiPicker',

  addProseMirrorPlugins() {
    return [
      createPickerPlugin({
        loggerComponent: 'EmojiPicker',
        displayName: 'Emoji',
        pluginKey: emojiPickerPluginKey,
        char: ':',
        allowedPrefixes: [' ', '\u00A0', '\n'],
        allow: ({ state, range }) => {
          // Live-read the user preference (#130 \u2014 disable-able in Settings \u2192
          // Editor). Read here so toggling takes effect with no remount.
          if (!isEmojiPickerEnabled()) return false
          // 'U+FFFC' is the leaf placeholder textBetween uses for non-text nodes.
          const text = state.doc.textBetween(range.from, range.to, undefined, '\uFFFC')
          return EMOJI_QUERY_RE.test(text)
        },
        editor: this.editor,
        items: (query) =>
          searchEmoji(query).map((e) => ({ id: e.name, label: e.name, emoji: e.char })),
        command: ({ editor, range, props }) => {
          const item = props as PickerItem
          const emoji = item.emoji ?? item.label
          // Replace `:query` with the native emoji literal.
          editor.chain().focus().deleteRange(range).insertContent(emoji).run()
          // Feed the recents strip so the browse-grid picker surfaces emoji the
          // user inserted by typing too (not just via the dialog).
          pushEmojiRecent(emoji)
        },
      }),
    ]
  },

  /**
   * `:shortcode:` closing-colon auto-replace (#281). The suggestion popup above
   * fires as the user types `:joy`; this rule additionally converts a COMPLETED
   * `:joy:` (Slack/GitHub style) the instant the closing colon is typed. Exact
   * `name` match only (deterministic 1:1), gated by the same enable preference,
   * and it preserves any leading whitespace the boundary regex consumed.
   */
  addInputRules() {
    return [
      new InputRule({
        // `:` + >=2 of [word | + | -] + `:`, anchored to start-or-whitespace so
        // `http://a:b:` / `3:30:` and the `::` property trigger never fire.
        find: /(?:^|\s):([A-Za-z0-9_+-]{2,}):$/,
        handler: ({ state, range, match }) => {
          if (!isEmojiPickerEnabled()) return null
          const name = match[1]
          if (name == null) return null
          const emoji = emojiByShortcode(name)
          if (emoji == null) return null
          // Replace only the `:name:` token, not any leading whitespace the
          // boundary alternation matched.
          const from = range.to - (name.length + 2)
          state.tr.insertText(emoji, from, range.to)
          pushEmojiRecent(emoji)
          return undefined
        },
      }),
    ]
  },
})
