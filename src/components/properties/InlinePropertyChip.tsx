import type React from 'react'
import { useTranslation } from 'react-i18next'

import { PropertyChip } from '@/components/properties/PropertyChip'
import type { InlineProperty } from '@/hooks/useExtraBlockProperties'
import { useResolveStore } from '@/stores/resolve'

interface InlinePropertyChipProps {
  blockId: string
  property: InlineProperty
  onEditProp: (prop: { key: string; value: string }) => void
  onEditKey: (keyInfo: { oldKey: string; value: string }) => void
  /** Follow a ref chip to its target, as a `[[link]]` chip does. */
  onNavigate?: ((id: string) => void) | undefined
  /** Open the block's property drawer, where a boolean is a checkbox. */
  onShowProperties?: ((blockId: string) => void) | undefined
}

/**
 * One property chip of a block's metadata row. Its key renames the key. A
 * text, date or number value opens the chip editor; a ref shows its target's
 * title as the resolve cache holds it now, so a rename shows at once, and opens
 * the target; a boolean says its state in words and opens the property drawer.
 */
export function InlinePropertyChip({
  blockId,
  property,
  onEditProp,
  onEditKey,
  onNavigate,
  onShowProperties,
}: InlinePropertyChipProps): React.ReactElement {
  const { t } = useTranslation()
  const { key, value, kind } = property
  const onKeyClick = () => onEditKey({ oldKey: key, value })
  if (kind === 'ref') {
    return (
      <RefPropertyChip
        propKey={key}
        targetId={value}
        onNavigate={onNavigate}
        onKeyClick={onKeyClick}
      />
    )
  }
  if (kind === 'boolean') {
    return (
      <PropertyChip
        propKey={key}
        value={t(value === 'true' ? 'property.booleanTrue' : 'property.booleanFalse')}
        onClick={onShowProperties && (() => onShowProperties(blockId))}
        onKeyClick={onKeyClick}
      />
    )
  }
  return (
    <PropertyChip
      propKey={key}
      value={value}
      onClick={() => onEditProp({ key, value })}
      onKeyClick={onKeyClick}
    />
  )
}

function RefPropertyChip({
  propKey,
  targetId,
  onNavigate,
  onKeyClick,
}: {
  propKey: string
  targetId: string
  onNavigate?: ((id: string) => void) | undefined
  onKeyClick: () => void
}): React.ReactElement {
  const { t } = useTranslation()
  const title = useResolveStore((s) => s.resolveTitle(targetId))
  return (
    <PropertyChip
      propKey={propKey}
      value={title}
      valueAriaLabel={t('property.openRefTarget', { title })}
      onClick={onNavigate && (() => onNavigate(targetId))}
      onKeyClick={onKeyClick}
    />
  )
}
