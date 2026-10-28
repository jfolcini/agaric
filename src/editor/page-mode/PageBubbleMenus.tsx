/**
 * Page mode's bubble menus (#5691): the actions on what the caret rests in, as
 * GitLab's editor shows them. Each needs an empty selection, so none stacks with
 * `SelectionBubbleMenu`, which needs a non-empty one; the image's bubble needs the
 * image selected as a node, which neither of those is.
 *
 * Each action is block mode's, with its words and icon:
 * - Link: the URL; External link (`LinkEditPopover`, as Ctrl+K opens it), Open link (the
 *   block menu's) and Remove (the popover's).
 * - Table: the toolbar's Table button and its unchanged `TableOpsSelector`.
 * - Code block: the toolbar's language picker (`CodeLanguageSelector`), and Copy, which
 *   is new.
 * - Image: `ImageBubbleMenu`, shared with block mode.
 * Edit as Markdown has none of them: there each is its Markdown text.
 *
 * Every action edits the document, so page mode's save carries it like any edit.
 */

import { findParentNode } from '@tiptap/core'
import type { Node as PMNode } from '@tiptap/pm/model'
import type { Selection } from '@tiptap/pm/state'
import type { Editor } from '@tiptap/react'
import { useEditorState } from '@tiptap/react'
import { BubbleMenu, type BubbleMenuProps } from '@tiptap/react/menus'
import { ChevronDown, Copy, ExternalLink, Link2, Table2, Unlink } from 'lucide-react'
import type React from 'react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { CodeLanguageSelector } from '@/components/editor-toolbar/CodeLanguageSelector'
import { ImageBubbleMenu } from '@/components/editor-toolbar/ImageBubbleMenu'
import { toolbarPressHandlers } from '@/components/FormattingToolbar/shared'
import { bubbleMenuClass, withShortcutHint } from '@/components/FormattingToolbar/toolbar-config'
import { TableOpsSelector } from '@/components/TableOpsSelector'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/ui/icon-button'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { Separator } from '@/components/ui/separator'
import { writeText } from '@/lib/clipboard'
import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'
import { openUrl } from '@/lib/open-url'
import { isAllowedUrl } from '@/lib/url-validation'

type VirtualElement = ReturnType<NonNullable<BubbleMenuProps['getReferencedVirtualElement']>>

/** The nearest `name` node around the selection, with its position. */
function around(selection: Selection, name: string): { pos: number; node: PMNode } | null {
  return findParentNode((node) => node.type.name === name)(selection) ?? null
}

/** The DOM of the `name` node around the caret, which a bubble or popover is placed against. */
function nodeDom(editor: Editor, name: string): HTMLElement | null {
  // A resize or scroll can place a bubble a moment after the editor is gone.
  if (editor.isDestroyed) return null
  const found = around(editor.state.selection, name)
  const dom = found === null ? null : editor.view.nodeDOM(found.pos)
  return dom instanceof HTMLElement ? dom : null
}

function nodeBox(editor: Editor, name: string): VirtualElement {
  const dom = nodeDom(editor, name)
  if (dom === null) return null
  return {
    getBoundingClientRect: () => dom.getBoundingClientRect(),
    getClientRects: () => [dom.getBoundingClientRect()],
  }
}

/**
 * Editors whose primary button is down: a bubble that appears under the press
 * ends the drag selection it started, so the bubbles wait for the release.
 */
const pressed = new WeakSet<Editor>()

const caretIn =
  (name: string) =>
  ({ editor, state }: { editor: Editor; state: { selection: Selection } }) =>
    !pressed.has(editor) && editor.isEditable && state.selection.empty && editor.isActive(name)

const showForLink = caretIn('link')
const showForTable = caretIn('table')
const showForCode = caretIn('codeBlock')

/** Each caret bubble's plugin key, which its `show` meta is addressed to. */
const CARET_BUBBLES = [
  ['pageLinkBubble', showForLink],
  ['pageTableBubble', showForTable],
  ['pageCodeBubble', showForCode],
] as const

