/**
 * formatRelativeTime — formats an ISO timestamp as a human-readable relative time string.
 *
 * Uses i18n keys from sidebar.justNow / sidebar.minutesAgo / sidebar.hoursAgo / sidebar.daysAgo.
 */

import type { TFunction } from 'i18next'

/**
 * Format an ISO date string as a relative time.
 *
 * - Less than 60 seconds:  t('sidebar.justNow')
 * - Less than 60 minutes:  t('sidebar.minutesAgo', { count })
 * - Less than 24 hours:    t('sidebar.hoursAgo', { count })
 * - Otherwise:             t('sidebar.daysAgo', { count })
 */
export function formatRelativeTime(isoString: string, t: TFunction): string {
  const now = Date.now()
  const then = new Date(isoString).getTime()
  const diffMs = now - then

  if (diffMs < 0) {
    // Future timestamp — treat as "just now"
    return t('sidebar.justNow')
  }

  const seconds = Math.floor(diffMs / 1000)
  if (seconds < 60) {
    return t('sidebar.justNow')
  }

  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) {
    return t('sidebar.minutesAgo', { count: minutes })
  }

  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    return t('sidebar.hoursAgo', { count: hours })
  }

  const days = Math.floor(hours / 24)
  return t('sidebar.daysAgo', { count: days })
}
