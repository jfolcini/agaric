/**
 * AddBlockButton — shared "Add block" button used across all views.
 *
 * Renders a ghost button with a Plus icon and the i18n label.
 * Each view provides its own `onClick` handler with the appropriate
 * creation logic (page editor uses createBelow; journal creates
 * via Tauri directly).
 */

import { Plus } from 'lucide-react'
import type React from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { useIsTouch } from '@/hooks/useIsTouch'
import { cn } from '@/lib/utils'

export interface AddBlockButtonProps {
  onClick: () => void
  /** Override the default label (defaults to t('action.addBlock')). */
  label?: string | undefined
  className?: string | undefined
}

export function AddBlockButton({
  onClick,
  label,
  className,
}: AddBlockButtonProps): React.ReactElement {
  const { t } = useTranslation()
  const isTouch = useIsTouch()

  return (
    <Button
      variant="ghost"
      size="sm"
      // On touch the block rows hang into the gutter (`BlockListRenderer`); the
      // button's padding hangs with them so its icon sits on the text edge.
      className={cn(className ?? 'text-muted-foreground', isTouch && '-ml-3')}
      // Keeps the edited block focused through a tap. A tap's blur runs before
      // its click, unlike a mouse press's, which `useEditorBlur` holds until the
      // release. On a tap, that blur drops an empty block being edited, and the
      // click then adds no block and leaves no editor.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
    >
      <Plus className="h-4 w-4" />
      {label ?? t('action.addBlock')}
    </Button>
  )
}
