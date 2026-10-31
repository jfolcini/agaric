/**
 * UnfitPropertyValues -- the "N don't fit" badge on a property definition and
 * its dialog (#6206). The badge counts the space's live blocks whose value
 * doesn't fit the key's type or options; the dialog lists every such value,
 * the Trash's included, and removes them all in one op the toast can undo,
 * adds a user select's to its options, or converts each as the user maps it
 * (`ConvertUnfitValues`), but a ref's. Removal sends the counts it showed as
 * its acknowledgement; when the backend refuses that (the values changed
 * since), the dialog says so and the counts and list are read again, as
 * `ChangePropertyType` previews again. A mark on one of the key's values
 * elsewhere (`UnfitValueMark`) opens the dialog through the navigation store's
 * `pendingPropertyReview`.
 */

import { useInfiniteQuery } from '@tanstack/react-query'
import { SearchCheck, TriangleAlert } from 'lucide-react'
import type React from 'react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { EmptyState } from '@/components/common/EmptyState'
import { LoadMoreButton } from '@/components/common/LoadMoreButton'
import { holderLabel } from '@/components/pages/SpaceMoveConfirmDialog'
import { ConvertUnfitValues } from '@/components/properties/ConvertUnfitValues'
import { notifyDefinitionWrite } from '@/components/properties/notify-definition-write'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { DialogBody } from '@/components/ui/dialog'
import { Spinner } from '@/components/ui/spinner'
import { useDialogOrSheet } from '@/components/ui/use-dialog-or-sheet'
import { unwrap, validationCode } from '@/lib/app-error'
import type {
  PageResponse,
  PropertyDefinition,
  PropertyUnfitCounts,
  UnfitPropertyValue,
  WithOps,
} from '@/lib/bindings'
import { commands } from '@/lib/bindings'
import { PAGINATION_LIMIT } from '@/lib/constants'
import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'
import { invalidatePropertyCaches } from '@/lib/property-caches'
import { queryClient } from '@/lib/query-client'
import { reportIpcErrorWithReason } from '@/lib/report-ipc-error'
import { ValidationCode } from '@/lib/search-query/validation-codes'
import { useNavigationStore } from '@/stores/navigation'

export interface UnfitPropertyValuesProps {
  definition: PropertyDefinition
  spaceId: string
  /** `count_property_usage`'s answer for the key; null while it is read again. */
  counts: PropertyUnfitCounts | null
  /** Read the list and its counts again after a write, its undo, or a refusal. */
  onChanged: () => void
}

