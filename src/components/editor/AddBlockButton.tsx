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

  return (
    <Button
      variant="ghost"
      size="sm"
      className={className ?? 'text-muted-foreground'}
      // Keeps the edited block focused through a tap. A tap's blur runs before
      // its click, unlike a mouse press's, which `useEditorBlur` holds until the
      // release. The page's `onClick` reads that focus (`unfocusedBlankTail`), so
      // without this it reopens the blank block just left instead of adding one.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
    >
      <Plus className="h-4 w-4" />
      {label ?? t('action.addBlock')}
    </Button>
  )
}
