/**
 * PropertyRow — a single editable property row (badge + value input + optional
 * remove button).
 *
 * Extracted from `BlockPropertyDrawer` (#761) into its own leaf component so
 * that both `BlockPropertyDrawer` and `BuiltinDateFields` can import it without
 * forming an import cycle (previously `BuiltinDateFields` imported `PropertyRow`
 * back from `BlockPropertyDrawer`, which imported `BuiltinDateFields`).
 *
 * Behaviour is unchanged from the original in-file definition.
 */

import type { LucideIcon } from 'lucide-react'
import { HelpCircle, X } from 'lucide-react'
import type React from 'react'
import { useTranslation } from 'react-i18next'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useDateInput } from '@/hooks/useDateInput'

export interface PropertyRowProps {
  /**
   * The raw property key (e.g. `repeat`, `status`). Used to surface
   * key-specific affordances such as the `repeat` syntax help popover
   * (UX-320). When omitted, no key-specific UI is rendered.
   */
  propKey?: string
  /** Optional icon to display in the badge. When provided, the badge uses icon+text styling; otherwise font-mono. */
  icon?: LucideIcon | undefined
  /** Text displayed inside the badge and as its title attribute. */
  label: string
  /** Current value for the input field (used as defaultValue). */
  value: string
  /** HTML input type (e.g. "date", "text"). Defaults to the browser default (text). */
  inputType?: string
  /** Accessible label for the input element. */
  ariaLabel: string
  /** Optional stable selector applied as `data-testid` on the value input (for E2E specs). */
  testId?: string | undefined
  /** Called with the new value when the input loses focus or Enter is pressed. */
  onSave: (value: string) => void
  /** When provided, renders the X (remove) button. Omit or pass null/undefined to hide it. */
  onRemove?: (() => void) | null | undefined
  /** Accessible label for the remove button. */
  removeAriaLabel?: string
}

// oxlint-disable-next-line eslint/complexity -- refactor deferred to follow-up
export function PropertyRow({
  propKey,
  icon: Icon,
  label,
  value,
  inputType,
  ariaLabel,
  testId,
  onSave,
  onRemove,
  removeAriaLabel,
}: PropertyRowProps): React.ReactElement {
  const { t } = useTranslation()
  const isDate = inputType === 'date'
  const isRepeat = propKey === 'repeat'

  // Date input hook (M-29) — always called, values used only when isDate
  const {
    dateInput,
    datePreview,
    dateError,
    isParsing,
    handleChange: handleDateChange,
    handleBlur: handleDateBlur,
  } = useDateInput({ initialValue: value, onSave: isDate ? onSave : undefined })

  return (
    <div className="grid grid-cols-[auto_1fr_auto] items-center gap-2">
      <Badge
        tone="outline"
        className={
          Icon
            ? 'shrink-0 text-xs max-w-[120px] truncate flex items-center gap-1'
            : 'shrink-0 font-mono text-xs max-w-[120px] truncate'
        }
        title={label}
      >
        {Icon && <Icon className="h-3 w-3" />}
        {label}
      </Badge>
      <div className="flex-1">
        {/* UX-320: when the row is the `repeat` property, wrap the Input
            and a `<Popover>` help trigger in a flex container. For all
            other rows (including dates, where `BuiltinDateFields.test`
            queries `input.parentElement?.querySelector('.text-muted-foreground')`
            to find the preview), keep the bare Input so the existing
            DOM structure stays intact. */}
        {isRepeat ? (
          <div className="flex items-center gap-1">
            <Input
              className="h-7 text-xs flex-1"
              type={isDate ? 'text' : inputType}
              aria-label={ariaLabel}
              {...(testId !== undefined ? { 'data-testid': testId } : {})}
              {...(isDate ? { value: dateInput } : { defaultValue: value })}
              placeholder={isDate ? t('property.datePlaceholder') : undefined}
              onBlur={isDate ? handleDateBlur : (e) => onSave(e.target.value)}
              onChange={isDate ? handleDateChange : undefined}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
              }}
            />
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className="shrink-0 text-muted-foreground"
                  aria-label={t('property.repeatHelpLabel')}
                  data-testid="repeat-help-trigger"
                >
                  <HelpCircle className="h-3.5 w-3.5" aria-hidden="true" />
                </Button>
              </PopoverTrigger>
              <PopoverContent
                className="w-72 text-xs space-y-2"
                align="start"
                aria-label={t('property.repeatHelpPopoverLabel')}
              >
                <p className="font-medium">{t('property.repeatHelpTitle')}</p>
                <dl className="space-y-1">
                  <div>
                    <dt className="font-mono inline">++ </dt>
                    <dd className="inline text-muted-foreground">
                      {t('property.repeatHelpCatchup')}
                    </dd>
                  </div>
                  <div>
                    <dt className="font-mono inline">.+ </dt>
                    <dd className="inline text-muted-foreground">
                      {t('property.repeatHelpFromCompletion')}
                    </dd>
                  </div>
                </dl>
                <p className="text-muted-foreground italic">{t('property.repeatHelpExample')}</p>
              </PopoverContent>
            </Popover>
          </div>
        ) : (
          <Input
            className="h-7 text-xs"
            type={isDate ? 'text' : inputType}
            aria-label={ariaLabel}
            {...(testId !== undefined ? { 'data-testid': testId } : {})}
            {...(isDate ? { value: dateInput } : { defaultValue: value })}
            placeholder={isDate ? t('property.datePlaceholder') : undefined}
            onBlur={isDate ? handleDateBlur : (e) => onSave(e.target.value)}
            onChange={isDate ? handleDateChange : undefined}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
            }}
          />
        )}
        {isDate && isParsing && (
          <p className="text-xs text-muted-foreground mt-0.5">{t('property.dateParsing')}</p>
        )}
        {isDate && datePreview && (
          <p className="text-xs text-muted-foreground mt-0.5">{datePreview}</p>
        )}
        {isDate && dateError && (
          <p className="text-xs text-destructive mt-0.5">{t('property.dateParseError')}</p>
        )}
      </div>
      {onRemove && (
        <Button
          variant="ghost"
          size="icon-xs"
          className="shrink-0 text-muted-foreground hover:text-destructive active:text-destructive active:scale-95"
          aria-label={removeAriaLabel}
          onClick={onRemove}
        >
          <X className="h-3 w-3" />
        </Button>
      )}
    </div>
  )
}
