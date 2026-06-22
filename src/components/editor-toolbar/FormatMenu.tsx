/**
 * FormatMenu — the content of the always-visible toolbar's "Format" popover
 * (#1958).
 *
 * Hosts the same inline mark toggles as `SelectionBubbleMenu` (Bold, Italic,
 * Code, Strike, Highlight, Underline), but reachable WITHOUT a selection: the
 * bubble menu only appears over a non-empty text selection (and is suppressed
 * entirely on touch), so there was previously no way to pre-set a mark at the
 * caret or to format at all on mobile. Each toggle runs through
 * `editor.chain().focus().toggle…()`, which sets a stored mark at an empty
 * cursor (applied to the next typed text) or toggles the mark across an active
 * selection — the standard TipTap behaviour.
 *
 * Clicks use `onPointerDown + preventDefault` so focus returns to the editor
 * and the popover stays open, letting the user stack several marks
 * (bold + italic) in one visit. Active marks get `aria-pressed` + the shared
 * active class, mirroring the bubble menu.
 */

import type { Editor } from '@tiptap/react'
import { useEditorState } from '@tiptap/react'
import type React from 'react'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { getShortcutKeys } from '@/lib/keyboard-config'
import { createMarkToggles, toolbarActiveClass } from '@/lib/toolbar-config'
import { cn } from '@/lib/utils'

/** Mirror SelectionBubbleMenu/shared: rebindable chords surfaced in tooltips. */
const FORMAT_MENU_SHORTCUT_IDS: Record<string, string> = {
  'toolbar.code': 'inlineCode',
  'toolbar.strikethrough': 'strikethrough',
  'toolbar.highlight': 'highlight',
}

function tooltipFor(label: string, shortcutId: string | undefined): string {
  if (!shortcutId) return label
  const keys = getShortcutKeys(shortcutId)
  return keys ? `${label} (${keys})` : label
}

interface FormatMenuProps {
  editor: Editor
}

export function FormatMenu({ editor }: FormatMenuProps): React.ReactElement {
  const { t } = useTranslation()
  const markToggles = useMemo(() => createMarkToggles(editor), [editor])
  const state = useEditorState({
    editor,
    selector: (ctx) => ({
      bold: ctx.editor.isActive('bold'),
      italic: ctx.editor.isActive('italic'),
      code: ctx.editor.isActive('code'),
      strike: ctx.editor.isActive('strike'),
      underline: ctx.editor.isActive('underline'),
      highlight: ctx.editor.isActive('highlight'),
    }),
  })

  return (
    <div role="toolbar" aria-label={t('toolbar.format')} className="flex items-center gap-0.5">
      {markToggles.map((btn) => {
        const tooltip = tooltipFor(t(btn.label), FORMAT_MENU_SHORTCUT_IDS[btn.label])
        const active = btn.activeKey ? (state[btn.activeKey as keyof typeof state] ?? false) : false
        return (
          <Tooltip key={btn.label} delayDuration={200}>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={t(btn.label)}
                aria-pressed={active}
                className={cn(active && toolbarActiveClass)}
                onPointerDown={(e) => {
                  e.preventDefault()
                  btn.action()
                }}
              >
                <btn.icon className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>
              {tooltip}
            </TooltipContent>
          </Tooltip>
        )
      })}
    </div>
  )
}
