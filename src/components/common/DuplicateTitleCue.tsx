/**
 * DuplicateTitleCue — creation-date cue for a row whose title another
 * page in the same view also carries (#4709).
 *
 * Two rows both reading `Agaric` are worse than one if the user cannot
 * tell which is which. Every other candidate cue is unavailable or
 * useless here: the breadcrumb is identical by construction (duplicates
 * share a `fullPath`), the child count is usually 0 on both, and the
 * page id is a 26-char ULID. The creation date is the one property that
 * genuinely differs, and it is free — it is encoded in the ULID itself,
 * so no extra query and no extra prop plumbing is needed (the same
 * decode `PageMetadataBar` already does).
 *
 * Rendered ONLY on nodes/rows `buildPageTree` marked as duplicates, so
 * the overwhelmingly common unique-title row is visually unchanged, and
 * at EVERY density: this is identity, not metadata, so hiding it behind
 * a tooltip would leave the compact list ambiguous.
 *
 * `null` for a non-ULID id (the create form's optimistic inserts), so
 * nothing renders rather than a placeholder date that would itself
 * mislead.
 *
 * Date AND time, not date alone. A cue that cannot tell two rows apart is
 * worse than no cue — it looks like an answer. ULIDs are millisecond
 * precision, so the timestamp separates a same-day cohort too: the vault
 * this was built against holds 15 pages titled `2026-05-05`, and a
 * date-only cue would have given at most a handful of distinct labels
 * across all 15.
 *
 * It still reads oddly on a date-titled page — `2026-05-05` next to
 * `May 7, 2026, 14:32` is two dates side by side, and the title is the
 * one that matters. That is inherent to disambiguating date-named pages
 * by creation time, and the alternative is leaving them indistinguishable.
 */

import type React from 'react'
import { useTranslation } from 'react-i18next'

import { formatTimestamp, ulidToDate } from '@/lib/format'
import { cn } from '@/lib/utils'

export function DuplicateTitleCue({
  pageId,
  className,
}: {
  pageId: string
  className?: string
}): React.ReactElement | null {
  const { t } = useTranslation()
  const created = ulidToDate(pageId)
  if (created === null) return null
  const label = formatTimestamp(created.getTime(), 'full')
  return (
    <span
      data-duplicate-title-cue
      className={cn('shrink-0 text-xs text-muted-foreground', className)}
      title={t('metadata.created', { date: label })}
    >
      {label}
    </span>
  )
}
