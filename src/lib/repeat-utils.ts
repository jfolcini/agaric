import type { TFunction } from 'i18next'

/**
 * Format a repeat property value into a human-readable label.
 *
 * Translatable strings (the unit names, "every N days/weeks/months", and the
 * "(from completion)" / "(catch-up)" suffixes) are pulled from the i18n
 * bundle so the label can be localized. Non-component callers must obtain a
 * `t` function via `useTranslation()` (in components) or the standalone
 * `t` exported from `src/lib/i18n.ts` (outside React) and forward it here.
 */
export function formatRepeatLabel(value: string, t: TFunction): string {
  const modeSuffix = value.startsWith('.+')
    ? t('repeat.fromCompletionSuffix')
    : value.startsWith('++')
      ? t('repeat.catchUpSuffix')
      : ''
  const interval = value.replace(/^(\.\+|\+\+|\+)/, '')
  const baseLabels: Record<string, string> = {
    daily: t('repeat.daily'),
    weekly: t('repeat.weekly'),
    monthly: t('repeat.monthly'),
    yearly: t('repeat.yearly'),
  }
  if (baseLabels[interval]) return `${baseLabels[interval]}${modeSuffix}`
  // Custom interval: +3d, 2w, etc.
  const match = interval.match(/^(\d+)([dwm])$/)
  if (match) {
    const n = Number.parseInt(match[1] as string, 10)
    const unitKey =
      match[2] === 'd'
        ? 'repeat.everyDays'
        : match[2] === 'w'
          ? 'repeat.everyWeeks'
          : 'repeat.everyMonths'
    return `${t(unitKey, { count: n })}${modeSuffix}`
  }
  return value
}
