/**
 * ChangePropertyType -- "Change type…" on a user property definition (#5841).
 * `change_property_type` converts each value the space's blocks hold under
 * the key, Trash included, and removes the ones the new type cannot hold, in
 * one op the toast can undo. The dialog shows `preview_property_type_change`'s
 * counts and the blocks behind each first, and the change sends the counts
 * back as its acknowledgement. When the backend refuses that (the values
 * changed since), the dialog previews again and asks again, as
 * `MergePropertyDefinition` does.
 */

import { useInfiniteQuery } from '@tanstack/react-query'
import { Shapes } from 'lucide-react'
import type React from 'react'
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { fetchAndCacheLinks } from '@/components/block-tree/use-block-link-resolve'
import { LoadMoreButton } from '@/components/common/LoadMoreButton'
import { holderLabel } from '@/components/pages/SpaceMoveConfirmDialog'
import { notifyDefinitionWrite } from '@/components/properties/notify-definition-write'
import { Button } from '@/components/ui/button'
import { DialogBody } from '@/components/ui/dialog'
import { IconButton } from '@/components/ui/icon-button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Spinner } from '@/components/ui/spinner'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useDialogOrSheet } from '@/components/ui/use-dialog-or-sheet'
import { useDebouncedCallback } from '@/hooks/useDebouncedCallback'
import { unwrap, validationCode } from '@/lib/app-error'
import type {
  PageResponse,
  PropertyDefinition,
  PropertyTypeChangeCounts,
  PropertyTypeChangeKind,
  PropertyTypeChangeValue,
} from '@/lib/bindings'
import { commands } from '@/lib/bindings'
import { INTERNAL_PROPERTY_KEYS } from '@/lib/block-utils'
import { PAGINATION_LIMIT } from '@/lib/constants'
import { logger } from '@/lib/logger'
import { invalidatePropertyCaches } from '@/lib/property-caches'
import { selectOptionsJson, VALUE_TYPES } from '@/lib/property-utils'
import { queryClient } from '@/lib/query-client'
import { reportIpcErrorWithReason } from '@/lib/report-ipc-error'
import { ValidationCode } from '@/lib/search-query/validation-codes'
import { useResolveStore } from '@/stores/resolve'
import { useSpaceStore } from '@/stores/space'

export interface ChangePropertyTypeProps {
  definition: PropertyDefinition
  spaceId: string
  /** Read the list again after a change or its undo. */
  onChanged: () => void
  className?: string
}

/** The type a change goes to, and the options a select takes. */
interface Target {
  valueType: string
  options: string | null
}

/** A preview shown: its target, its counts, and its number, which keys the value lists. */
interface Preview {
  target: Target
  counts: PropertyTypeChangeCounts
  seq: number
}

