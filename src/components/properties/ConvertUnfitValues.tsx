/**
 * ConvertUnfitValues -- the Convert step of the "don't fit" review (#6206).
 * Each distinct value that doesn't fit, the Trash's included, gets an input
 * that matches the key's type; `convert_unfit_property_values` replaces the
 * values given one, in one op the toast can undo, and an empty input leaves
 * its value as it is. A value that doesn't fit is by construction one the
 * type cannot read, so only the user can say what it becomes; a text or url
 * key can hold any text, so its inputs start from the value itself. Each
 * value sends the counts it showed as its acknowledgement; when the backend
 * refuses that, the step says so and reads the values again, keeping what
 * was typed for each value.
 */

import { useInfiniteQuery } from '@tanstack/react-query'
import { SearchCheck } from 'lucide-react'
import type React from 'react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { EmptyState } from '@/components/common/EmptyState'
import { LoadMoreButton } from '@/components/common/LoadMoreButton'
import { parseSelectOptions } from '@/components/properties/PropertyRowEditor/shared'
import { Button } from '@/components/ui/button'
import { DialogBody } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Spinner } from '@/components/ui/spinner'
import { useDialogOrSheet } from '@/components/ui/use-dialog-or-sheet'
import { unwrap, validationCode } from '@/lib/app-error'
import type {
  DistinctUnfitValue,
  PageResponse,
  PropertyDefinition,
  PropertyUnfitCounts,
  WithOps,
} from '@/lib/bindings'
import { commands } from '@/lib/bindings'
import { PAGINATION_LIMIT } from '@/lib/constants'
import { logger } from '@/lib/logger'
import { queryClient } from '@/lib/query-client'
import { reportIpcErrorWithReason } from '@/lib/report-ipc-error'
import { ValidationCode } from '@/lib/search-query/validation-codes'

export interface ConvertUnfitValuesProps {
  definition: PropertyDefinition
  spaceId: string
  onBack: () => void
  /** The values changed since they were shown: the review counts them again. */
  onChanged: () => void
  onDone: (converted: WithOps<PropertyUnfitCounts>) => void
}

interface Choice {
  value: string
  label: string
}

