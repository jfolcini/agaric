/**
 * UnfitValueMark — the mark beside a property value that doesn't fit its
 * key's definition (#6206). It opens Settings › Properties on the dialog
 * listing the key's values that don't fit (`UnfitPropertyValues`), through
 * the navigation store's `pendingPropertyReview`.
 */

import { TriangleAlert } from 'lucide-react'
import type React from 'react'
import { useTranslation } from 'react-i18next'

import { IconButton } from '@/components/ui/icon-button'
import { formatPropertyName } from '@/lib/property-utils'
import { useNavigationStore } from '@/stores/navigation'

interface UnfitValueMarkProps {
  propKey: string
  value: string
}

export function UnfitValueMark({ propKey, value }: UnfitValueMarkProps): React.ReactElement {
  const { t } = useTranslation()
  const label = t('property.unfitReview', { key: formatPropertyName(propKey), value })
  return (
    <IconButton
      size="icon-xs"
      variant="ghost"
      className="text-alert-warning-foreground"
      tooltip={label}
      ariaLabel={label}
      // #1498: a press must not blur the block's editor.
      onMouseDown={(e) => e.preventDefault()}
      onClick={(e) => {
        // `StaticBlock.handleOuterClick` focuses the block on any bubbled click.
        e.stopPropagation()
        const navigation = useNavigationStore.getState()
        navigation.setPendingPropertyReview(propKey)
        navigation.setPendingSettingsTab('properties')
        navigation.setView('settings')
      }}
    >
      <TriangleAlert aria-hidden="true" />
    </IconButton>
  )
}
