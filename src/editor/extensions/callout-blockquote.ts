/**
 * TipTap extension: Blockquote that carries a `calloutType` attribute (#258).
 *
 * The app stores callouts as `> [!TYPE] …` markdown. The parser
 * (`markdown-parse.ts` → `extractCalloutType`) sets `attrs.calloutType` on the
 * blockquote node, and the serializer (`markdown-serialize.ts` →
 * `serializeBlockquote`) emits `[!TYPE]` back from it. But the editor used
 * stock `@tiptap/extension-blockquote`, which has no `calloutType` attribute —
 * so the type was silently dropped on the parse→setContent→serialize round
 * trip, downgrading every callout to a plain blockquote (affecting both the
 * `/callout` slash command and the toolbar Callout button).
 *
 * Declaring the attribute here lets it survive editing. The visible callout
 * styling lives in the static renderer (`RichContentRenderer`); in the editor
 * the node round-trips as a blockquote tagged with `data-callout-type`.
 */

import Blockquote from '@tiptap/extension-blockquote'

export const CalloutBlockquote = Blockquote.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      calloutType: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-callout-type'),
        renderHTML: (attributes) =>
          attributes['calloutType']
            ? { 'data-callout-type': attributes['calloutType'] as string }
            : {},
      },
    }
  },
})
