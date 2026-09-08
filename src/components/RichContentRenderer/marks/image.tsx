import type React from 'react'

import { CollapsibleImage } from '@/components/rendering/CollapsibleImage'
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
 */
export function renderImage(node: ImageNode, key: string): React.ReactElement {
  return <CollapsibleImage key={key} src={node.attrs.src} alt={node.attrs.alt} />
}
