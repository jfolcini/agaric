/**
 * PEND-55 — Search toggle row.
 *
 * Three `<button aria-pressed>` toggles next to the search input — VS
 * Code's `Aa` / `Ab|` / `.*` family for case-sensitive, whole-word, and
 * regex modes. Each toggle has a `lucide-react` icon, a tooltip via the
 * shared `Tooltip` primitive, and a 44px hit area on coarse pointers
 * (AGENTS.md a11y invariant).
 *
 * State is owned upstream; this is a pure controlled component. Tests
 * exercise:
 *   - `aria-pressed` flips on click;
 *   - `role="toolbar"` on the container;
 *   - each toggle exposes its tooltip text as an `aria-label`;
 *   - the three icons render distinct DOM (so screenshot regressions
 *     can detect a swap).
 *
 * No `dangerouslySetInnerHTML`; icons come from `lucide-react`.
 */

import { CaseSensitive, Regex, WholeWord } from 'lucide-react'
import type React from 'react'
import { useTranslation } from 'react-i18next'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
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
  testId: string
  Icon: React.ComponentType<React.SVGProps<SVGSVGElement>>
}

const TOGGLES: ReadonlyArray<ToggleSpec> = [
  {
    key: 'caseSensitive',
    labelKey: 'search.toggle.caseSensitive',
    testId: 'search-toggle-case-sensitive',
    Icon: CaseSensitive,
  },
  {
    key: 'wholeWord',
    labelKey: 'search.toggle.wholeWord',
    testId: 'search-toggle-whole-word',
    Icon: WholeWord,
  },
  {
    key: 'isRegex',
    labelKey: 'search.toggle.regex',
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
    <TooltipProvider delayDuration={200}>
      <div
        role="toolbar"
        aria-label={t('search.toggle.toolbarLabel')}
        data-testid="search-toggle-row"
        className="inline-flex items-center gap-1 rounded-md border border-input bg-background p-0.5"
      >
        {TOGGLES.map(({ key, labelKey, testId, Icon }) => {
          const pressed = toggles[key]
          const label = t(labelKey)
          return (
            <Tooltip key={key}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-pressed={pressed}
                  aria-label={label}
                  title={label}
                  disabled={disabled}
                  data-testid={testId}
                  data-state={pressed ? 'on' : 'off'}
                  onClick={() => onChange({ ...toggles, [key]: !pressed })}
                  className={cn(
                    'inline-flex items-center justify-center rounded-sm px-2 py-1',
                    // Coarse-pointer hit area
                    '[@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11',
                    'text-muted-foreground transition-colors',
                    'hover:bg-accent hover:text-accent-foreground',
                    'focus-ring-visible',
                    pressed && 'bg-secondary text-foreground shadow-sm',
                    'disabled:pointer-events-none disabled:opacity-50',
                  )}
                >
                  <Icon className="h-4 w-4" aria-hidden="true" />
                </button>
              </TooltipTrigger>
              <TooltipContent>{label}</TooltipContent>
            </Tooltip>
          )
        })}
      </div>
    </TooltipProvider>
  )
}
