import type React from 'react'
import { useState } from 'react'

import type { ImageNode } from '../../../editor/types'

/**
 * Static (read-only) render of a markdown `![alt](url)` image (#1434).
 *
 * Renders an `<img>` and, on a load error, falls back to a labelled placeholder
 * showing the alt text (or the URL when alt is empty) instead of the browser's
 * context-free broken-image glyph. SCOPE: render only; `src` is an opaque URL
 * (attachment-path resolution is a FOLLOW-UP).
 */
function StaticImage({ src, alt }: { src: string; alt: string }): React.ReactElement {
  const [failed, setFailed] = useState(false)

  if (failed) {
    return (
      <span
        className="image-broken inline-flex items-center gap-1 rounded border border-dashed border-input bg-muted px-1 text-sm text-muted-foreground align-middle"
        data-testid="image-broken"
        aria-label={alt.length > 0 ? alt : src}
        title={src}
      >
        <span aria-hidden="true">🖼️</span>
        <span>{alt.length > 0 ? alt : src}</span>
      </span>
    )
  }

  return (
    <img
      src={src}
      alt={alt}
      className="image-rendered inline-block max-w-full align-middle"
      data-testid="image-rendered"
      onError={() => setFailed(true)}
    />
  )
}

export function renderImage(node: ImageNode, key: string): React.ReactElement {
  return <StaticImage key={key} src={node.attrs.src} alt={node.attrs.alt} />
}
