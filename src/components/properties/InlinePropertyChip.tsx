import type React from 'react'
import { useTranslation } from 'react-i18next'

import { PropertyChip } from '@/components/properties/PropertyChip'
import { useRefTitle, useRefTitles } from '@/components/properties/useRefTitle'
import type { InlineProperty } from '@/hooks/useExtraBlockProperties'

interface InlinePropertyChipProps {
  blockId: string
  property: InlineProperty
  onEditProp: (prop: { key: string; value: string }) => void
  onEditKey: (keyInfo: { oldKey: string; value: string }) => void
  /** Follow a ref chip to its target, as a `[[link]]` chip does. */
  onNavigate?: ((id: string) => void) | undefined
  /** Open the block's property drawer, where a boolean is a checkbox. */
  onShowProperties?: ((blockId: string) => void) | undefined
  /** The value doesn't fit its key's definition (#6206). */
  unfit?: boolean | undefined
  /** A list's items are refs (its key is declared `ref`), shown by their targets' titles. */
  refItems?: boolean | undefined
}

/**
 * One property chip of a block's metadata row. Its key renames the key. A
 * text, date or number value opens the chip editor; a ref shows its target's
 * title as the resolve cache holds it now, so a rename shows at once, and opens
 * the target; a boolean says its state in words and opens the property drawer;
 * a list (#6741) shows its items joined, a ref list its targets' titles, and
 * opens the drawer, where its items are edited. Any of them carries a mark when
 * its value doesn't fit its key (`unfit`).
 */
export function InlinePropertyChip({
  blockId,
  property,
  onEditProp,
  onEditKey,
  onNavigate,
  onShowProperties,
  unfit,
  refItems,
}: InlinePropertyChipProps): React.ReactElement {
  const { t } = useTranslation()
  const { key, value, kind } = property
  const onKeyClick = () => onEditKey({ oldKey: key, value })
  const onOpenDrawer = onShowProperties && (() => onShowProperties(blockId))
  if (kind === 'list') {
    return refItems ? (
      <RefListPropertyChip
        propKey={key}
        targetIds={(property.items ?? []).map(String)}
        onClick={onOpenDrawer}
        onKeyClick={onKeyClick}
        unfit={unfit}
      />
    ) : (
      <PropertyChip
        propKey={key}
        value={value}
        onClick={onOpenDrawer}
        onKeyClick={onKeyClick}
        unfit={unfit}
      />
    )
  }
  if (kind === 'ref') {
    return (
      <RefPropertyChip
        propKey={key}
        targetId={value}
        onNavigate={onNavigate}
        onKeyClick={onKeyClick}
        unfit={unfit}
      />
    )
  }
  if (kind === 'boolean') {
    return (
      <PropertyChip
        propKey={key}
        value={t(value === 'true' ? 'property.booleanTrue' : 'property.booleanFalse')}
        onClick={onOpenDrawer}
        onKeyClick={onKeyClick}
        unfit={unfit}
      />
    )
  }
  return (
    <PropertyChip
      propKey={key}
      value={value}
      onClick={() => onEditProp({ key, value })}
      onKeyClick={onKeyClick}
      unfit={unfit}
    />
  )
}

function RefPropertyChip({
  propKey,
  targetId,
  onNavigate,
  onKeyClick,
  unfit,
}: {
  propKey: string
  targetId: string
  onNavigate?: ((id: string) => void) | undefined
  onKeyClick: () => void
  unfit?: boolean | undefined
}): React.ReactElement {
  const { t } = useTranslation()
  const title = useRefTitle(targetId) ?? ''
  return (
    <PropertyChip
      propKey={propKey}
      value={title}
      valueAriaLabel={t('property.openRefTarget', { title })}
      onClick={onNavigate && (() => onNavigate(targetId))}
      onKeyClick={onKeyClick}
      unfit={unfit}
    />
  )
}

function RefListPropertyChip({
  propKey,
  targetIds,
  onClick,
  onKeyClick,
  unfit,
}: {
  propKey: string
  targetIds: readonly string[]
  onClick?: (() => void) | undefined
  onKeyClick: () => void
  unfit?: boolean | undefined
}): React.ReactElement {
  const titles = useRefTitles(targetIds)
  return (
    <PropertyChip
      propKey={propKey}
      value={titles}
      onClick={onClick}
      onKeyClick={onKeyClick}
      unfit={unfit}
    />
  )
}
