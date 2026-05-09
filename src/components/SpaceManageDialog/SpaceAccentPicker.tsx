/**
 * SpaceAccentPicker — 6-swatch accent-color grid for an existing space.
 *
 * Extracted from `SpaceRowEditor` (PEND-30 D-2). Click writes a
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
import { toast } from 'sonner'
import { logger } from '@/lib/logger'
import { setProperty } from '@/lib/tauri'
import { cn } from '@/lib/utils'

const LOG_MODULE = 'components/SpaceManageDialog/SpaceAccentPicker'

/**
 * Palette tokens consumed by FEAT-3p10. Stored verbatim in the
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
}

export function SpaceAccentPicker({ spaceId }: SpaceAccentPickerProps): React.JSX.Element {
  const { t } = useTranslation()
  const [accent, setAccent] = useState<AccentToken | null>(null)
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
        toast.error(t('space.accentFailed'))
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
      {/* biome-ignore lint/a11y/useSemanticElements: a swatch picker is not a `<fieldset>`-style form group; `role="group"` + per-button `aria-pressed` is the conventional WAI-ARIA pattern for a single-select toolbar of toggle buttons */}
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
            {/* UX-6 — surface selection with an icon, not just a ring,
             * so colour-blind users can identify the active swatch.
             * White text + bold stroke + dark drop-shadow guarantees
             * WCAG AA contrast on every palette fill (incl. amber-500
             * and violet-500 where plain `text-white` falls below 4.5:1). */}
            {accent === swatch.token ? (
              <Check
                className="h-3 w-3 text-white drop-shadow-[0_0_1.5px_rgb(0_0_0/0.9)]"
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
