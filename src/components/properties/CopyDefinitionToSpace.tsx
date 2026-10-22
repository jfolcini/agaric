/**
 * CopyDefinitionToSpace -- "Copy to space…" on a user property definition
 * (#5841). Definitions are per space; this declares the same key, type and
 * options in another space through `create_property_def`. That command keeps
 * a definition the target already has, so a differing one is reported, not
 * overwritten.
 */

import { Copy } from 'lucide-react'
import type React from 'react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { IconButton } from '@/components/ui/icon-button'
import { MenuPopoverContent } from '@/components/ui/menu-popover-content'
import { Popover, PopoverTrigger } from '@/components/ui/popover'
import { PopoverMenuItem } from '@/components/ui/popover-menu-item'
import { unwrap } from '@/lib/app-error'
import type { PropertyDefinition, SpaceRow } from '@/lib/bindings'
import { commands } from '@/lib/bindings'
import { notify } from '@/lib/notify'
import { reportIpcErrorWithReason } from '@/lib/report-ipc-error'
import { useSpaceStore } from '@/stores/space'

export interface CopyDefinitionToSpaceProps {
  definition: PropertyDefinition
  /** The space the definition is listed in, never offered as a target. */
  fromSpaceId: string
  className?: string
}

export function CopyDefinitionToSpace({
  definition,
  fromSpaceId,
  className,
}: CopyDefinitionToSpaceProps): React.ReactElement | null {
  const { t } = useTranslation()
  const spaces = useSpaceStore((s) => s.availableSpaces)
  const [open, setOpen] = useState(false)
  const targets = spaces.filter((space) => space.id !== fromSpaceId)
  if (targets.length === 0) return null

  const { key } = definition
  const copyTo = async (space: SpaceRow): Promise<void> => {
    setOpen(false)
    try {
      const held = unwrap(
        await commands.createPropertyDef(space.id, key, definition.value_type, definition.options),
      )
      if (held.value_type === definition.value_type && held.options === definition.options) {
        notify.success(t('propertiesView.copiedToSpace', { key, space: space.name }))
      } else {
        notify.warning(
          t('propertiesView.copyKeptExisting', { key, space: space.name, type: held.value_type }),
        )
      }
    } catch (error) {
      // The backend's reason names what is in the way: values the target
      // space's blocks hold under the key that the type would refuse.
      reportIpcErrorWithReason('CopyDefinitionToSpace', 'propertiesView.copyFailed', error, t, {
        key,
        spaceId: space.id,
      })
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <IconButton
          variant="ghost"
          size="icon-xs"
          tooltip={t('propertiesView.copyToSpaceTooltip')}
          ariaLabel={t('propertiesView.copyToSpaceLabel', { key })}
          className={className}
        >
          <Copy />
        </IconButton>
      </PopoverTrigger>
      <MenuPopoverContent align="end" className="w-56">
        <ul
          className="m-0 flex list-none flex-col gap-0.5 p-0"
          aria-label={t('propertiesView.copyToSpaceMenuLabel', { key })}
        >
          {targets.map((space) => (
            <li key={space.id}>
              <PopoverMenuItem
                onClick={() => {
                  // `copyTo` reports its own failure; never rejects.
                  void copyTo(space)
                }}
              >
                {space.name}
              </PopoverMenuItem>
            </li>
          ))}
        </ul>
      </MenuPopoverContent>
    </Popover>
  )
}
