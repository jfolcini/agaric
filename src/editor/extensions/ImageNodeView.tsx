/**
 * React node view for the inline image node (#1434).
 *
 * The editor models a markdown `![alt](url)` image as an atomic INLINE node
 * whose `attrs.src` is the image URL and `attrs.alt` the alt text (mirrors the
 * `math_inline` atom pattern). The node view renders an `<img>` and, on a load
 * error, falls back to a labelled placeholder showing the alt text (or the URL
 * when alt is empty) instead of a bare broken-image icon — so a dead/unresolved
 * src always has human context.
 *
 * SCOPE (#1434 slice): render + markdown round-trip only. `src` is treated as an
 * opaque URL; binary paste/drag-drop → attachment and attachment-path export are
 * explicit FOLLOW-UPs handled elsewhere.
 */

import { type NodeViewProps, NodeViewWrapper } from '@tiptap/react'
import { useState } from 'react'

export function ImageNodeView(props: NodeViewProps): React.ReactElement {
  const { node } = props
  const src = (node.attrs['src'] as string | undefined) ?? ''
  const alt = (node.attrs['alt'] as string | undefined) ?? ''
  const [failed, setFailed] = useState(false)

  return (
    <NodeViewWrapper
      as="span"
      className="image-node-view inline-block align-middle"
      data-testid="image-node-view"
      // contentEditable=false — an atom; src/alt are edited as markdown text, not
      // as inline ProseMirror content.
      contentEditable={false}
    >
      {failed ? (
        <span
          className="image-broken inline-flex items-center gap-1 rounded border border-dashed border-input bg-muted px-1 text-sm text-muted-foreground"
          data-testid="image-broken"
          // The placeholder still labels the image so a dead src has context.
          aria-label={alt.length > 0 ? alt : src}
          title={src}
        >
          {/* A small inline marker plus the alt text (or URL) so the user knows
              what failed to load. */}
          <span aria-hidden="true">🖼️</span>
          <span>{alt.length > 0 ? alt : src}</span>
        </span>
      ) : (
        <img
          src={src}
          alt={alt}
          className="image-rendered max-w-full"
          data-testid="image-rendered"
          // Show a broken-image fallback (alt text / placeholder) on load error
          // rather than leaving the browser's context-free broken-image glyph.
          onError={() => setFailed(true)}
        />
      )}
    </NodeViewWrapper>
  )
}
