/**
 * SelectionBubbleMenu — TipTap BubbleMenu rendered above non-empty selections.
 *
 * Hosts the 5 mark toggles (Bold, Italic, Code, Strike, Highlight) plus the
 * External Link button + popover. Visibility predicate: shows only when the
 * editor selection is a non-empty TEXT selection (via TipTap's `shouldShow`);
 * it stays hidden over a NodeSelection (chips / image atoms) where the mark
 * toggles would be meaningless (#924).
 *
 * Hoisted out of FormattingToolbar (Layer A) — every action in this
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
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { LinkEditPopover } from '@/components/editor-toolbar/LinkEditPopover'
import { Button } from '@/components/ui/button'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { Separator } from '@/components/ui/separator'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useIsTouch } from '@/hooks/useIsTouch'
import { useRovingTabindex } from '@/hooks/useRovingTabindex'
import { getShortcutKeys, toAriaKeyshortcuts } from '@/lib/keyboard-config'
import {
  createMarkToggles,
  MARK_TOGGLE_SHORTCUT_IDS,
  toolbarActiveClass,
  withShortcutHint,
} from '@/lib/toolbar-config'
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
 * #216 C2 — canonical `aria-keyshortcuts` per mark button so AT announces the
 * binding (tooltips never fire on touch). Bold/Italic use TipTap StarterKit
 * built-ins (not in the configurable catalog), so their bindings are fixed
 * here; the rest derive from the live (user-customisable) keyboard config.
 */
