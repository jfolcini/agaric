/**
 * SpaceAccentPicker — 6-swatch accent-color grid for an existing space.
 *
 * Extracted from `SpaceRowEditor` (D-2). Click writes a
 * `setProperty(accent_color, token)` op against the space block. The
 * selection state is local — the parent's only concern is providing
 * `spaceId`; nothing flows back up because the accent token is not
 * surfaced anywhere outside the dialog (`refreshAvailableSpaces`
 * picks it up via the next `list_spaces` call).
 *
 * Behaviour preservation contract:
 *  - Optimistic update: local `accent` flips immediately on click.
 *  - On IPC failure the previous selection is restored and a
 *    `space.accentFailed` toast surfaces.
 *  - During the in-flight save every swatch is `disabled` to prevent
 *    a double-click race.
 */

import { Check } from 'lucide-react'
import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'
import { setProperty } from '@/lib/tauri'
import { cn } from '@/lib/utils'

const LOG_MODULE = 'components/SpaceManageDialog/SpaceAccentPicker'

/**
 * Palette tokens consumed by. Stored verbatim in the
 * `accent_color` property; the visual identity layer maps them to
 * concrete CSS custom properties at render time. Kept in module scope
 * so tests can import the same source of truth without duplication.
 */
export const ACCENT_SWATCHES = [
  { token: 'accent-emerald', label: 'emerald' },
  { token: 'accent-blue', label: 'blue' },
  { token: 'accent-violet', label: 'violet' },
  { token: 'accent-amber', label: 'amber' },
  { token: 'accent-rose', label: 'rose' },
  { token: 'accent-slate', label: 'slate' },
] as const

export type AccentToken = (typeof ACCENT_SWATCHES)[number]['token']

interface SpaceAccentPickerProps {
  spaceId: string
  /**
   * The space's already-saved accent token (`SpaceRow.accent_color`), or
   * `null`/`undefined` if unset. Hydrates the initial selection so the
   * matching swatch shows `aria-pressed=true` + the Check icon on mount.
   * Unrecognised tokens (palette drift) hydrate to "no selection".
   */
  initialAccent?: string | null
}

function asAccentToken(value: string | null | undefined): AccentToken | null {
  return ACCENT_SWATCHES.some((s) => s.token === value) ? (value as AccentToken) : null
}

export function SpaceAccentPicker({
  spaceId,
  initialAccent,
}: SpaceAccentPickerProps): React.JSX.Element {
  const { t } = useTranslation()
  const [accent, setAccent] = useState<AccentToken | null>(() => asAccentToken(initialAccent))
  const [savingAccent, setSavingAccent] = useState(false)

  const handleAccentClick = useCallback(
    async (token: AccentToken) => {
      setSavingAccent(true)
      const previous = accent
      setAccent(token)
      try {
        await setProperty({
          blockId: spaceId,
          key: 'accent_color',
          valueText: token,
        })
      } catch (err) {
        logger.error(LOG_MODULE, 'accent color update failed', { spaceId }, err)
        notify.error(t('space.accentFailed'))
        setAccent(previous)
      } finally {
        setSavingAccent(false)
      }
    },
    [accent, spaceId, t],
  )

  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-muted-foreground">{t('space.accentColorLabel')}:</span>
      {/* oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- toolbar-like group of swatch buttons; <fieldset>/<optgroup> etc. break the flex layout and add unwanted form/list semantics */}
      <div className="flex flex-wrap gap-1.5" role="group" aria-label={t('space.accentColorLabel')}>
        {ACCENT_SWATCHES.map((swatch) => (
          <button
            key={swatch.token}
            type="button"
            aria-label={t('space.accentSwatchLabel', { color: swatch.label })}
            aria-pressed={accent === swatch.token}
            disabled={savingAccent}
            onClick={() => void handleAccentClick(swatch.token)}
            className={cn(
              'inline-flex items-center justify-center rounded-full ring-offset-background transition-all',
              'h-5 w-5 [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11',
              'focus-ring-visible',
              'disabled:opacity-50 disabled:cursor-not-allowed',
              accent === swatch.token && 'ring-2 ring-ring ring-offset-2',
            )}
            style={{ backgroundColor: `var(--${swatch.token})` }}
            data-accent-token={swatch.token}
          >
            {/* surface selection with an icon, not just a ring,
             * so colour-blind users can identify the active swatch.
             * White text + bold stroke + dark drop-shadow guarantees
             * WCAG AA contrast on every palette fill (incl. amber-500
             * and violet-500 where plain `text-white` falls below 4.5:1). */}
            {accent === swatch.token ? (
              <Check
                className="h-3 w-3 text-white drop-shadow-(--shadow-accent-stroke)"
                strokeWidth={3}
                aria-hidden="true"
              />
            ) : null}
          </button>
        ))}
      </div>
    </div>
  )
}
