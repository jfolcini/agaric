/**
 * TipTap extension: Blockquote that carries a `calloutType` attribute (#258).
 *
 * The app stores callouts as `> [!TYPE] …` markdown. The parser
 * (`markdown-parse/parser.ts` → `extractCallout`) sets `attrs.calloutType` on the
 * blockquote node, and the serializer (`markdown-serialize.ts` →
 * `serializeBlockquote`) emits `[!TYPE]` back from it. But the editor used
 * stock `@tiptap/extension-blockquote`, which has no `calloutType` attribute —
 * so the type was silently dropped on the parse→setContent→serialize round
 * trip, downgrading every callout to a plain blockquote (affecting both the
 * `/callout` slash command and the toolbar Callout button).
 *
 * Declaring the attribute here lets it survive editing, and `calloutFold`
 * (the `-` / `+` after `[!TYPE]`) with it. The visible callout styling lives
 * in the static renderer (`RichContentRenderer`); in the editor the node
 * round-trips as a blockquote tagged with `data-callout-type`, and
 * `data-callout-style` names the style its type maps to for the editor's CSS.
 * The editor always shows a folded callout open.
 */

import Blockquote from '@tiptap/extension-blockquote'

import { calloutStyle } from '@/lib/callout-style'

export const CalloutBlockquote = Blockquote.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      calloutType: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-callout-type'),
        renderHTML: (attributes) => {
          const type = attributes['calloutType'] as string | null
          return type ? { 'data-callout-type': type, 'data-callout-style': calloutStyle(type) } : {}
        },
      },
      calloutFold: {
        default: null,
        parseHTML: (element) => {
          const fold = element.getAttribute('data-callout-fold')
          return fold === '-' || fold === '+' ? fold : null
        },
        renderHTML: (attributes) =>
          attributes['calloutFold']
            ? { 'data-callout-fold': attributes['calloutFold'] as string }
            : {},
      },
    }
  },
})
