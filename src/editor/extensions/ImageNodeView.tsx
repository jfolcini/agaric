/**
 * React node view for the inline image node (#1434, #1492).
 *
 * The editor models a markdown `![alt](url)` image as an atomic INLINE node
 * whose `attrs.src` is the image URL and `attrs.alt` the alt text. Rendering is
 * delegated to the shared `GatedImage`, which applies the external-image load
 * policy + per-host allowlist (#1492): external `http(s)` images are withheld
 * (placeholder showing the domain + a "Load" button in `click` mode; a muted
 * blocked state in `never` mode) until policy/allowlist permits them — no
 * `<img src>` is mounted while withheld, so no network request is made. Local /
 * `data:` / `blob:` / `asset:` / same-origin srcs load directly and keep the
 * #1434 broken-image fallback on load error.
 *
 * SCOPE: render + markdown round-trip only; `src` is an opaque URL.
 */

import { type NodeViewProps, NodeViewWrapper } from '@tiptap/react'

import { GatedImage } from '@/components/rendering/GatedImage'

export function ImageNodeView(props: NodeViewProps): React.ReactElement {
  const { node } = props
  const src = (node.attrs['src'] as string | undefined) ?? ''
  const alt = (node.attrs['alt'] as string | undefined) ?? ''

  return (
    <NodeViewWrapper
      as="span"
      className="image-node-view inline-block align-middle"
      data-testid="image-node-view"
      // contentEditable=false — an atom; src/alt are edited as markdown text, not
      // as inline ProseMirror content.
      contentEditable={false}
    >
      <GatedImage src={src} alt={alt} imgClassName="image-rendered max-w-full" />
    </NodeViewWrapper>
  )
}