/** Holds the bubbles back while the button is down in `editor`, and shows the caret's on release. */
function useShowOnRelease(editor: Editor): void {
  useEffect(() => {
    const down = (e: PointerEvent) => {
      if (e.button !== 0 || editor.isDestroyed) return
      if (editor.view.dom.contains(e.target as Node)) pressed.add(editor)
    }
    const up = () => {
      if (!pressed.delete(editor)) return
      // After ProseMirror's own mouseup has placed the caret. Not a selection change, so
      // TipTap would not look again: the bubble is told to show, then to place itself.
      setTimeout(() => {
        if (editor.isDestroyed) return
        const shown = CARET_BUBBLES.filter(([, show]) => show({ editor, state: editor.state }))
        if (shown.length === 0) return
        const tr = (meta: string) =>
          shown.reduce((t, [key]) => t.setMeta(key, meta), editor.state.tr)
        editor.view.dispatch(tr('show'))
        editor.view.dispatch(tr('updatePosition'))
      })
    }
    window.addEventListener('pointerdown', down, true)
    window.addEventListener('pointerup', up, true)
    window.addEventListener('pointercancel', up, true)
    return () => {
      window.removeEventListener('pointerdown', down, true)
      window.removeEventListener('pointerup', up, true)
      window.removeEventListener('pointercancel', up, true)
      pressed.delete(editor)
    }
  }, [editor])
}

function PageLinkBubble({ editor }: { editor: Editor }): React.ReactElement {
  const { t } = useTranslation()
  const href = useEditorState({
    editor,
    selector: (ctx) =>
      ctx.editor?.isActive('link')
        ? ((ctx.editor.getAttributes('link')['href'] as string | undefined) ?? '')
        : null,
  })

  const open = (url: string) => {
    // `openUrl` never rejects; false means nothing opened.
    void openUrl(url).then((opened) => {
      if (opened) return
      logger.warn('PageLinkBubble', 'could not open the link', { url })
      notify.error(t('contextMenu.actionFailed'))
    })
  }

  return (
    <BubbleMenu
      editor={editor}
      pluginKey="pageLinkBubble"
      shouldShow={showForLink}
      // Above the link: hovering it opens its preview below (`LinkPreviewTooltip`).
      options={{ placement: 'top', offset: 8 }}
      role="toolbar"
      aria-label={t('pageMode.linkActions')}
      className={bubbleMenuClass}
      data-testid="page-link-bubble"
    >
      {href !== null && (
        <>
          <span className="max-w-64 truncate px-1.5 text-xs text-muted-foreground" title={href}>
            {href}
          </span>
          <Separator orientation="vertical" className="mx-0.5 h-4" />
          <IconButton
            variant="ghost"
            size="icon-xs"
            tooltip={withShortcutHint(t('toolbar.link'), 'linkPopover')}
            ariaLabel={t('toolbar.link')}
            {...toolbarPressHandlers(() => {
              // Ctrl+K's event: `SelectionBubbleMenu` opens its link popover on it.
              const { from, to } = editor.state.selection
              editor.view.dom.dispatchEvent(
                new CustomEvent('open-link-popover', { bubbles: true, detail: { from, to } }),
              )
            })}
          >
            <Link2 />
          </IconButton>
          {isAllowedUrl(href) && (
            <IconButton
              variant="ghost"
              size="icon-xs"
              tooltip={t('contextMenu.openLink')}
              ariaLabel={t('contextMenu.openLink')}
              {...toolbarPressHandlers(() => open(href))}
            >
              <ExternalLink />
            </IconButton>
          )}
          <IconButton
            variant="ghost"
            size="icon-xs"
            tooltip={t('linkEdit.remove')}
            ariaLabel={t('linkEdit.remove')}
            // `unsetLink` takes the whole link around a caret.
            {...toolbarPressHandlers(() => editor.chain().focus().unsetLink().run())}
          >
            <Unlink />
          </IconButton>
        </>
      )}
    </BubbleMenu>
  )
}

/** The `name` node the caret rests in, when its bubble shows: the bubble's own test, read in render. */
function caretNode(editor: Editor | null, name: string): { pos: number; node: PMNode } | null {
  if (editor === null || !caretIn(name)({ editor, state: editor.state })) return null
  return around(editor.state.selection, name)
}

function PageTableBubble({ editor }: { editor: Editor }): React.ReactElement {
  const { t } = useTranslation()
  const tablePos = useEditorState({
    editor,
    selector: (ctx) => caretNode(ctx.editor, 'table')?.pos ?? null,
  })
  // The table it was opened on: the caret leaving it closes the popover with the bubble.
  const [openOn, setOpenOn] = useState<number | null>(null)
  const open = tablePos !== null && openOn === tablePos
  const anchor = useMemo(() => () => nodeBox(editor, 'table'), [editor])

  return (
    <BubbleMenu
      editor={editor}
      pluginKey="pageTableBubble"
      shouldShow={showForTable}
      getReferencedVirtualElement={anchor}
      options={{ placement: 'bottom-start', offset: 8 }}
      role="toolbar"
      aria-label={t('pageMode.tableActions')}
      className={bubbleMenuClass}
      data-testid="page-table-bubble"
    >
      <Popover open={open} onOpenChange={(next) => setOpenOn(next ? tablePos : null)}>
        <PopoverAnchor asChild>
          <Button
            variant="ghost"
            size="xs"
            aria-haspopup="menu"
            aria-expanded={open}
            {...toolbarPressHandlers(() => setOpenOn(open ? null : tablePos))}
          >
            <Table2 />
            {t('toolbar.tableOps')}
          </Button>
        </PopoverAnchor>
        <PopoverContent
          align="start"
          className="w-auto max-w-[calc(100vw-2rem)] p-1"
          data-editor-portal
          // The ops act on the caret's cell: focus stays in the text.
          onOpenAutoFocus={(e) => e.preventDefault()}
          onCloseAutoFocus={(e) => e.preventDefault()}
        >
          <TableOpsSelector editor={editor} onClose={() => setOpenOn(null)} />
        </PopoverContent>
      </Popover>
    </BubbleMenu>
  )
}

