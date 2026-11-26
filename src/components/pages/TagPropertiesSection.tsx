/**
 * TagPropertiesSection — "Properties for tagged blocks" on a tag's page
 * (#6755): the keys the tag lists under `tag_properties`, which the blocks
 * tagged with it are offered as empty rows, and "Set on tagged blocks".
 *
 * The keys are picked from the space's own definitions (built-ins and the
 * app's keys are not offered). Each add or remove is one ordinary
 * `set_property` of the list (removing the last key deletes the property),
 * with an Undo in its toast.
 */

import { useQuery } from '@tanstack/react-query'
import { X } from 'lucide-react'
import type React from 'react'
import { useTranslation } from 'react-i18next'

import { SetOnTaggedBlocks } from '@/components/pages/SetOnTaggedBlocks'
import { AddPropertyPopover } from '@/components/properties/AddPropertyPopover'
import { notifyDefinitionWrite } from '@/components/properties/notify-definition-write'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { unwrap } from '@/lib/app-error'
import type { PropertyDefinition } from '@/lib/bindings'
import { commands } from '@/lib/bindings'
import { INTERNAL_PROPERTY_KEYS } from '@/lib/block-utils'
import { listAllPropertyDefs, savePropertyList } from '@/lib/property-save-utils'
import { formatPropertyName } from '@/lib/property-utils'
import { queryClient } from '@/lib/query-client'
import { reportIpcError, reportIpcErrorWithReason } from '@/lib/report-ipc-error'
import { useSpaceStore } from '@/stores/space'

const KEY = 'tag_properties'

export interface TagPropertiesSectionProps {
  tagId: string
}

function useTagKeys(tagId: string): string[] {
  const { t } = useTranslation()
  const { data } = useQuery(
    {
      queryKey: ['tagProperties', tagId],
      staleTime: 0,
      queryFn: async (): Promise<string[]> => {
        try {
          const rows = unwrap(await commands.getProperties(tagId))
          const list = rows.find((r) => r.key === KEY)?.value_list ?? []
          return list.filter((item): item is string => typeof item === 'string')
        } catch (err) {
          reportIpcError('TagPropertiesSection', 'tagProperties.loadFailed', err, t, { tagId })
          return []
        }
      },
    },
    queryClient,
  )
  return data ?? []
}

function useSpaceDefinitions(spaceId: string | null): PropertyDefinition[] {
  const { t } = useTranslation()
  const { data } = useQuery(
    {
      queryKey: ['tagPropertiesDefs', spaceId],
      enabled: spaceId !== null,
      staleTime: 0,
      queryFn: async (): Promise<PropertyDefinition[]> => {
        try {
          return await listAllPropertyDefs(spaceId ?? '')
        } catch (err) {
          reportIpcError('TagPropertiesSection', 'tagProperties.loadFailed', err, t, { spaceId })
          return []
        }
      },
    },
    queryClient,
  )
  return data ?? []
}

export function TagPropertiesSection({ tagId }: TagPropertiesSectionProps): React.ReactElement {
  const { t } = useTranslation()
  const spaceId = useSpaceStore((s) => s.currentSpaceId)
  const keys = useTagKeys(tagId)
  const definitions = useSpaceDefinitions(spaceId)
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['tagProperties', tagId] })

  const write = async (next: string[], message: string): Promise<void> => {
    try {
      const refs = await savePropertyList(tagId, KEY, next)
      notifyDefinitionWrite(message, refs, refresh)
      refresh()
    } catch (err) {
      reportIpcErrorWithReason('TagPropertiesSection', 'tagProperties.saveFailed', err, t, {
        tagId,
      })
    }
  }

  const offered = definitions.filter(
    (d) => !d.builtin && !INTERNAL_PROPERTY_KEYS.has(d.key) && !keys.includes(d.key),
  )

  return (
    <section className="space-y-2" data-testid="tag-properties">
      <h2 className="text-sm font-semibold">{t('tagProperties.title')}</h2>
      <p className="text-xs text-muted-foreground">{t('tagProperties.description')}</p>
      <div className="flex flex-wrap items-center gap-2">
        {keys.map((key) => (
          <Badge key={key} tone="property" className="gap-1 font-mono">
            {formatPropertyName(key)}
            <Button
              variant="ghost"
              size="icon-xs"
              className="touch-hit-area text-muted-foreground hover:text-destructive"
              aria-label={t('tagProperties.removeKey', { key })}
              onClick={() =>
                void write(
                  keys.filter((k) => k !== key),
                  t('tagProperties.keyRemoved', { key }),
                )
              }
            >
              <X className="h-3 w-3" />
            </Button>
          </Badge>
        ))}
        <AddPropertyPopover
          definitions={offered}
          onAdd={(def) => write([...keys, def.key], t('tagProperties.keyAdded', { key: def.key }))}
        />
      </div>
      {keys.length > 0 && <SetOnTaggedBlocks tagId={tagId} keys={keys} definitions={definitions} />}
    </section>
  )
}