export function UnfitPropertyValues({
  definition,
  spaceId,
  counts,
  onChanged,
}: UnfitPropertyValuesProps): React.ReactElement | null {
  const { t } = useTranslation()
  const parts = useDialogOrSheet('dialog')
  const [open, setOpen] = useState(false)
  // Asked again: the values changed after the user saw them.
  const [askedAgain, setAskedAgain] = useState(false)
  const [writing, setWriting] = useState(false)
  const [step, setStep] = useState<'review' | 'convert'>('review')
  // Bumped when the values are read again, so the list reads them again too.
  const [listSeq, setListSeq] = useState(0)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const { key } = definition
  const live = counts?.unfit ?? 0

  // A mark on one of the key's values asks for this dialog from another view.
  const requested = useNavigationStore((s) => s.pendingPropertyReview === key)
  useEffect(() => {
    if (!requested) return
    // oxlint-disable-next-line react/set-state-in-effect -- consumes the navigation store's one-shot handoff slot; the dialog is also opened by its badge, so it cannot be derived from the slot
    setOpen(true)
    // Only if it is still this key's: another mark may have written it since.
    const navigation = useNavigationStore.getState()
    if (navigation.pendingPropertyReview === key) navigation.setPendingPropertyReview(null)
  }, [requested, key])

  // The badge counts live blocks, as the use count beside it does, so a key whose values that
  // don't fit are all in the Trash shows none until one is restored. The open dialog outlives a
  // count that drops to zero while it is read again.
  if (live === 0 && !open) return null

  const changed = (): void => {
    onChanged()
    invalidatePropertyCaches()
  }

  const onOpenChange = (next: boolean): void => {
    setOpen(next)
    if (next) return
    setAskedAgain(false)
    setStep('review')
  }

  const remove = async (acknowledged: PropertyUnfitCounts): Promise<void> => {
    setWriting(true)
    try {
      const result = unwrap(await commands.removeUnfitPropertyValues(spaceId, key, acknowledged))
      onOpenChange(false)
      const count = result.unfit + result.unfit_in_trash
      notifyDefinitionWrite(
        t('propertiesView.unfitRemoved', { count, key }),
        result.op_refs,
        changed,
      )
      changed()
    } catch (error) {
      if (validationCode(error) === ValidationCode.UnacknowledgedPropertyLoss) {
        setAskedAgain(true)
        setListSeq((seq) => seq + 1)
        onChanged()
      } else {
        reportIpcErrorWithReason(
          'UnfitPropertyValues',
          'propertiesView.unfitRemoveFailed',
          error,
          t,
          { key },
        )
      }
    } finally {
      setWriting(false)
    }
  }

  const converted = (result: WithOps<PropertyUnfitCounts>): void => {
    onOpenChange(false)
    const count = result.unfit + result.unfit_in_trash
    notifyDefinitionWrite(t('propertiesView.convertDone', { count, key }), result.op_refs, changed)
    changed()
  }

  const addToOptions = async (): Promise<void> => {
    setWriting(true)
    try {
      const result = unwrap(await commands.addUnfitValuesToOptions(spaceId, key))
      if (result.op_refs.length === 0) {
        // Only a text can be an option: a number or a boolean that doesn't fit stays as it is.
        notify.info(t('propertiesView.unfitNothingToAdd'))
        return
      }
      onOpenChange(false)
      notifyDefinitionWrite(
        t('propertiesView.unfitAddedToOptions', { key }),
        result.op_refs,
        changed,
      )
      changed()
    } catch (error) {
      reportIpcErrorWithReason('UnfitPropertyValues', 'propertiesView.unfitAddFailed', error, t, {
        key,
      })
    } finally {
      setWriting(false)
    }
  }

  const { Root, Content, Header, Title, Description, Footer } = parts
  const body = (
    <div className="space-y-3 text-sm">
      {askedAgain && (
        <p role="alert" className="text-destructive">
          {t('propertiesView.typeChangeCountsChanged')}
        </p>
      )}
      {counts === null ? (
        <Spinner label />
      ) : (
        <div className="space-y-1" data-testid="property-unfit-counts">
          <p>{t('propertiesView.unfitCount', { count: counts.unfit })}</p>
          {counts.unfit_in_trash > 0 && (
            <p className="text-muted-foreground">
              {t('propertiesView.unfitInTrash', { count: counts.unfit_in_trash })}
            </p>
          )}
        </div>
      )}
      <UnfitValueList spaceId={spaceId} definition={definition} listSeq={listSeq} />
    </div>
  )

  return (
    <>
      <Badge
        asChild
        tone="outline"
        className="touch-hit-area cursor-pointer border-alert-warning-border bg-alert-warning text-alert-warning-foreground hover:bg-alert-warning/80"
      >
        <button
          ref={triggerRef}
          type="button"
          aria-label={t('propertiesView.unfitLabel', { count: live, key })}
          data-testid={`property-unfit-${key}`}
          onClick={() => setOpen(true)}
        >
          <TriangleAlert aria-hidden="true" />
          {t('propertiesView.unfitBadge', { count: live })}
        </button>
      </Badge>
      <Root open={open} onOpenChange={onOpenChange}>
        <Content
          onCloseAutoFocus={(event: Event) => {
            // No dialog trigger to return to: the badge, while it stands.
            event.preventDefault()
            if (triggerRef.current?.isConnected) triggerRef.current.focus()
          }}
        >
          <Header>
            <Title>{t('propertiesView.unfitTitle', { key })}</Title>
            <Description>
              {step === 'convert'
                ? t('propertiesView.convertIntro', { type: definition.value_type })
                : t('propertiesView.unfitDescription', { key, type: definition.value_type })}
            </Description>
          </Header>
          {step === 'convert' ? (
            <ConvertUnfitValues
              definition={definition}
              spaceId={spaceId}
              onBack={() => setStep('review')}
              onChanged={onChanged}
              onDone={converted}
            />
          ) : (
            <>
              {parts.isMobile ? body : <DialogBody>{body}</DialogBody>}
              <Footer>
                <Button variant="outline" onClick={() => onOpenChange(false)}>
                  {t('action.cancel')}
                </Button>
                {!definition.builtin && definition.value_type === 'select' && (
                  <Button
                    variant="outline"
                    disabled={writing}
                    onClick={() => {
                      // `addToOptions` reports its own failure; never rejects.
                      void addToOptions()
                    }}
                  >
                    {t('propertiesView.unfitAddToOptions')}
                  </Button>
                )}
                {definition.value_type !== 'ref' && (
                  <Button variant="outline" disabled={writing} onClick={() => setStep('convert')}>
                    {t('propertiesView.convertOpen')}
                  </Button>
                )}
                <Button
                  variant="destructive"
                  disabled={counts === null || writing}
                  onClick={() => {
                    // `remove` reports its own failure; never rejects.
                    if (counts !== null) void remove(counts)
                  }}
                >
                  {t('propertiesView.unfitRemove')}
                </Button>
              </Footer>
            </>
          )}
        </Content>
      </Root>
    </>
  )
}

