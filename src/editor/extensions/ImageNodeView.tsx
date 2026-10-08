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
 * The collapse toggle (#4711) comes with `CollapsibleImage`, which wraps
 * `GatedImage`. Collapsing is a per-client view preference — it writes nothing
 * to the block — so the markdown round-trip below is untouched by it.
 *
 * Resizing (#4712) is document content: the handle writes the width into the
 * alt as Obsidian's `|width` suffix (`image-alt-size`), so `![alt|300](url)`
 * round-trips through the parser and serializer unchanged.
 */

import { type NodeViewProps, NodeViewWrapper } from '@tiptap/react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { CollapsibleImage, imageLabel } from '@/components/rendering/CollapsibleImage'
import { ImageResizeHandle } from '@/editor/extensions/ImageResizeHandle'
import { formatImageAlt, parseImageAlt } from '@/lib/image-alt-size'

export function ImageNodeView(props: NodeViewProps): React.ReactElement {
  const { node, updateAttributes } = props
  const { t } = useTranslation()
  const src = (node.attrs['src'] as string | undefined) ?? ''
  const alt = (node.attrs['alt'] as string | undefined) ?? ''
  const { text, width } = parseImageAlt(alt)
  // The in-flight drag's width, shown until the gesture commits.
  const [previewWidth, setPreviewWidth] = useState<number | null>(null)

  const commitWidth = (next: number | null) => {
    const nextAlt = formatImageAlt(text, next)
    // An unchanged alt would still be a transaction: an undo step that does nothing.
    if (nextAlt !== alt) updateAttributes({ alt: nextAlt })
  }

  return (
    <NodeViewWrapper
      as="span"
      className="image-node-view inline-block align-middle"
      data-testid="image-node-view"
      // contentEditable=false — an atom; src/alt are edited as markdown text, not
      // as inline ProseMirror content.
      contentEditable={false}
      // Focus moving onto a control in here (the collapse toggle, "Load", the
      // resize handle) blurs the contenteditable; the tag keeps `useEditorBlur`
      // from flushing the block and unmounting this node view.
      data-editor-portal=""
    >
      <CollapsibleImage
        src={src}
        alt={text}
        width={previewWidth ?? width}
        // `block` drops the inline baseline gap, so the handle sits on the corner.
        imgClassName="image-rendered block max-w-full"
        resizeHandle={
          <ImageResizeHandle
            label={t('editor.image.resize', { name: imageLabel(text, src) })}
            onPreview={setPreviewWidth}
            onCommit={commitWidth}
          />
        }
      />
    </NodeViewWrapper>
  )
}