function PageCodeBubble({ editor }: { editor: Editor }): React.ReactElement {
  const { t } = useTranslation()
  const code = useEditorState({
    editor,
    selector: (ctx) => {
      const found = caretNode(ctx.editor, 'codeBlock')
      if (found === null) return null
      const language = found.node.attrs['language'] as string | null | undefined
      return { pos: found.pos, language: language ?? '' }
    },
  })
  const [openOn, setOpenOn] = useState<number | null>(null)
  const open = code !== null && openOn === code.pos
  const anchor = useMemo(() => () => nodeBox(editor, 'codeBlock'), [editor])
  // The picker's filter takes focus, which hides the bubble and takes its trigger
  // out of the page: the popover is placed against the code block instead.
  const popoverAnchor = useMemo(
    () => ({
      current: {
        getBoundingClientRect: () =>
          nodeDom(editor, 'codeBlock')?.getBoundingClientRect() ?? new DOMRect(),
      },
    }),
    [editor],
  )

  const copy = () => {
    const text = around(editor.state.selection, 'codeBlock')?.node.textContent ?? ''
    // Started inside the press: WebKit drops a clipboard write that follows an await.
    writeText(text)
      .then(() => notify.success(t('pageMode.codeCopied')))
      .catch((err: unknown) => {
        logger.warn('PageCodeBubble', 'copy failed', undefined, err)
        notify.error(t('pageMode.codeCopyFailed'))
      })
  }

  const close = () => {
    setOpenOn(null)
    editor.commands.focus()
  }

  return (
    <BubbleMenu
      editor={editor}
      pluginKey="pageCodeBubble"
      shouldShow={showForCode}
      getReferencedVirtualElement={anchor}
      options={{ placement: 'bottom-end', offset: 8 }}
      role="toolbar"
      aria-label={t('pageMode.codeActions')}
      className={bubbleMenuClass}
      data-testid="page-code-bubble"
    >
      {code !== null && (
        <>
          <Popover open={open} onOpenChange={(next) => setOpenOn(next ? code.pos : null)}>
            <PopoverAnchor virtualRef={popoverAnchor} />
            <Button
              variant="ghost"
              size="xs"
              aria-label={t('toolbar.codeBlockLanguage')}
              aria-haspopup="dialog"
              aria-expanded={open}
              {...toolbarPressHandlers(() => (open ? close() : setOpenOn(code.pos)))}
            >
              {code.language || t('toolbar.plainText')}
              <ChevronDown />
            </Button>
            <PopoverContent
              align="end"
              className="w-56 max-w-[calc(100vw-2rem)] p-1"
              aria-label={t('toolbar.codeBlockLanguage')}
              data-editor-portal
              onCloseAutoFocus={(e) => e.preventDefault()}
            >
              <CodeLanguageSelector
                editor={editor}
                isCodeBlock
                currentLanguage={code.language}
                onClose={close}
              />
            </PopoverContent>
          </Popover>
          <IconButton
            variant="ghost"
            size="icon-xs"
            tooltip={t('pageMode.codeCopy')}
            ariaLabel={t('pageMode.codeCopy')}
            {...toolbarPressHandlers(copy)}
          >
            <Copy />
          </IconButton>
        </>
      )}
    </BubbleMenu>
  )
}

/** Every page-mode bubble, mounted beside `SelectionBubbleMenu`. */
export function PageBubbleMenus({ editor }: { editor: Editor }): React.ReactElement {
  useShowOnRelease(editor)
  return (
    <>
      <PageLinkBubble editor={editor} />
      <PageTableBubble editor={editor} />
      <PageCodeBubble editor={editor} />
      <ImageBubbleMenu editor={editor} />
    </>
  )
}
