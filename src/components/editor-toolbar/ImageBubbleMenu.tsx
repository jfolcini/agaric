/**
 * ImageBubbleMenu — the actions on a selected inline image, in block and page mode (#5691).
 *
 * Shown while an `image` node is selected (a click on it, or an arrow onto it); TipTap
 * places it against the node's DOM. Every change is a transaction on the editor, so it
 * is saved the way each mode saves any edit: block mode's roving editor, page mode's
 * per-block save.
 *
 * - Alt text is edited in a popover marked `data-editor-portal`, so block mode keeps
 *   the block in edit while it has focus. The `|width` suffix the resize handle
 *   writes is kept (`formatImageAlt`).
 * - Open shows the image full screen in the lightbox, as a click on an image
 *   attachment does, with the same words. A web image the external-image policy
 *   withholds (#1492) has no Open: opening it would load it past the policy.
 * - Remove deletes the node.
 *
 * Edit as Markdown has no counterpart: there the image is its `![alt|width](src)`
 * text, which is what the alt edit writes (`formatImageAlt`).
 */

import type { NodeSelection, Selection } from '@tiptap/pm/state'
import type { Editor } from '@tiptap/react'
import { useEditorState } from '@tiptap/react'
import { BubbleMenu } from '@tiptap/react/menus'
import { Maximize2, Pencil, Trash2 } from 'lucide-react'
import type React from 'react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { toolbarPressHandlers } from '@/components/FormattingToolbar/shared'
import { bubbleMenuClass } from '@/components/FormattingToolbar/toolbar-config'
import { imageLabel } from '@/components/rendering/CollapsibleImage'
import { ImageLightbox } from '@/components/rendering/ImageLightbox'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/ui/icon-button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { useExternalImageAllowlist, useExternalImagePolicy } from '@/hooks/useExternalImagePolicy'
import { parseAttachmentRef } from '@/lib/attachment-ref'
import { shouldLoadExternalImage } from '@/lib/external-image-policy'
import { formatImageAlt, parseImageAlt } from '@/lib/image-alt-size'
import { readAttachment } from '@/lib/ipc-helpers'
import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'

export interface SelectedImage {
  pos: number
  src: string
  alt: string
}

/** The image the selection holds as a node. Duck-typed: `instanceof` fails across ProseMirror copies. */
export function selectedImage(selection: Selection): SelectedImage | null {
  const node = (selection as Partial<NodeSelection>).node
  if (node?.type.name !== 'image') return null
  return {
    pos: selection.from,
    src: (node.attrs['src'] as string | undefined) ?? '',
    alt: (node.attrs['alt'] as string | undefined) ?? '',
  }
}

/** Sets the selected image's alt text, keeping its width, and keeps the image selected. */
export function setImageAlt(editor: Editor, text: string): boolean {
  const image = selectedImage(editor.state.selection)
  if (image === null) return false
  const alt = formatImageAlt(text.trim(), parseImageAlt(image.alt).width)
  // An unchanged alt would still be a transaction: an undo step that does nothing.
  if (alt === image.alt) return true
  return editor.chain().updateAttributes('image', { alt }).setNodeSelection(image.pos).run()
}

const showForImage = ({ editor, state }: { editor: Editor; state: { selection: Selection } }) =>
  editor.isEditable && selectedImage(state.selection) !== null

interface Lightbox {
  src: string
  alt: string
  /** An object URL made for this view, revoked when it closes. */
  objectUrl: string | null
}