export function ChangePropertyType({
  definition,
  spaceId,
  onChanged,
  className,
}: ChangePropertyTypeProps): React.ReactElement | null {
  const { t } = useTranslation()
  const parts = useDialogOrSheet('dialog')
  const [open, setOpen] = useState(false)
  const [valueType, setValueType] = useState<string | null>(null)
  const [optionsText, setOptionsText] = useState('')
  const [shown, setShown] = useState<Preview | null>(null)
  // Asked again: the values changed after the user saw them.
  const [askedAgain, setAskedAgain] = useState(false)
  const [changing, setChanging] = useState(false)
  // A preview answered after another pick must not show its counts.
  const previewSeq = useRef(0)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const { key } = definition

  const preview = async (target: Target): Promise<void> => {
    const seq = ++previewSeq.current
    setShown(null)
    // A select needs its options before the backend can say what fits.
    if (target.valueType === 'select' && target.options === null) return
    try {
      const counts = unwrap(
        await commands.previewPropertyTypeChange(spaceId, key, target.valueType, target.options),
      )
      if (seq === previewSeq.current) setShown({ target, counts, seq })
    } catch (error) {
      reportIpcErrorWithReason(
        'ChangePropertyType',
        'propertiesView.typeChangePreviewFailed',
        error,
        t,
        { key, valueType: target.valueType },
      )
    }
  }

  const previewOptions = useDebouncedCallback((text) => {
    // `preview` reports its own failure; never rejects.
    void preview({ valueType: 'select', options: selectOptionsJson(text) })
  }, 300)

  if (definition.builtin || INTERNAL_PROPERTY_KEYS.has(key)) return null

  const changed = (): void => {
    onChanged()
    invalidatePropertyCaches()
  }

  const pick = (next: string): void => {
    setValueType(next)
    setAskedAgain(false)
    previewOptions.cancel()
    // `preview` reports its own failure; never rejects.
    void preview({
      valueType: next,
      options: next === 'select' ? selectOptionsJson(optionsText) : null,
    })
  }

  const typeOptions = (text: string): void => {
    setOptionsText(text)
    setAskedAgain(false)
    previewSeq.current += 1
    setShown(null)
    previewOptions.schedule(text)
  }

  const onOpenChange = (next: boolean): void => {
    setOpen(next)
    if (next) return
    previewOptions.cancel()
    previewSeq.current += 1
    setValueType(null)
    setOptionsText('')
    setShown(null)
    setAskedAgain(false)
  }

  const change = async (): Promise<void> => {
    if (shown === null || changing) return
    const { target, counts } = shown
    setChanging(true)
    try {
      const result = unwrap(
        await commands.changePropertyType(spaceId, key, target.valueType, target.options, counts),
      )
      onOpenChange(false)
      notifyDefinitionWrite(
        t('propertiesView.typeChanged', { key, type: target.valueType }),
        result.op_refs,
        changed,
      )
      changed()
    } catch (error) {
      if (validationCode(error) === ValidationCode.UnacknowledgedPropertyLoss) {
        setAskedAgain(true)
        await preview(target)
      } else {
        reportIpcErrorWithReason(
          'ChangePropertyType',
          'propertiesView.typeChangeFailed',
          error,
          t,
          {
            key,
            valueType: target.valueType,
          },
        )
      }
    } finally {
      setChanging(false)
    }
  }

  const { Root, Content, Header, Title, Description, Footer } = parts
  const body = (
    <div className="space-y-3 text-sm">
      <Select value={valueType ?? ''} onValueChange={pick}>
        <SelectTrigger aria-label={t('propertiesView.typeChangeTypeLabel')}>
          <SelectValue placeholder={t('propertiesView.typeChangeTypePlaceholder')} />
        </SelectTrigger>
        <SelectContent>
          {VALUE_TYPES.filter((type) => type !== definition.value_type).map((type) => (
            <SelectItem key={type} value={type}>
              {type}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {valueType === 'select' && (
        <Input
          value={optionsText}
          onChange={(e) => typeOptions(e.target.value)}
          placeholder={t('properties.newSelectOptions')}
          aria-label={t('properties.newSelectOptions')}
        />
      )}
      {askedAgain && (
        <p role="alert" className="text-destructive">
          {t('propertiesView.typeChangeCountsChanged')}
        </p>
      )}
      {shown !== null && (
        <>
          <div className="space-y-1" data-testid="property-type-change-counts">
            <p>{t('propertiesView.typeChangeConverts', { count: shown.counts.converted })}</p>
            {shown.counts.removed > 0 && (
              <p>
                {t('propertiesView.typeChangeRemoves', {
                  count: shown.counts.removed,
                  type: shown.target.valueType,
                })}
              </p>
            )}
            <p className="text-muted-foreground">{t('propertiesView.typeChangeTrashNote')}</p>
          </div>
          <TypeChangeTabs
            spaceId={spaceId}
            propertyKey={key}
            fromType={definition.value_type}
            preview={shown}
          />
        </>
      )}
    </div>
  )

  return (
    <>
      <IconButton
        ref={triggerRef}
        variant="ghost"
        size="icon-xs"
        tooltip={t('propertiesView.typeChangeTooltip')}
        ariaLabel={t('propertiesView.typeChangeLabel', { key })}
        className={className}
        onClick={() => setOpen(true)}
      >
        <Shapes />
      </IconButton>
      <Root open={open} onOpenChange={onOpenChange}>
        <Content
          onCloseAutoFocus={(event: Event) => {
            // No dialog trigger to return to: the opener, while its row stands.
            event.preventDefault()
            if (triggerRef.current?.isConnected) triggerRef.current.focus()
          }}
        >
          <Header>
            <Title>{t('propertiesView.typeChangeTitle', { key })}</Title>
            <Description>{t('propertiesView.typeChangeDescription', { key })}</Description>
          </Header>
          {parts.isMobile ? body : <DialogBody>{body}</DialogBody>}
          <Footer>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              {t('action.cancel')}
            </Button>
            <Button
              variant={shown !== null && shown.counts.removed > 0 ? 'destructive' : 'default'}
              disabled={shown === null || changing}
              onClick={() => {
                // `change` reports its own failure; never rejects.
                void change()
              }}
            >
              {t('propertiesView.typeChangeConfirm')}
            </Button>
          </Footer>
        </Content>
      </Root>
    </>
  )
}

interface TypeChangeTabsProps {
  spaceId: string
  propertyKey: string
  fromType: string
  preview: Preview
}

/** The removed and the converted values, a tab each; a tab with none is disabled. */
function TypeChangeTabs({
  spaceId,
  propertyKey,
  fromType,
  preview,
}: TypeChangeTabsProps): React.ReactElement | null {
  const { t } = useTranslation()
  const { converted, removed } = preview.counts
  const [picked, setPicked] = useState<PropertyTypeChangeKind | null>(null)
  if (converted + removed === 0) return null
  const tab = picked ?? (removed > 0 ? 'removed' : 'converted')
  const values = (kind: PropertyTypeChangeKind) => (
    <TabsContent value={kind} className="pt-2">
      <TypeChangeValues
        spaceId={spaceId}
        propertyKey={propertyKey}
        fromType={fromType}
        preview={preview}
        kind={kind}
      />
    </TabsContent>
  )
  return (
    <Tabs
      value={tab}
      onValueChange={(next) => setPicked(next === 'converted' ? 'converted' : 'removed')}
    >
      <TabsList aria-label={t('propertiesView.typeChangeValuesLabel')}>
        <TabsTrigger value="removed" disabled={removed === 0}>
          {t('propertiesView.typeChangeRemovedTab', { count: removed })}
        </TabsTrigger>
        <TabsTrigger value="converted" disabled={converted === 0}>
          {t('propertiesView.typeChangeConvertedTab', { count: converted })}
        </TabsTrigger>
      </TabsList>
      {values('removed')}
      {values('converted')}
    </Tabs>
  )
}

interface TypeChangeValuesProps extends TypeChangeTabsProps {
  kind: PropertyTypeChangeKind
}

/** The blocks holding the values of `kind`, a page at a time. */
function TypeChangeValues({
  spaceId,
  propertyKey,
  fromType,
  preview,
  kind,
}: TypeChangeValuesProps): React.ReactElement {
  const { t } = useTranslation()
  const { valueType, options } = preview.target
  const refs = { value: fromType === 'ref', converted: valueType === 'ref' }
  const { data, isPending, isError, hasNextPage, fetchNextPage, isFetchingNextPage } =
    useInfiniteQuery(
      {
        // The preview's number: a preview again reads the values again.
        queryKey: ['propertyTypeChangeValues', spaceId, propertyKey, kind, preview.seq],
        queryFn: async ({ pageParam }): Promise<PageResponse<PropertyTypeChangeValue>> => {
          try {
            const page = unwrap(
              await commands.listPropertyTypeChangeValues(
                spaceId,
                propertyKey,
                valueType,
                options,
                kind,
                pageParam ?? null,
                PAGINATION_LIMIT,
              ),
            )
            await resolveRefs(page.items, refs)
            return page
          } catch (err) {
            logger.warn('ChangePropertyType', 'failed to load values', { propertyKey, kind }, err)
            throw err
          }
        },
        initialPageParam: undefined as string | undefined,
        getNextPageParam: (lastPage) => (lastPage.has_more ? lastPage.next_cursor : undefined),
        // Each open re-reads: the values are what the change would do now.
        refetchOnMount: 'always',
        gcTime: 0,
      },
      queryClient,
    )
  const resolveTitle = useResolveStore((s) => s.resolveTitle)
  const shown = (text: string, isRef: boolean): string => (isRef ? resolveTitle(text) : text)
  const rows = data?.pages.flatMap((page) => page.items) ?? []
  if (isPending) return <Spinner label />
  if (isError) {
    return (
      <p role="alert" className="text-destructive">
        {t('spaceMove.valuesFailed')}
      </p>
    )
  }
  return (
    <div className="flex flex-col gap-1">
      <ul className="flex flex-col gap-1">
        {rows.map((row) => (
          <li key={row.block_id} className="flex min-w-0 items-baseline gap-2">
            <span className="min-w-0 flex-1 truncate">{holderLabel(row)}</span>
            {row.deleted && (
              <span className="shrink-0 text-xs text-muted-foreground">
                {t('spaceMove.inTrash')}
              </span>
            )}
            <span className="max-w-[40%] shrink-0 truncate text-muted-foreground">
              {row.converted === null
                ? shown(row.value, refs.value)
                : `${shown(row.value, refs.value)} → ${shown(row.converted, refs.converted)}`}
            </span>
          </li>
        ))}
      </ul>
      <LoadMoreButton
        hasMore={hasNextPage}
        loading={isFetchingNextPage}
        onLoadMore={() => {
          void fetchNextPage()
        }}
      />
    </div>
  )
}

/** Asks the backend for the titles of the referenced blocks the resolve store has no answer for. */
async function resolveRefs(
  rows: readonly PropertyTypeChangeValue[],
  refs: { value: boolean; converted: boolean },
): Promise<void> {
  const store = useResolveStore.getState()
  const ids = new Set(
    rows.flatMap((row) =>
      [refs.value ? row.value : null, refs.converted ? row.converted : null].filter(
        (id): id is string => id !== null && !store.has(id),
      ),
    ),
  )
  if (ids.size === 0) return
  const spaceId = useSpaceStore.getState().currentSpaceId
  await fetchAndCacheLinks(ids, spaceId, () => useSpaceStore.getState().currentSpaceId !== spaceId)
}