function ariaKeyshortcutsFor(label: string): string | undefined {
  if (label === 'toolbar.bold') return 'Control+B'
  if (label === 'toolbar.italic') return 'Control+I'
  const id = MARK_TOGGLE_SHORTCUT_IDS[label]
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
  // #4469 — LOAD-BEARING: opt this component out of React Compiler
  // memoisation. Until #4465 the `useRovingTabindex()` result was read via
  // member access (`roving.containerRef`), which is a `react/refs` violation
  // — and `react/refs` ports the React Compiler's own validation, so the
  // compiler refused to compile this function at all (three `CompileError`s,
  // text identical to oxlint's: "Cannot access refs during render").
  // Destructuring the hook (below) is the documented usage and is what the
  // rule asks for, and it also removes the compiler's reason to bail — so the
  // component starts being memoised.
  //
  // With the directive deleted the compiler emits `const $ = _c(75)` and
  // caches the returned `<BubbleMenu>` element behind a guard whose inputs
  // reduce to `containerRef`, the two roving `useCallback`s, `editor`,
  // `blockId`, the i18n `t`, `isTouch`, `linkPopoverOpen`, `savedSelection`,
  // and the `useEditorState` snapshot (plus the link strings derived from
  // it). `editor` is the trap: a TipTap `Editor` is a stable object reference
  // whose state mutates INTERNALLY, so identity comparison can never see an
  // edit. Typing plain text inside a code block moves nothing else in that
  // set either — the snapshot is compared by value and none of its eight
  // mark-active flags flips — so the cached element is returned unchanged,
  // React skips reconciling the subtree, and the typed source never reaches a
  // mermaid block, which sits on "Empty diagram" until the mobile e2e times
  // out at 15s. The compiler bailing out was a protection nobody knew was
  // there.
  //
  // Do not remove this directive without re-running
  // `e2e/mobile-editor.spec.ts` — the compiler is disabled under Vitest
  // (`vite.config.ts`), so the unit suite structurally cannot see this. CI
  // shards the whole Playwright suite whenever `detect-changes` classifies
  // the PR as touching frontend (`.github/workflows/_validate.yml`,
  // `playwright` job gated on `frontend == 'true'`), not unconditionally —
  // but any edit capable of removing this directive is itself a `.tsx`
  // under `src/`, which the classifier always marks frontend, so the gate
  // is enforced on exactly the diffs that could break it.
  'use no memo'

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
  // Refreshed on every commit (no dep array). A LAYOUT effect, not a passive
  // one: Radix's `PopperAnchor` reads `virtualRef.current` from a passive
  // effect in a DESCENDANT, and descendant passive effects run before this
  // component's would, which would leave the anchor rect one commit stale.
  useLayoutEffect(() => {
    virtualAnchorRef.current = {
      getBoundingClientRect: () => {
        // #3061 — Radix calls this closure repeatedly (layout/scroll/resize)
        // for as long as the link popover stays open, not just once at click
        // time, so it can run after `editor` has gone null mid mount/teardown
        // race. Guard `editor?.view` before touching `.state`/`.view` below.
        if (!editor?.view) return new DOMRect()
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
  })

  const state = useEditorState({
    editor,
    // #3056 — `ctx.editor` can be momentarily null during mount/teardown even
    // though the `editor` prop is typed non-null. Guard before touching
    // `.isActive()`/`.can()` and fall back to inert defaults.
    selector: (ctx) => {
      if (!ctx.editor) {
        return {
          bold: false,
          italic: false,
          code: false,
          strike: false,
          canStrike: false,
          underline: false,
          highlight: false,
          link: false,
        }
      }
      return {
        bold: ctx.editor.isActive('bold'),
        italic: ctx.editor.isActive('italic'),
        code: ctx.editor.isActive('code'),
        strike: ctx.editor.isActive('strike'),
        // #2995 — strike is excluded from the mark set inside inline `code` /
        // `codeBlock`; `can()` reports false there so the button greys out
        // instead of rendering as a no-op toggle.
        canStrike: ctx.editor.can().toggleStrike(),
        underline: ctx.editor.isActive('underline'),
        highlight: ctx.editor.isActive('highlight'),
        link: ctx.editor.isActive('link'),
      }
    },
  })

  // Listen for Ctrl+K custom event dispatched by the ExternalLink extension.
  // The bubble menu owns this handler now (moved from FormattingToolbar in
  // Layer A) — Ctrl+K still opens the popover even when the bubble
  // menu itself is not visible (i.e. when the selection is empty), because
  // the extension dispatches the event on the editor's DOM directly.
  useEffect(() => {
    // #3061 — `editor` (typed non-null) can itself be transiently null during
    // the same mount/teardown race #3060 guarded in the `useEditorState`
    // selector above; `editor?.view?.dom` (rather than `editor.view?.dom`)
    // avoids dereferencing a null `editor` here too.
    const dom = editor?.view?.dom
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
  } else if (editor && savedSelection && savedSelection.from !== savedSelection.to) {
    // #3061 — `savedSelection` is independent React state, so it can still be
    // set on a re-render where `editor` has gone null; the try/catch already
    // covers stale ranges, but gate on `editor` too rather than relying on
    // the catch to swallow a TypeError with a different cause.
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
  //
  // Destructured per the hook's documented usage (#4398 / oxlint `react/refs`).
  // Safe here ONLY because of the `'use no memo'` directive at the top of this
  // component — see the note there and #4469.
  const { containerRef, onKeyDown: rovingOnKeyDown, onFocus: rovingOnFocus } = useRovingTabindex()

  return (
    <BubbleMenu
      tabIndex={-1}
      ref={containerRef}
      onKeyDown={rovingOnKeyDown}
      onFocus={rovingOnFocus}
      editor={editor}
      // #1958 — open the bubble BELOW the selection (end/last line) rather than
      // above it. The always-visible FormattingToolbar sits at the top edge of
      // `.block-editor`; an upward-opening bubble overlapped it. `flip` (on by
      // default) still lifts the bubble above the selection only when there is
      // no room below (near the viewport bottom).
      options={{ placement: 'bottom', offset: 8 }}
      shouldShow={({ state: editorState }) => {
        // #925 f4 — never float the bubble on touch over a LIVE selection;
        // dragging a selection collides with the OS's native selection
        // handles. Mobile mark-formatting goes through FormattingToolbar's
        // Format popover instead.
        //
        // #3276 f3 — but an EXISTING link's URL/label had NO touch-reachable
        // edit path at all: this bubble is the only place `LinkEditPopover`
        // mounts, and the blanket `!isTouch` above suppressed it
        // unconditionally. A caret simply resting inside a link (an empty
        // selection from a tap, not a drag) doesn't fight the OS handles the
        // way a live selection does, so let exactly that case through —
        // still never for a live touch selection.
        if (isTouch) {
          // #3056/#3061 — `editor` can be transiently null during the same
          // mount/teardown race guarded elsewhere in this file; treat that
          // as "not in a link" rather than throwing inside `shouldShow`.
          return editorState.selection.empty && (editor?.isActive('link') ?? false)
        }
        // #924 — show over a non-empty selection, EXCEPT a NodeSelection (a
        // selected block-link/block-ref chip or image atom), where the mark
        // toggles (Bold/Italic/…) are meaningless. Duck-type on the NodeSelection
        // `node` property instead of `instanceof TextSelection`: ProseMirror's
        // `@tiptap/pm/state` can resolve to a different module copy than the one
        // the running editor uses, so `instanceof` is unreliable across the
        // bundle (it silently hid the bubble for ALL text selections).
        return (
          !editorState.selection.empty &&
          !('node' in editorState.selection && editorState.selection.node)
        )
      }}
      role="toolbar"
      aria-label={t('toolbar.selectionFormatting')}
      aria-controls={blockId ? `editor-${blockId}` : undefined}
      // #1958 — `z-50` so the bubble paints above sibling blocks. Now that it
      // opens BELOW the selection it overlaps the following block, whose
      // `sortable-block` is a later sibling in the same `block-tree` (z-10)
      // stacking context and would otherwise paint on top — intercepting clicks
      // on the mark buttons. A z-index lifts the (position:absolute) bubble
      // above those z-auto siblings within that context.
      className="selection-bubble-menu z-50 flex items-center gap-0.5 rounded-md border border-border bg-popover px-1 py-0.5 shadow-(--shadow-floating) animate-in fade-in-0 zoom-in-95 duration-fast ease-smooth"
      data-testid="selection-bubble-menu"
    >
      {markToggles.map((btn) => {
        const shortcutId = MARK_TOGGLE_SHORTCUT_IDS[btn.label]
        const tooltip = shortcutId ? withShortcutHint(t(btn.label), shortcutId) : t(btn.tip)
        const active = btn.activeKey
          ? (state[btn.activeKey as keyof typeof state] as boolean)
          : false
        const disabled = btn.disabledWhenFalse
          ? !state[btn.disabledWhenFalse as keyof typeof state]
          : undefined
        return (
          <Tip key={btn.label} label={tooltip}>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={t(btn.label)}
              aria-pressed={active}
              aria-keyshortcuts={ariaKeyshortcutsFor(btn.label)}
              disabled={disabled}
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

      <Tip label={withShortcutHint(t('toolbar.link'), 'linkPopover')}>
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
