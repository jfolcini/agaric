/**
 * SelectionBubbleMenu — TipTap BubbleMenu rendered above non-empty selections.
 *
 * Hosts the 5 mark toggles (Bold, Italic, Code, Strike, Highlight) plus the
 * External Link button + popover. Visibility predicate: shows only when the
 * editor selection is a non-empty TEXT selection (via TipTap's `shouldShow`);
 * it stays hidden over a NodeSelection (chips / image atoms) where the mark
 * toggles would be meaningless (#924).
 *
 * Hoisted out of FormattingToolbar (PEND-33 Layer A) — every action in this
 * group requires a selection to be meaningful, so a contextual hover bar is
 * the right surface and frees the always-visible toolbar from these 6 buttons.
 *
 * Click handlers use `onPointerDown + preventDefault` so focus never leaves
 * the editor; active marks get `aria-pressed="true"` + `bg-accent`.
 */

import { getMarkRange, posToDOMRect } from '@tiptap/core'
import type { Editor } from '@tiptap/react'
import { useEditorState } from '@tiptap/react'
import { BubbleMenu } from '@tiptap/react/menus'
import { Link2 } from 'lucide-react'
import type React from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { LinkEditPopover } from '@/components/editor-toolbar/LinkEditPopover'
import { Button } from '@/components/ui/button'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { Separator } from '@/components/ui/separator'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useIsTouch } from '@/hooks/useIsTouch'
import { useRovingTabindex } from '@/hooks/useRovingTabindex'
import { getShortcutKeys, toAriaKeyshortcuts } from '@/lib/keyboard-config'
import { createMarkToggles, toolbarActiveClass } from '@/lib/toolbar-config'
import { cn } from '@/lib/utils'

interface SelectionBubbleMenuProps {
  editor: Editor
  /** Block ID used to associate the bubble toolbar with its editor via aria-controls. */
  blockId?: string
}

/** Resolve the link mark range around the cursor, or undefined if not inside a link. */
function getLinkMarkRange(editor: Editor): { from: number; to: number } | undefined {
  try {
    const $from = editor.state.doc.resolve(editor.state.selection.from)
    const linkMark = editor.schema.marks['link']
    if (linkMark) return getMarkRange($from, linkMark) ?? undefined
  } catch {
    // Cursor at document boundary
  }
  return undefined
}

/**
 * Append the current keyboard binding for `shortcutId` to `label` so the
 * tooltip stays in sync with user customisations (UX-301). Returns the
 * plain label when the id is unknown so we never render an empty `()`.
 */
function tooltipWithShortcut(label: string, shortcutId: string): string {
  const keys = getShortcutKeys(shortcutId)
  return keys ? `${label} (${keys})` : label
}

/**
 * Map of bubble-menu button label keys to keyboard-config shortcut ids.
 * Bold and italic intentionally have no entry — they use TipTap's
 * StarterKit defaults; their pre-existing tip strings already encode the
 * shortcut.
 */
const BUBBLE_MENU_SHORTCUT_IDS: Record<string, string> = {
  'toolbar.code': 'inlineCode',
  'toolbar.strikethrough': 'strikethrough',
  'toolbar.highlight': 'highlight',
}

/**
 * #216 C2 — canonical `aria-keyshortcuts` per mark button so AT announces the
 * binding (tooltips never fire on touch). Bold/Italic use TipTap StarterKit
 * built-ins (not in the configurable catalog), so their bindings are fixed
 * here; the rest derive from the live (user-customisable) keyboard config.
 */
function ariaKeyshortcutsFor(label: string): string | undefined {
  if (label === 'toolbar.bold') return 'Control+B'
  if (label === 'toolbar.italic') return 'Control+I'
  const id = BUBBLE_MENU_SHORTCUT_IDS[label]
  if (!id) return undefined
  return toAriaKeyshortcuts(getShortcutKeys(id)) || undefined
}

const Tip = ({
  ref,
  label,
  children,
}: {
  label: string
  children: React.ReactElement
  ref?: React.Ref<HTMLButtonElement>
}) => (
  // #1094: this surface deliberately uses a 200ms hover delay (snappier than
  // the 300ms app baseline) — the bubble menu sits right under a fresh text
  // selection, so its action tips should appear fast. The override lives on
  // the Tooltip itself now that the per-surface TooltipProvider is gone; it no
  // longer silently inherits the app-level default.
  <Tooltip delayDuration={200}>
    <TooltipTrigger asChild ref={ref}>
      {children}
    </TooltipTrigger>
    <TooltipContent side="bottom" sideOffset={6}>
      {label}
    </TooltipContent>
  </Tooltip>
)
Tip.displayName = 'Tip'

