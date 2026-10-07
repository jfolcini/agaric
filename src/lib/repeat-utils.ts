import type { TFunction } from 'i18next'

import { isAppError, unwrap, validationCode } from '@/lib/app-error'
import { commands } from '@/lib/bindings'
import { logger } from '@/lib/logger'
import { ValidationCode } from '@/lib/search-query/validation-codes'

/**
 * #3647 — the backend's actionable reason for rejecting a `repeat` rule, or
 * `null` when this is not that error.
 *
 * The backend validates the recurrence grammar at `set_property` (see
 * `agaric_engine::recurrence::validate_repeat_rule`) and ships the reason as a
 * CODED validation error, whose `message` crosses IPC undecorated. Every
 * property-save surface otherwise collapses failures into one generic toast
 * ("Failed to save property"), which would leave the user exactly as
 * uninformed as the silent misbehaviour the validation replaced. Callers show
 * this string verbatim when it is non-null.
 */
export function invalidRepeatRuleMessage(err: unknown): string | null {
  if (validationCode(err) !== ValidationCode.InvalidRepeatRule) return null
  return isAppError(err) ? err.message : null
}

/**
 * Reload the page after `blockId` moved to DONE, when it carries a `repeat` rule:
 * `set_todo_state` creates the next occurrence as a sibling but reports only the
 * completed block (#5285).
 */
export async function reloadIfRepeating(
  blockId: string,
  pageStore: { getState: () => { load: () => Promise<void> } },
): Promise<void> {
  try {
    const repeat = unwrap(await commands.getProperty(blockId, 'repeat'))
    if (repeat != null) await pageStore.getState().load()
  } catch (err) {
    logger.warn('repeat-utils', 'repeat lookup after DONE failed', { blockId }, err)
  }
}

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
  // Custom interval: +3d, 2w, +2y, etc.
  const match = interval.match(/^(\d+)([dwmy])$/)
  if (match) {
    const n = Number.parseInt(match[1] as string, 10)
    const unitKey =
      match[2] === 'd'
        ? 'repeat.everyDays'
        : match[2] === 'w'
          ? 'repeat.everyWeeks'
          : match[2] === 'm'
            ? 'repeat.everyMonths'
            : 'repeat.everyYears'
    return `${t(unitKey, { count: n })}${modeSuffix}`
  }
  return value
}
