import type React from 'react'
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'

import { fetchAndCacheLinks } from '@/components/block-tree/use-block-link-resolve'
import { PropertyChip } from '@/components/properties/PropertyChip'
import type { InlineProperty } from '@/hooks/useExtraBlockProperties'
import { useResolveStore } from '@/stores/resolve'
import { useSpaceStore } from '@/stores/space'

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
}

/**
 * One property chip of a block's metadata row. Its key renames the key. A
 * text, date or number value opens the chip editor; a ref shows its target's
 * title as the resolve cache holds it now, so a rename shows at once, and opens
 * the target; a boolean says its state in words and opens the property drawer.
 * Any of them carries a mark when its value doesn't fit its key (`unfit`).
 */
export function InlinePropertyChip({
  blockId,
  property,
  onEditProp,
  onEditKey,
  onNavigate,
  onShowProperties,
  unfit,
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
        unfit={unfit}
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
  const title = useResolveStore((s) => s.resolveTitle(targetId))
  // The boot preload caches the active space's pages and tags, so a ref to a
  // block, to another space's page or to an evicted entry is asked for the way
  // a `[[link]]` chip's target is.
  const cached = useResolveStore((s) => s.has(targetId))
  useEffect(() => {
    if (cached) return
    const spaceId = useSpaceStore.getState().currentSpaceId
    void fetchAndCacheLinks(
      new Set([targetId]),
      spaceId,
      () => useSpaceStore.getState().currentSpaceId !== spaceId,
    )
  }, [targetId, cached])
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
