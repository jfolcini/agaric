/**
 * HighlightColorPicker — the highlight's colour swatches (#6759): the theme's
 * default and Obsidian's six. A press highlights the selection in that colour,
 * or recolours the highlight it is in. Hosted by the selection bubble's
 * *Highlight colour* popover and by the toolbar's Format popover.
 */

import type { Editor } from '@tiptap/react'
import { useEditorState } from '@tiptap/react'
import type React from 'react'
import { useTranslation } from 'react-i18next'

import { toolbarPressHandlers } from '@/components/FormattingToolbar/shared'
import { toolbarActiveClass } from '@/components/FormattingToolbar/toolbar-config'
import { Button } from '@/components/ui/button'
import { asHighlightColor, HIGHLIGHT_COLORS, type HighlightColor } from '@/lib/highlight-colors'
import { cn } from '@/lib/utils'

const SWATCHES: ReadonlyArray<{ color: HighlightColor | null; label: string; fill: string }> = [
  { color: null, label: 'toolbar.highlightDefault', fill: 'bg-highlight' },
  ...HIGHLIGHT_COLORS.map(({ id, fill }) => ({
    color: id,
    label: `toolbar.highlight.${id}`,
    fill,
  })),
]

export function HighlightColorPicker({
  editor,
  onPick,
}: {
  editor: Editor
  /** Runs after a swatch is pressed: a popover closes itself. */
  onPick?: (() => void) | undefined
}): React.ReactElement {
  const { t } = useTranslation()
  // `undefined`: the selection is not in a highlight, so no swatch is pressed.
  const current = useEditorState({
    editor,
    selector: (ctx): HighlightColor | null | undefined =>
      ctx.editor?.isActive('highlight')
        ? asHighlightColor(ctx.editor.getAttributes('highlight')['color'])
        : undefined,
  })

  return (
    <div
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- a labelled row of buttons; a fieldset would bring a form group's border and legend into a toolbar
      role="group"
      aria-label={t('toolbar.highlightColor')}
      className="flex items-center gap-0.5"
      data-testid="highlight-color-picker"
    >
      {SWATCHES.map(({ color, label, fill }) => {
        const pressed = current === color
        return (
          <Button
            key={label}
            variant="ghost"
            size="icon-xs"
            aria-label={t(label)}
            aria-pressed={pressed}
            className={cn(pressed && toolbarActiveClass)}
            {...toolbarPressHandlers(() => {
              editor.chain().focus().setMark('highlight', { color }).run()
              onPick?.()
            })}
          >
            <span className={cn('size-3.5 rounded-full border border-border', fill)} />
          </Button>
        )
      })}
    </div>
  )
}
