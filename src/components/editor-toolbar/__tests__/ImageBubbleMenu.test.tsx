/**
 * The image bubble (#5691) on a real editor and TipTap's real BubbleMenu: it shows
 * for a selected image only, edits the alt text keeping the `|width` suffix, opens
 * the image in the lightbox unless the external-image policy withholds it, and
 * removes the image. The save paths that carry these edits are covered per mode in
 * `e2e/page-mode-bubbles.spec.ts`.
 */

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Editor } from '@tiptap/core'
import Document from '@tiptap/extension-document'
import Paragraph from '@tiptap/extension-paragraph'
import Text from '@tiptap/extension-text'
import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest'

import { axe } from '@/__tests__/helpers/axe'
import { ImageBubbleMenu } from '@/components/editor-toolbar/ImageBubbleMenu'
import { Image } from '@/editor/extensions/image'
import { t } from '@/lib/i18n'

const mockReadAttachment = vi.fn()
vi.mock('@/lib/ipc-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ipc-helpers')>()),
  readAttachment: (...args: unknown[]) => mockReadAttachment(...args),
}))

/** The image without its React node view, which needs `EditorContent`. */
const PlainImage = Image.extend({ addNodeView: null })

let editor: Editor
let host: HTMLElement
let createObjectURL: MockInstance<typeof URL.createObjectURL>

beforeEach(() => {
  createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:image')
})

afterEach(() => {
  editor.destroy()
  createObjectURL.mockRestore()
  mockReadAttachment.mockReset()
  host.remove()
})

/** An editor holding `pic <image> done`, with the image selected. */
function setup(src: string, alt: string) {
  host = document.createElement('div')
  document.body.append(host)
  editor = new Editor({
    element: host,
    extensions: [Document, Paragraph, Text, PlainImage],
    content: {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'pic ' },
            { type: 'image', attrs: { src, alt } },
            { type: 'text', text: ' done' },
          ],
        },
      ],
    },
  })
  const result = render(<ImageBubbleMenu editor={editor} />)
  act(() => {
    editor.commands.setNodeSelection(5)
  })
  return result
}

const bubble = () => screen.findByRole('toolbar', { name: t('editor.image.actions') })
const press = (name: string) =>
  act(() => {
    fireEvent.pointerDown(screen.getByRole('button', { name }), { button: 0 })
  })
const imageAttrs = () => {
  let attrs: Record<string, unknown> | null = null
  editor.state.doc.descendants((node) => {
    if (node.type.name === 'image') attrs = node.attrs
  })
  return attrs
}

describe('ImageBubbleMenu', () => {
  it('shows for a selected image and hides for a caret in the text', async () => {
    setup('/cat.png', 'a cat')
    expect(await bubble()).toBeInTheDocument()

    act(() => {
      editor.commands.setTextSelection(2)
    })
    await waitFor(() =>
      expect(screen.queryByRole('toolbar', { name: t('editor.image.actions') })).toBeNull(),
    )
  })

  it('has no a11y violations', async () => {
    setup('/cat.png', 'a cat')
    expect(await axe(await bubble())).toHaveNoViolations()
  })

  it('edits the alt text and keeps the width', async () => {
    setup('/cat.png', 'a cat|120')
    await bubble()
    press(t('editor.image.editAlt'))
    const input = await screen.findByRole('textbox', { name: t('editor.image.altText') })
    expect(input).toHaveValue('a cat')

    fireEvent.change(input, { target: { value: 'a lion' } })
    fireEvent.submit(input.closest('form') as HTMLFormElement)

    expect(imageAttrs()).toEqual({ src: '/cat.png', alt: 'a lion|120' })
    // Still selected, so the bubble stays on the image.
    expect(editor.state.selection.from).toBe(5)
    await waitFor(() =>
      expect(screen.queryByRole('textbox', { name: t('editor.image.altText') })).toBeNull(),
    )
  })

  it('removes the image', async () => {
    setup('/cat.png', 'a cat')
    await bubble()
    press(t('editor.image.remove'))
    expect(imageAttrs()).toBeNull()
    expect(editor.state.doc.textContent).toBe('pic  done')
  })

  it("opens an attachment's bytes in the lightbox, worded as an attachment's", async () => {
    mockReadAttachment.mockResolvedValue(new Uint8Array([1, 2, 3]))
    setup('attachment:ATT1', 'a cat|120')
    await bubble()
    press(t('attachment.openImageFullscreen', { filename: 'a cat' }))

    const dialog = await screen.findByRole('dialog')
    expect(mockReadAttachment).toHaveBeenCalledWith('ATT1')
    expect(dialog.querySelector('img')).toHaveAttribute('src', 'blob:image')
  })

  it('opens a local image as it is', async () => {
    setup('/cat.png', 'a cat')
    await bubble()
    press(t('attachment.openImageFullscreen', { filename: 'a cat' }))

    const dialog = await screen.findByRole('dialog')
    expect(dialog.querySelector('img')).toHaveAttribute('src', '/cat.png')
    expect(mockReadAttachment).not.toHaveBeenCalled()
  })

  it('says so when the attachment cannot be read', async () => {
    mockReadAttachment.mockRejectedValue(new Error('gone'))
    setup('attachment:ATT1', 'a cat')
    await bubble()
    press(t('attachment.openImageFullscreen', { filename: 'a cat' }))

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(t('lightbox.loadError')))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('has no Open for a web image the external-image policy withholds', async () => {
    setup('https://example.com/cat.png', 'a cat')
    await bubble()
    expect(screen.getByRole('button', { name: t('editor.image.editAlt') })).toBeInTheDocument()
    expect(
      screen.queryByRole('button', {
        name: t('attachment.openImageFullscreen', { filename: 'a cat' }),
      }),
    ).toBeNull()
  })
})