export function ImageBubbleMenu({ editor }: { editor: Editor }): React.ReactElement {
  const { t } = useTranslation()
  const image = useEditorState({
    editor,
    selector: (ctx) => (ctx.editor ? selectedImage(ctx.editor.state.selection) : null),
  })
  const [editingPos, setEditingPos] = useState<number | null>(null)
  const [draft, setDraft] = useState('')
  const [lightbox, setLightbox] = useState<Lightbox | null>(null)
  const editing = image !== null && editingPos === image.pos
  // The popover is placed against the image: the bubble hides while the form has focus.
  const imageAnchor = useMemo(
    () => ({
      current: {
        getBoundingClientRect: () => {
          const found = editor.isDestroyed ? null : selectedImage(editor.state.selection)
          const dom = found === null ? null : editor.view.nodeDOM(found.pos)
          return dom instanceof HTMLElement ? dom.getBoundingClientRect() : new DOMRect()
        },
      },
    }),
    [editor],
  )

  const openLabel = (target: SelectedImage) =>
    t('attachment.openImageFullscreen', {
      filename: imageLabel(parseImageAlt(target.alt).text, target.src),
    })
  const { policy } = useExternalImagePolicy()
  const { allowlist } = useExternalImageAllowlist()

  const open = (target: SelectedImage) => {
    const alt = parseImageAlt(target.alt).text
    const id = parseAttachmentRef(target.src)
    if (id === null) {
      setLightbox({ src: target.src, alt, objectUrl: null })
      return
    }
    readAttachment(id)
      .then((bytes) => {
        const objectUrl = URL.createObjectURL(new Blob([bytes.slice()]))
        setLightbox({ src: objectUrl, alt, objectUrl })
      })
      .catch((err: unknown) => {
        logger.warn('ImageBubbleMenu', 'could not read the image', { src: target.src }, err)
        notify.error(t('lightbox.loadError'))
      })
  }

  // TipTap's `focus()` waits a frame: past the dialog's own focus trap and its return.
  const closeLightbox = () => {
    if (lightbox?.objectUrl) URL.revokeObjectURL(lightbox.objectUrl)
    setLightbox(null)
    editor.commands.focus()
  }

  const stopEditing = () => {
    setEditingPos(null)
    editor.commands.focus()
  }

  return (
    <>
      <BubbleMenu
        editor={editor}
        shouldShow={showForImage}
        options={{ placement: 'bottom', offset: 8 }}
        role="toolbar"
        aria-label={t('editor.image.actions')}
        className={bubbleMenuClass}
        data-testid="image-bubble-menu"
      >
        {image !== null && (
          <>
            {/* The form is portalled: the bubble sits beside the editor's DOM, under block
                mode's key handler (`useBlockKeyboard`), which would take its Enter. */}
            <Popover
              open={editing}
              onOpenChange={(next) => {
                if (!next) stopEditing()
              }}
            >
              <PopoverAnchor virtualRef={imageAnchor} />
              <IconButton
                variant="ghost"
                size="icon-xs"
                tooltip={t('editor.image.editAlt')}
                ariaLabel={t('editor.image.editAlt')}
                aria-expanded={editing}
                {...toolbarPressHandlers(() => {
                  setDraft(parseImageAlt(image.alt).text)
                  setEditingPos(image.pos)
                })}
              >
                <Pencil />
              </IconButton>
              <PopoverContent
                align="start"
                className="w-72 max-w-[calc(100vw-2rem)] p-2"
                aria-label={t('editor.image.editAlt')}
                data-editor-portal
                onCloseAutoFocus={(e) => e.preventDefault()}
              >
                <form
                  className="flex items-center gap-1"
                  onSubmit={(e) => {
                    e.preventDefault()
                    stopEditing()
                    setImageAlt(editor, draft)
                  }}
                >
                  <Input
                    // oxlint-disable-next-line jsx-a11y/no-autofocus -- the form opens on the user's press of Edit alt text, so typing goes straight into it
                    autoFocus
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    aria-label={t('editor.image.altText')}
                    className="h-8"
                  />
                  <Button type="submit" variant="ghost" size="sm">
                    {t('action.save')}
                  </Button>
                </form>
              </PopoverContent>
            </Popover>
            {shouldLoadExternalImage(image.src, policy, allowlist) && (
              <IconButton
                variant="ghost"
                size="icon-xs"
                tooltip={openLabel(image)}
                ariaLabel={openLabel(image)}
                {...toolbarPressHandlers(() => open(image))}
              >
                <Maximize2 />
              </IconButton>
            )}
            <IconButton
              variant="ghost"
              size="icon-xs"
              tooltip={t('editor.image.remove')}
              ariaLabel={t('editor.image.remove')}
              {...toolbarPressHandlers(() => editor.chain().focus().deleteSelection().run())}
            >
              <Trash2 />
            </IconButton>
          </>
        )}
      </BubbleMenu>
      {lightbox !== null && (
        <ImageLightbox
          images={[{ src: lightbox.src, alt: lightbox.alt }]}
          index={0}
          onIndexChange={() => {}}
          open
          onOpenChange={(next) => {
            if (!next) closeLightbox()
          }}
        />
      )}
    </>
  )
}
