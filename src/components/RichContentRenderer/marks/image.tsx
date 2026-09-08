import type React from 'react'

import { CollapsibleImage } from '@/components/rendering/CollapsibleImage'
import { GatedImage } from '@/components/rendering/GatedImage'
import type { RenderContext } from '@/components/RichContentRenderer/context'
import type { ImageNode } from '@/editor/types'

/**
 * Static (read-only) render of a markdown `![alt](url)` image (#1434, #1492).
 *
 * Delegates to the shared `CollapsibleImage`, which wraps `GatedImage` in the
 * #4711 collapse toggle and applies the external-image load policy + per-host
 * allowlist (#1492): external `http(s)` images are withheld (placeholder, no
 * network) until the policy/allowlist permits them; local / `data:` / `blob:` /
 * `asset:` / same-origin images load directly and keep the #1434 broken-image
 * fallback on load error.
 *
 * The #4711 collapse toggle is a `<button>`, so it is rendered ONLY when the
 * surface is interactive. `ResultCard` wraps its whole row in a native button
 * and passes `interactive: false` for exactly this reason (see its
 * "keep chips inert to avoid nested-interactive" note); a toggle there would
 * nest a button inside a button — an `axe` `nested-interactive` violation —
 * and its click would bubble to the card's navigate handler, so folding a
 * thumbnail would take the user off the panel. Same rule `renderBlockLink`
 * applies to its chip.
 *
 * An inert surface therefore ignores the collapsed state as well as the
 * toggle, on purpose: honouring a fold with no way to undo it would leave a
 * search result or a drag overlay showing a chip the reader cannot open, in a
 * place whose whole job is to preview the content.
 */
export function renderImage(node: ImageNode, key: string, ctx: RenderContext): React.ReactElement {
  if (ctx.interactive !== true) {
    return <GatedImage key={key} src={node.attrs.src} alt={node.attrs.alt} />
  }
  return <CollapsibleImage key={key} src={node.attrs.src} alt={node.attrs.alt} />
}