interface UnfitValueListProps {
  spaceId: string
  definition: PropertyDefinition
  listSeq: number
}

/** The blocks holding a value that doesn't fit, a page at a time. */
function UnfitValueList({ spaceId, definition, listSeq }: UnfitValueListProps): React.ReactElement {
  const { t } = useTranslation()
  const { key, value_type: type } = definition
  const { data, isPending, isError, hasNextPage, fetchNextPage, isFetchingNextPage } =
    useInfiniteQuery(
      {
        queryKey: ['unfitPropertyValues', spaceId, key, listSeq],
        queryFn: async ({ pageParam }): Promise<PageResponse<UnfitPropertyValue>> => {
          try {
            return unwrap(
              await commands.listUnfitPropertyValues(
                spaceId,
                key,
                pageParam ?? null,
                PAGINATION_LIMIT,
              ),
            )
          } catch (err) {
            logger.warn('UnfitPropertyValues', 'failed to load values', { key }, err)
            throw err
          }
        },
        initialPageParam: undefined as string | undefined,
        getNextPageParam: (lastPage) => (lastPage.has_more ? lastPage.next_cursor : undefined),
        // Dropped once closed: the next opening reads the values afresh.
        gcTime: 0,
      },
      queryClient,
    )
  if (isPending) return <Spinner label />
  if (isError) {
    return (
      <p role="alert" className="text-destructive">
        {t('spaceMove.valuesFailed')}
      </p>
    )
  }
  const rows = data.pages.flatMap((page) => page.items)
  if (rows.length === 0) {
    return <EmptyState icon={SearchCheck} message={t('propertiesView.unfitNone')} compact />
  }
  return (
    <div className="flex flex-col gap-1">
      <ul className="flex flex-col gap-2">
        {rows.map((row) => (
          <li key={row.block_id} className="flex min-w-0 flex-col">
            <div className="flex min-w-0 items-baseline gap-2">
              <span className="min-w-0 flex-1 truncate">{holderLabel(row)}</span>
              {row.deleted && (
                <span className="shrink-0 text-xs text-muted-foreground">
                  {t('spaceMove.inTrash')}
                </span>
              )}
            </div>
            <div className="flex min-w-0 items-baseline gap-2">
              <span className="min-w-0 truncate font-medium">{row.value}</span>
              <span className="shrink-0 text-xs text-muted-foreground">
                {type === 'select' && row.form === 'text'
                  ? t('propertiesView.unfitNotAnOption')
                  : t('propertiesView.unfitForm', { form: row.form, type })}
              </span>
            </div>
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
