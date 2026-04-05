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
      onClick={onClick}
    >
      <Plus className="h-4 w-4" />
      {label ?? t('action.addBlock')}
    </Button>
  )
}
