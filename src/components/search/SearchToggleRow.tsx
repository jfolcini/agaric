/**
 * The match-mode toggles of Search and of find in page (#154, #7040 S12): VS
 * Code's case-sensitive, whole-word and regex modes.
 *
 * Each is an `IconButton` with `aria-pressed`, so its name shows in a tooltip
 * on hover, and on touch with a press-and-hold, where a hover never comes. A
 * pressed toggle is outlined, as `ToggleGroup` marks its choice: the fill alone
 * barely differs from the ground, and the outline is a cue that is not colour.
 *
 * State is owned upstream; this is a pure controlled component.
 */

import { CaseSensitive, type LucideIcon, Regex, WholeWord } from 'lucide-react'
import type React from 'react'
import { useTranslation } from 'react-i18next'

import { IconButton, type IconButtonProps } from '@/components/ui/icon-button'

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
  /** The surface's icon-button size: Search's row is taller than find's strip. */
  size?: IconButtonProps['size']
}

interface ToggleSpec {
  key: keyof SearchToggleState
  labelKey: string
  Icon: LucideIcon
  testId: string
}

const TOGGLES: ReadonlyArray<ToggleSpec> = [
  {
    key: 'caseSensitive',
    labelKey: 'search.toggle.caseSensitive',
    Icon: CaseSensitive,
    testId: 'search-toggle-case-sensitive',
  },
  {
    key: 'wholeWord',
    labelKey: 'search.toggle.wholeWord',
    Icon: WholeWord,
    testId: 'search-toggle-whole-word',
  },
  {
    key: 'isRegex',
    labelKey: 'search.toggle.regex',
    Icon: Regex,
    testId: 'search-toggle-regex',
  },
]

export function SearchToggleRow({
  toggles,
  onChange,
  disabled,
  size = 'icon',
}: SearchToggleRowProps): React.ReactElement {
  const { t } = useTranslation()

  return (
    <fieldset
      aria-label={t('search.toggle.toolbarLabel')}
      data-testid="search-toggle-row"
      className="inline-flex items-center gap-0.5"
    >
      {TOGGLES.map(({ key, labelKey, Icon, testId }) => {
        const pressed = toggles[key]
        const label = t(labelKey)
        return (
          <IconButton
            key={key}
            type="button"
            variant="ghost"
            size={size}
            aria-pressed={pressed}
            ariaLabel={label}
            tooltip={label}
            disabled={disabled}
            data-testid={testId}
            onClick={() => onChange({ ...toggles, [key]: !pressed })}
            className="border border-transparent text-muted-foreground aria-pressed:border-foreground aria-pressed:bg-secondary aria-pressed:text-foreground"
          >
            <Icon aria-hidden="true" />
          </IconButton>
        )
      })}
    </fieldset>
  )
}
