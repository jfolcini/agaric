import type React from 'react'

import type { ImageNode } from '../../../editor/types'
import { GatedImage } from '../../rendering/GatedImage'

/**
 * Static (read-only) render of a markdown `![alt](url)` image (#1434, #1492).
 *
 * Delegates to the shared `GatedImage`, which applies the external-image load
 * policy + per-host allowlist (#1492): external `http(s)` images are withheld
 * (placeholder, no network) until the policy/allowlist permits them; local /
 * `data:` / `blob:` / `asset:` / same-origin images load directly and keep the
 * #1434 broken-image fallback on load error.
 */
export function renderImage(node: ImageNode, key: string): React.ReactElement {
  return <GatedImage key={key} src={node.attrs.src} alt={node.attrs.alt} />
}
