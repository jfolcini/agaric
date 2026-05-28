/**
 * Date-related slash commands: `/date`, `/due`, `/schedule`, `/repeat-until`.
 *
 * Each handler opens the date picker in a different mode. State for the
 * picker (`open`, `mode`, `cursorPos`) is owned by the caller and reached
 * through `ctx`, so this sub-hook holds no React state of its own — it just
 * exposes a stable, memoised dispatch slice.
 */

import { useMemo } from 'react'

import { openDatePicker } from './helpers'
import type { SlashHandlerTables } from './types'

export function useSlashCommandDate(): SlashHandlerTables {
  return useMemo<SlashHandlerTables>(
    () => ({
      exact: {
        date: (ctx) => openDatePicker(ctx, 'date'),
        due: (ctx) => openDatePicker(ctx, 'due'),
        schedule: (ctx) => openDatePicker(ctx, 'schedule'),
        'repeat-until': (ctx) => openDatePicker(ctx, 'repeat-until'),
      },
      prefix: [],
    }),
    [],
  )
}