export function SelectionBubbleMenu({
  editor,
  blockId,
}: SelectionBubbleMenuProps): React.ReactElement {
  const { t } = useTranslation()
  // #925 f4 — on coarse-pointer (touch) devices the floating bubble fights the
  // OS's native text-selection UI (Android/iOS selection handles + context
  // menu), which overlaps it and steals the taps. Suppress the bubble entirely
  // there and let the always-visible FormattingToolbar own mobile formatting.
  // Desktop (fine pointer) behaviour is unchanged.
  const isTouch = useIsTouch()
  const [linkPopoverOpen, setLinkPopoverOpen] = useState(false)
  const [savedSelection, setSavedSelection] = useState<{ from: number; to: number } | null>(null)
  // Snapshot of the existing link captured when the popover opens via Ctrl+K
  // on a link. `state.link` (from useEditorState) can lag or read false at
  // popover-render time when the cursor sits at a link-mark boundary or when
  // Radix's focus management transiently disturbs the editor selection. The
  // snapshot is the source of truth for edit-mode rendering until the
  // popover closes.
  const [editingLinkSnapshot, setEditingLinkSnapshot] = useState<{
    url: string
    label: string
  } | null>(null)

  // Anchor the link popover to the editor's selection rect rather than to the
  // bubble-menu button. The button lives inside the BubbleMenu plugin's
  // detached `menuEl` until the plugin's debounced `show()` runs, so anchoring
  // there parks the popover at a viewport corner when Ctrl+K fires before the
  // bubble menu is laid out (or with no selection at all).
  const virtualAnchorRef = useRef<{ getBoundingClientRect: () => DOMRect }>({
    getBoundingClientRect: () => new DOMRect(),
  })
  virtualAnchorRef.current = {
    getBoundingClientRect: () => {
      const range = savedSelection ?? {
        from: editor.state.selection.from,
        to: editor.state.selection.to,
      }
      if (range.from !== range.to) {
        return posToDOMRect(editor.view, range.from, range.to)
      }
      const coords = editor.view.coordsAtPos(range.from)
      return new DOMRect(coords.left, coords.top, 0, coords.bottom - coords.top)
    },
  }

  const state = useEditorState({
    editor,
    selector: (ctx) => ({
      bold: ctx.editor.isActive('bold'),
      italic: ctx.editor.isActive('italic'),
      code: ctx.editor.isActive('code'),
      strike: ctx.editor.isActive('strike'),
      underline: ctx.editor.isActive('underline'),
      highlight: ctx.editor.isActive('highlight'),
      link: ctx.editor.isActive('link'),
    }),
  })

  // Listen for Ctrl+K custom event dispatched by the ExternalLink extension.
  // The bubble menu owns this handler now (moved from FormattingToolbar in
  // PEND-33 Layer A) — Ctrl+K still opens the popover even when the bubble
  // menu itself is not visible (i.e. when the selection is empty), because
  // the extension dispatches the event on the editor's DOM directly.
  useEffect(() => {
    const dom = editor.view?.dom
    if (!dom) return

    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ from: number; to: number }>).detail

      // Probe for a link mark via getMarkRange — works even when the cursor
      // is at a mark boundary (where editor.isActive('link') can be false).
      const range = getLinkMarkRange(editor)
      if (range) {
        const url = (editor.getAttributes('link')['href'] as string) ?? ''
        let label = ''
        try {
          label = editor.state.doc.textBetween(range.from, range.to)
        } catch {
          // Stale range
        }
        setEditingLinkSnapshot({ url, label })
        setSavedSelection(range)
        setLinkPopoverOpen(true)
        return
      }

      setEditingLinkSnapshot(null)
      if (detail && detail.from !== detail.to) {
        setSavedSelection(detail)
      } else {
        setSavedSelection(null)
      }
      setLinkPopoverOpen(true)
    }
    dom.addEventListener('open-link-popover', handler)
    return () => dom.removeEventListener('open-link-popover', handler)
  }, [editor])

  // Edit-mode rendering uses state.link (reactive, picks up live changes) OR
  // the snapshot captured when the popover was opened on an existing link.
  const isEditingLink = state.link || editingLinkSnapshot !== null
  const currentUrl = state.link
    ? ((editor.getAttributes('link')['href'] as string) ?? '')
    : (editingLinkSnapshot?.url ?? '')

  let currentLabel = ''
  if (state.link) {
    const range = getLinkMarkRange(editor)
    if (range) {
      try {
        currentLabel = editor.state.doc.textBetween(range.from, range.to)
      } catch {
        // Document boundary
      }
    }
  } else if (editingLinkSnapshot) {
    currentLabel = editingLinkSnapshot.label
  } else if (savedSelection && savedSelection.from !== savedSelection.to) {
    try {
      currentLabel = editor.state.doc.textBetween(savedSelection.from, savedSelection.to)
    } catch {
      // Stale selection range
    }
  }

  const handleLinkPopoverClose = useCallback(() => {
    setSavedSelection(null)
    setEditingLinkSnapshot(null)
    setLinkPopoverOpen(false)
  }, [])

  const markToggles = useMemo(() => createMarkToggles(editor), [editor])

  // WAI-ARIA toolbar roving-tabindex model (#1724): one tab stop, Arrow/Home/End
  // move focus between the mark/link buttons. BubbleMenu forwards ref + DOM
  // handlers to its container div.
  const roving = useRovingTabindex()

  return (
    <BubbleMenu
      tabIndex={-1}
      ref={roving.containerRef}
      onKeyDown={roving.onKeyDown}
      onFocus={roving.onFocus}
      editor={editor}
      shouldShow={({ state: editorState }) =>
        // #925 f4 — never float the bubble on touch; it collides with the OS
        // selection handles. Mobile formatting goes through FormattingToolbar.
        !isTouch &&
        // #924 — show over a non-empty selection, EXCEPT a NodeSelection (a
        // selected block-link/block-ref chip or image atom), where the mark
        // toggles (Bold/Italic/…) are meaningless. Duck-type on the NodeSelection
        // `node` property instead of `instanceof TextSelection`: ProseMirror's
        // `@tiptap/pm/state` can resolve to a different module copy than the one
        // the running editor uses, so `instanceof` is unreliable across the
        // bundle (it silently hid the bubble for ALL text selections).
        !editorState.selection.empty &&
        !('node' in editorState.selection && editorState.selection.node)
      }
      role="toolbar"
      aria-label={t('toolbar.selectionFormatting')}
      aria-controls={blockId ? `editor-${blockId}` : undefined}
      className="selection-bubble-menu flex items-center gap-0.5 rounded-md border border-border bg-popover px-1 py-0.5 shadow-md animate-in fade-in-0 zoom-in-95 duration-fast ease-smooth"
      data-testid="selection-bubble-menu"
    >
      {markToggles.map((btn) => {
        const shortcutId = BUBBLE_MENU_SHORTCUT_IDS[btn.label]
        const tooltip = shortcutId ? tooltipWithShortcut(t(btn.label), shortcutId) : t(btn.tip)
        const active = btn.activeKey
          ? (state[btn.activeKey as keyof typeof state] as boolean)
          : false
        return (
          <Tip key={btn.label} label={tooltip}>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={t(btn.label)}
              aria-pressed={active}
              aria-keyshortcuts={ariaKeyshortcutsFor(btn.label)}
              className={cn(active && toolbarActiveClass)}
              onPointerDown={(e) => {
                e.preventDefault()
                btn.action()
              }}
            >
              <btn.icon className="h-3.5 w-3.5" />
            </Button>
          </Tip>
        )
      })}

      <Separator orientation="vertical" className="border-l border-border/40 mx-0.5 h-4" />

      <Tip label={tooltipWithShortcut(t('toolbar.link'), 'linkPopover')}>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={t('toolbar.link')}
          aria-pressed={state.link}
          className={cn(state.link && toolbarActiveClass)}
          onPointerDown={(e) => {
            e.preventDefault()
            if (!linkPopoverOpen) {
              if (state.link) {
                const range = getLinkMarkRange(editor)
                if (range) setSavedSelection(range)
              } else if (!editor.state.selection.empty) {
                setSavedSelection({
                  from: editor.state.selection.from,
                  to: editor.state.selection.to,
                })
              }
            }
            setLinkPopoverOpen((prev) => !prev)
          }}
        >
          <Link2 className="h-3.5 w-3.5" />
        </Button>
      </Tip>
      <Popover open={linkPopoverOpen} onOpenChange={setLinkPopoverOpen}>
        <PopoverAnchor virtualRef={virtualAnchorRef} />
        <PopoverContent
          align="start"
          className="w-72 max-w-[calc(100vw-2rem)] p-3"
          data-editor-portal
        >
          <LinkEditPopover
            editor={editor}
            isEditing={isEditingLink}
            initialUrl={currentUrl}
            initialLabel={currentLabel}
            onClose={handleLinkPopoverClose}
            savedSelection={savedSelection}
          />
        </PopoverContent>
      </Popover>
    </BubbleMenu>
  )
}
