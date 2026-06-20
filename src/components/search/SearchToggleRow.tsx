/**
 * Search toggle row (#154).
 *
 * Three `<button aria-pressed>` toggles next to the search input — VS
 * Code's `Aa` / `Ab|` / `.*` family for case-sensitive, whole-word, and
 * regex modes. Each toggle pairs a `lucide-react` icon with an
 * always-visible abbreviation label and a 44px hit area on coarse
 * pointers (AGENTS.md a11y invariant).
 *
 * #154 the abbreviation is rendered as visible text rather than
 * relying on a hover tooltip: Radix tooltips don't fire on touch-tap, so
 * a touch user got no explanation of an icon-only control. The visible
 * label makes each mode self-evident without any hover/long-press
 * affordance; the full localised name stays on `aria-label` (screen
 * readers) and the native `title` (desktop hover), so no information is
 * lost for pointer users.
 *
 * State is owned upstream; this is a pure controlled component. Tests
 * exercise:
 *   - `aria-pressed` flips on click;
 *   - `role="toolbar"` on the container;
 *   - each toggle exposes its full label as an `aria-label`;
 *   - each toggle shows its visible abbreviation text;
 *   - the three icons render distinct DOM (so screenshot regressions
 *     can detect a swap).
 *
 * No `dangerouslySetInnerHTML`; icons come from `lucide-react`.
 */

import { CaseSensitive, Regex, WholeWord } from 'lucide-react'
import type React from 'react'
import { useTranslation } from 'react-i18next'

import { cn } from '@/lib/utils'

export interface SearchToggleState {
  caseSensitive: boolean
  wholeWord: boolean
  isRegex: boolean
}

export interface SearchToggleRowProps {
  toggles: SearchToggleState
  /** Called with the next state value when the user clicks a toggle. */
  onChange: (next: SearchToggleState) => void
  /** Optional disable while the input is empty / sanitising. */
  disabled?: boolean
}

interface ToggleSpec {
  key: keyof SearchToggleState
  labelKey: string
  /** Always-visible abbreviation (VS Code's `Aa` / `Ab|` / `.*`). */
  abbr: string
  testId: string
  Icon: React.ComponentType<React.SVGProps<SVGSVGElement>>
}

const TOGGLES: ReadonlyArray<ToggleSpec> = [
  {
    key: 'caseSensitive',
    labelKey: 'search.toggle.caseSensitive',
    abbr: 'Aa',
    testId: 'search-toggle-case-sensitive',
    Icon: CaseSensitive,
  },
  {
    key: 'wholeWord',
    labelKey: 'search.toggle.wholeWord',
    abbr: 'Ab|',
    testId: 'search-toggle-whole-word',
    Icon: WholeWord,
  },
  {
    key: 'isRegex',
    labelKey: 'search.toggle.regex',
    abbr: '.*',
    testId: 'search-toggle-regex',
    Icon: Regex,
  },
]

export function SearchToggleRow({
  toggles,
  onChange,
  disabled,
}: SearchToggleRowProps): React.ReactElement {
  const { t } = useTranslation()

  return (
    <div
      role="toolbar"
      aria-label={t('search.toggle.toolbarLabel')}
      data-testid="search-toggle-row"
      className="inline-flex items-center gap-1 rounded-md border border-input bg-background p-0.5"
    >
      {TOGGLES.map(({ key, labelKey, abbr, testId, Icon }) => {
        const pressed = toggles[key]
        const label = t(labelKey)
        return (
          <button
            key={key}
            type="button"
            aria-pressed={pressed}
            aria-label={label}
            // Native title gives pointer users the full name on hover.
            // This is NOT the Radix tooltip the old design relied on —
            // the visible abbreviation below is the touch-safe affordance.
            title={label}
            disabled={disabled}
            data-testid={testId}
            data-state={pressed ? 'on' : 'off'}
            onClick={() => onChange({ ...toggles, [key]: !pressed })}
            className={cn(
              'relative inline-flex items-center justify-center gap-1 rounded-sm px-2 py-1',
              // Coarse-pointer hit area
              '[@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11',
              'text-muted-foreground transition-colors',
              'hover:bg-accent hover:text-accent-foreground',
              'focus-ring-visible',
              // The active toggle was previously cued ONLY by a
              // low-contrast fill + subtle shadow (a colour-only signal).
              // Add a non-colour cue: a visible inset ring (a shape/border
              // change) on the pressed state so the active mode is
              // distinguishable independent of colour perception. The
              // small dot below the icon is a second, redundant
              // shape-only indicator.
              pressed && 'bg-secondary text-foreground shadow-sm ring-1 ring-inset ring-ring',
              'disabled:pointer-events-none disabled:opacity-50',
            )}
          >
            <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
            {/* #154 always-visible abbreviation, so the mode is
                legible on touch with no tooltip/long-press. aria-hidden
                because the button already has the full `aria-label`. */}
            <span
              aria-hidden="true"
              data-testid={`${testId}-abbr`}
              className="font-mono text-xs leading-none"
            >
              {abbr}
            </span>
            {/* shape-only active indicator (no colour reliance):
                a small dot renders only while the toggle is pressed. */}
            {pressed && (
              <span
                aria-hidden="true"
                data-testid={`${testId}-active-dot`}
                className="pointer-events-none absolute bottom-0.5 left-1/2 h-1 w-1 -translate-x-1/2 rounded-full bg-current"
              />
            )}
          </button>
        )
      })}
    </div>
  )
}