export function ConvertUnfitValues({
  definition,
  spaceId,
  onBack,
  onChanged,
  onDone,
}: ConvertUnfitValuesProps): React.ReactElement {
  const { t } = useTranslation()
  const { isMobile, Footer } = useDialogOrSheet('dialog')
  const { key, value_type: type } = definition
  // What was typed for each value, by value, so a reading again keeps it.
  const [drafts, setDrafts] = useState<Readonly<Record<string, string>>>({})
  // Asked again: the values changed after the user saw them.
  const [askedAgain, setAskedAgain] = useState(false)
  const [writing, setWriting] = useState(false)
  // Bumped when the values are read again.
  const [readSeq, setReadSeq] = useState(0)
  const { data, isPending, isError, hasNextPage, fetchNextPage, isFetchingNextPage } =
    useInfiniteQuery(
      {
        queryKey: ['distinctUnfitPropertyValues', spaceId, key, readSeq],
        queryFn: async ({ pageParam }): Promise<PageResponse<DistinctUnfitValue>> => {
          try {
            return unwrap(
              await commands.listDistinctUnfitPropertyValues(
                spaceId,
                key,
                pageParam ?? null,
                PAGINATION_LIMIT,
              ),
            )
          } catch (err) {
            logger.warn('ConvertUnfitValues', 'failed to load values', { key }, err)
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
  const groups = data?.pages.flatMap((page) => page.items) ?? []
  const choices = choicesFor(definition, t)
  const takesAnyText = choices === null && (type === 'text' || type === 'url' || type === 'select')
  const draftOf = (value: string): string => drafts[value] ?? (takesAnyText ? value : '')
  const mapped = groups.filter((group) => draftOf(group.value) !== '')
  const blocks = mapped.reduce((sum, group) => sum + group.unfit + group.unfit_in_trash, 0)

  const convert = async (): Promise<void> => {
    setWriting(true)
    try {
      const replacements = mapped.map((group) => ({
        value: group.value,
        replacement: draftOf(group.value),
        acknowledged: { unfit: group.unfit, unfit_in_trash: group.unfit_in_trash },
      }))
      onDone(unwrap(await commands.convertUnfitPropertyValues(spaceId, key, replacements)))
    } catch (error) {
      if (validationCode(error) === ValidationCode.UnacknowledgedPropertyLoss) {
        setAskedAgain(true)
        setReadSeq((seq) => seq + 1)
        onChanged()
      } else {
        reportIpcErrorWithReason('ConvertUnfitValues', 'propertiesView.convertFailed', error, t, {
          key,
        })
      }
    } finally {
      setWriting(false)
    }
  }

  const list = (): React.ReactElement => {
    if (isPending) return <Spinner label />
    if (isError) {
      return (
        <p role="alert" className="text-destructive">
          {t('spaceMove.valuesFailed')}
        </p>
      )
    }
    if (groups.length === 0) {
      return <EmptyState icon={SearchCheck} message={t('propertiesView.unfitNone')} compact />
    }
    return (
      <div className="flex flex-col gap-1">
        <ul className="flex flex-col gap-3">
          {groups.map((group) => (
            <li key={group.value} className="flex min-w-0 flex-col gap-1">
              <div className="flex min-w-0 items-baseline gap-2">
                <span className="min-w-0 flex-1 truncate font-medium">{group.value}</span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {countsLabel(group, t)}
                </span>
              </div>
              <ReplacementInput
                label={t('propertiesView.convertReplacementLabel', { value: group.value })}
                type={type}
                choices={choices}
                draft={draftOf(group.value)}
                onDraft={(draft) => setDrafts((prev) => ({ ...prev, [group.value]: draft }))}
              />
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

  const body = (
    <div className="space-y-3 text-sm">
      {askedAgain && (
        <p role="alert" className="text-destructive">
          {t('propertiesView.typeChangeCountsChanged')}
        </p>
      )}
      {list()}
      <p>{t('propertiesView.convertSummary', { count: blocks })}</p>
    </div>
  )

  return (
    <>
      {isMobile ? body : <DialogBody>{body}</DialogBody>}
      <Footer>
        <Button variant="outline" onClick={onBack}>
          {t('nav.back')}
        </Button>
        <Button
          disabled={mapped.length === 0 || writing}
          onClick={() => {
            // `convert` reports its own failure; never rejects.
            void convert()
          }}
        >
          {t('propertiesView.convertConfirm', { count: blocks })}
        </Button>
      </Footer>
    </>
  )
}

type Translate = ReturnType<typeof useTranslation>['t']

/** A boolean's two values, or a select's options; null when the key takes typed text. */
function choicesFor(definition: PropertyDefinition, t: Translate): Choice[] | null {
  if (definition.value_type === 'boolean') {
    return [
      { value: 'true', label: t('property.booleanTrue') },
      { value: 'false', label: t('property.booleanFalse') },
    ]
  }
  const options = parseSelectOptions(definition)
  return options.length > 0 ? options.map((option) => ({ value: option, label: option })) : null
}

function countsLabel(group: DistinctUnfitValue, t: Translate): string {
  return [
    group.unfit > 0 ? t('propertiesView.convertBlocks', { count: group.unfit }) : null,
    group.unfit_in_trash > 0
      ? t('propertiesView.convertInTrash', { count: group.unfit_in_trash })
      : null,
  ]
    .filter((part) => part !== null)
    .join(', ')
}

interface ReplacementInputProps {
  label: string
  type: string
  choices: Choice[] | null
  draft: string
  onDraft: (draft: string) => void
}

/** A choice among `choices` and Leave as it is, or an input for the type's text. */
function ReplacementInput({
  label,
  type,
  choices,
  draft,
  onDraft,
}: ReplacementInputProps): React.ReactElement {
  const { t } = useTranslation()
  if (choices === null) {
    return (
      <Input
        aria-label={label}
        type={type === 'date' ? 'date' : 'text'}
        inputMode={type === 'number' ? 'decimal' : undefined}
        value={draft}
        onChange={(e) => onDraft(e.target.value)}
      />
    )
  }
  // Picked by place: Radix takes no empty value, and an option may read like any sentinel.
  const items = [{ value: '', label: t('propertiesView.convertLeave') }, ...choices]
  const picked = Math.max(
    0,
    items.findIndex((item) => item.value === draft),
  )
  return (
    <Select value={String(picked)} onValueChange={(i) => onDraft(items[Number(i)]?.value ?? '')}>
      <SelectTrigger aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {items.map((item, i) => (
          <SelectItem key={item.value} value={String(i)}>
            {item.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
