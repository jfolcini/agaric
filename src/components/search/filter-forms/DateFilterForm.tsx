/**
 * PEND-58g UX-A5 — `due:` / `scheduled:` builder form (no not- variant).
 *
 * Two shapes, selectable via a mode toggle:
 *  - Named bucket — `DATE_BUCKET_VALUES` (today / overdue / …); emits
 *    `{ value: { kind: 'named', name }, raw: name }`.
 *  - Comparison — a `DateOp` (`<` / `<=` / `=` / `>=` / `>`) + an ISO
 *    `YYYY-MM-DD` date; emits `{ value: { kind: 'op', op, date }, raw:
 *    `${op}${date}` }`.
 *
 * The emitted token's `raw` mirrors the parser/serialiser canonical form
 * exactly (see `tokenSource` / `register.ts`).
 */

import type React from 'react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { DATE_BUCKET_VALUES } from '@/hooks/useAutocompleteSources'
import type { DateOp, FilterToken, NamedDateRange } from '@/lib/search-query'

const DATE_OPS: readonly DateOp[] = ['<', '<=', '=', '>=', '>'] as const

export interface DateFilterFormProps {
  /** Which token kind to build — `due` or `scheduled`. */
  kind: 'due' | 'scheduled'
  onAddFilter: (token: FilterToken) => void
  onBack: () => void
}

export function DateFilterForm({
  kind,
  onAddFilter,
  onBack,
}: DateFilterFormProps): React.ReactElement {
  const { t } = useTranslation()
  const [shape, setShape] = useState<'bucket' | 'op'>('bucket')
  const [bucket, setBucket] = useState<NamedDateRange>(DATE_BUCKET_VALUES[0])
  const [op, setOp] = useState<DateOp>('=')
  const [date, setDate] = useState('')

  // PEND-58g UX-A5 — move focus into the sub-form on open (see StateFilterForm).
  const shapeRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    shapeRef.current?.focus()
  }, [])

  const categoryLabel =
    kind === 'due' ? t('search.filterCategory.due') : t('search.filterCategory.scheduled')

  const canSubmit = shape === 'bucket' || date.trim() !== ''

  function submit() {
    if (shape === 'bucket') {
      const token: FilterToken = {
        kind,
        value: { kind: 'named', name: bucket },
        raw: bucket,
        span: [0, 0],
      }
      onAddFilter(token)
      return
    }
    const trimmed = date.trim()
    if (!trimmed) return
    const token: FilterToken = {
      kind,
      value: { kind: 'op', op, date: trimmed },
      raw: `${op}${trimmed}`,
      span: [0, 0],
    }
    onAddFilter(token)
  }

  return (
    <form
      data-testid="date-filter-form"
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
    >
      <div className="text-sm font-medium">{categoryLabel}</div>
      <div className="mt-2 flex flex-col gap-2">
        <Select value={shape} onValueChange={(v) => setShape(v as 'bucket' | 'op')}>
          <SelectTrigger
            ref={shapeRef}
            size="sm"
            aria-label={t('search.filterHelper.dateShapeLabel')}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="bucket">{t('search.filterHelper.dateShapeBucket')}</SelectItem>
            <SelectItem value="op">{t('search.filterHelper.dateShapeOp')}</SelectItem>
          </SelectContent>
        </Select>

        {shape === 'bucket' ? (
          <Select value={bucket} onValueChange={(v) => setBucket(v as NamedDateRange)}>
            <SelectTrigger size="sm" aria-label={t('search.filterHelper.dateBucketLabel')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {DATE_BUCKET_VALUES.map((b) => (
                <SelectItem key={b} value={b}>
                  {b}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <div className="flex gap-2">
            <Select value={op} onValueChange={(v) => setOp(v as DateOp)}>
              <SelectTrigger
                size="sm"
                className="w-20"
                aria-label={t('search.filterHelper.dateOpLabel')}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DATE_OPS.map((o) => (
                  <SelectItem key={o} value={o}>
                    {o}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="flex-1"
              aria-label={t('search.filterHelper.dateValueLabel')}
            />
          </div>
        )}
      </div>
      <div className="mt-2 flex gap-2 justify-end">
        <Button type="button" variant="outline" size="sm" onClick={onBack}>
          {t('search.filterHelper.back')}
        </Button>
        <Button type="submit" size="sm" disabled={!canSubmit}>
          {t('search.filterHelper.add')}
        </Button>
      </div>
    </form>
  )
}
