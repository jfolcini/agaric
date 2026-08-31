/**
 * TipTap extension: the `{{` brace picker — embedded queries and embeds.
 *
 * Typing `{{` opens a two-item suggestion popup:
 *   - **Insert query…** — deletes the `{{` and opens the visual query builder
 *     for the focused block (via the shared slash-command dispatch — the
 *     `query` command id already maps to `openQueryBuilder`).
 *   - **Insert embed…** (#4550) — rewrites the trigger to `{{embed ` so the
 *     same popup re-opens in embed mode, listing block and page targets.
 *
 * Typing the literal `{{embed ` reaches embed mode directly. That is the
 * discoverability path for people arriving from Logseq who type the syntax
 * from muscle memory, and it is why the `allow` gate below has three shapes
 * rather than one. Selecting a target writes the finished
 * `{{embed ((ULID))}}` token into the block's content; `StaticBlock` sniffs
 * it on the next static render.
 *
 * Boundary with QueryHint (#907): the query item is only offered while the
 * query is empty (immediately after `{{`). Once the user types anything that
 * is not the embed prefix, the gate DEACTIVATES the plugin so manual
 * `{{query …}}` syntax + the QueryHint ghost-text completion take over.
 * Emptying the item list alone would leave a floating generic 'No results'
 * popup over the typing until the first space/Escape. Selection is always
 * explicit (Enter/click) — no auto-execute.
 *
 * Follows the same pattern as SlashCommand.
 */

import { Extension } from '@tiptap/core'
import { PluginKey } from '@tiptap/pm/state'

import { createPickerPlugin } from '@/editor/extensions/picker-plugin'
import type { PickerItem } from '@/editor/SuggestionList'
import { EMBED_TOKEN_PREFIX } from '@/lib/embed-token'
import { t } from '@/lib/i18n'

export const queryPickerPluginKey = new PluginKey('queryPicker')

/**
 * The query affordance. Its `id` is `query` so the shared slash-command
 * dispatch routes it to `openQueryBuilder` (see useSlashCommandStructural).
 */
const QUERY_PICKER_ITEM: PickerItem = { id: 'query', label: 'Insert query…' }

/** id of the embed affordance item below — checked in `command` by value. */
const EMBED_AFFORDANCE_ID = 'embed'

/**
 * The embed affordance offered alongside it. Selecting it does NOT go through
 * the slash dispatch: it rewrites the trigger in place so this same picker
 * re-opens in embed mode, which is the shortest path to "now type what you
 * want to embed". Built fresh (not a module-level constant) so the label is
 * read from `t()` at call time rather than at module-eval time.
 */
function embedAffordanceItem(): PickerItem {
  return { id: EMBED_AFFORDANCE_ID, label: t('embed.pickerItem') }
}

/**
 * Split `{{`-trigger query text into an embed search, or `null` when the text
 * is not an embed trigger. `''` → the bare `{{`; `'embed'` / `'embed '` →
 * embed mode with an empty search; `'embed foo'` → search `foo`.
 */
export function parseEmbedPickerQuery(query: string): string | null {
  const match = /^embed(?:\s+(.*))?$/.exec(query)
  if (!match) return null
  return match[1] ?? ''
}

export interface QueryPickerOptions {
  /**
   * Execute the embed-query affordance. Production wires this to the same
   * slash-command thunk used by `/query`, so it opens the visual builder for
   * the focused block. No `editor` param: handlers obtain it independently
   * (matching SlashCommand, #1668).
   */
  onCommand: (item: PickerItem) => void
  /**
   * #4550 — search embed targets (blocks AND pages; a page IS a block here,
   * so one list covers both). Called on every keystroke after `{{embed `.
   */
  embedItems: (query: string) => PickerItem[] | Promise<PickerItem[]>
}

export const QueryPicker = Extension.create<QueryPickerOptions>({
  name: 'queryPicker',

  addOptions() {
    return {
      onCommand: () => {},
      embedItems: () => [],
    }
  },

  addProseMirrorPlugins() {
    const extensionOptions = this.options
    const editor = this.editor
    return [
      createPickerPlugin({
        loggerComponent: 'QueryPicker',
        displayName: t('embed.pickerHeader'),
        pluginKey: queryPickerPluginKey,
        char: '{{',
        // #4550 — spaces must survive the match, because `{{embed ` HAS one
        // and an embed search is free text. This does not loosen the
        // `{{query …}}` handoff: the `allow` gate below is what closes the
        // popup there, and it rejects anything that is neither the bare `{{`
        // nor an embed trigger — a space merely reaches the gate sooner.
        allowSpaces: true,
        allowedPrefixes: null,
        // Gate activation to the bare `{{` or an `{{embed …}}` trigger
        // (mirrors the emoji picker's allow-gate rule): once the user types
        // manual `{{query …}}` syntax the plugin must DEACTIVATE so the popup
        // closes. U+FFFC is textBetween's leaf placeholder for non-text nodes.
        allow: ({ state, range }) => {
          const text = state.doc.textBetween(range.from, range.to, undefined, '\uFFFC')
          if (text === '{{') return true
          return parseEmbedPickerQuery(text.slice(2)) !== null
        },
        editor,
        items: (query) => {
          if (query === '') return [QUERY_PICKER_ITEM, embedAffordanceItem()]
          const embedQuery = parseEmbedPickerQuery(query)
          if (embedQuery === null) return []
          return extensionOptions.embedItems(embedQuery)
        },
        command: ({ editor: cmdEditor, range, props }) => {
          const item = props as PickerItem
          if (item.id === QUERY_PICKER_ITEM.id) {
            cmdEditor.chain().focus().deleteRange(range).run()
            extensionOptions.onCommand(QUERY_PICKER_ITEM)
            return
          }
          if (item.id === EMBED_AFFORDANCE_ID) {
            // Re-open THIS picker in embed mode rather than routing through
            // the slash dispatch — one fewer hop, and the caret lands exactly
            // where the search query goes.
            cmdEditor.chain().focus().deleteRange(range).insertContent(EMBED_TOKEN_PREFIX).run()
            return
          }
          // A concrete embed target: `{{embed ` + a real `block_ref` NODE +
          // `}}`.
          //
          // The inner token MUST be a node, not text. `((ULID))` typed as
          // literal text is deliberately ESCAPED on serialize
          // (`\((ULID))` — see `markdown-roundtrip-fidelity`'s finding 11,
          // which is what keeps a literal mention from resurrecting as a live
          // ref), and the escaped form matches neither `parseEmbedToken` nor
          // the backend's `ULID_LINK_RE`. Inserting text here would therefore
          // produce a block that renders as inert text AND contributes no
          // backlink — silently, on the first blur. The node form serializes
          // bare and reparses to exactly this doc.
          cmdEditor
            .chain()
            .focus()
            .deleteRange(range)
            .insertContent(EMBED_TOKEN_PREFIX)
            .insertBlockRef(item.id)
            .insertContent('}}')
            .run()
        },
      }),
    ]
  },
})
