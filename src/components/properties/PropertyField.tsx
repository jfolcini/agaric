/**
 * PropertyField — a single editable property row (name label + value input + optional
 * remove button).
 *
 * Named for its role (an editable field for one property) to disambiguate from
 * the generated wire type `PropertyRow` (lib/tauri) and the typed dispatcher
 * `PropertyRowEditor` (see #2257).
 *
 * Extracted from `BlockPropertyDrawer` (#761) into its own leaf component so
 * that both `BlockPropertyDrawer` and `BuiltinDateFields` can import it without
 * forming an import cycle (previously `BuiltinDateFields` imported this field
 * back from `BlockPropertyDrawer`, which imported `BuiltinDateFields`).
 *
 * Behaviour is unchanged from the original in-file definition.
 */

import type { LucideIcon } from 'lucide-react'
import { X } from 'lucide-react'
import type React from 'react'
import { useTranslation } from 'react-i18next'

import { UnfitValueMark } from '@/components/properties/UnfitValueMark'
import { Button } from '@/components/ui/button'
import { InfoPopover } from '@/components/ui/info-popover'
import { Input } from '@/components/ui/input'
import { TruncatedText } from '@/components/ui/truncated-text'
import { useDateInput } from '@/hooks/useDateInput'
import { cn } from '@/lib/utils'

export interface PropertyFieldProps {
  /**
   * The raw property key (e.g. `repeat`, `status`). Used to surface
   * key-specific affordances such as the `repeat` syntax help popover
   *. When omitted, no key-specific UI is rendered.
   */
  propKey?: string
  /** Optional icon before the label. Without one the label is a raw key, set in mono. */
  icon?: LucideIcon | undefined
  /** The property's name, shown as the row's label. */
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
  /** The value doesn't fit its key's definition (#6206): the field carries a mark. */
  unfit?: boolean | undefined
}

export function PropertyField({
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
  unfit = false,
}: PropertyFieldProps): React.ReactElement {
  const { t } = useTranslation()
  const isDate = inputType === 'date'
  const isRepeat = propKey === 'repeat'

  // Date input hook — always called, values used only when isDate
  const {
    inputValue: dateValue,
    datePreview,
    dateError,
    isParsing,
    handleChange: handleDateChange,
    handleBlur: handleDateBlur,
    handleFocus: handleDateFocus,
  } = useDateInput({ initialValue: value, onSave: isDate ? onSave : undefined })

  const input = (
    <Input
      className={cn('h-7 text-xs', (isRepeat || unfit) && 'flex-1')}
      type={isDate ? 'text' : inputType}
      aria-label={ariaLabel}
      {...(testId !== undefined ? { 'data-testid': testId } : {})}
      {...(isDate ? { value: dateValue, onFocus: handleDateFocus } : { defaultValue: value })}
      placeholder={isDate ? t('property.datePlaceholder') : undefined}
      onBlur={isDate ? handleDateBlur : (e) => onSave(e.target.value)}
      onChange={isDate ? handleDateChange : undefined}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
      }}
    />
  )
  const mark = unfit && propKey !== undefined && <UnfitValueMark propKey={propKey} value={value} />

  return (
    <div className="grid grid-cols-[auto_1fr_auto] items-center gap-2">
      {/* A plain label, not a chip: a bordered name read as a button (#7040 O7). */}
      <PropertyFieldLabel icon={Icon} label={label} />
      <div className="flex-1">
        {/* when the row is the `repeat` property, wrap the Input
            and its ⓘ help trigger in a flex container, as a value
            that doesn't fit wraps it with its mark. For all other rows
            (including dates, where `BuiltinDateFields.test` queries
            `input.parentElement?.querySelector('.text-muted-foreground')`
            to find the preview), keep the bare Input so the existing
            DOM structure stays intact. */}
        {isRepeat ? (
          <div className="flex items-center gap-1">
            {input}
            <InfoPopover
              variant="icon"
              ariaLabel={t('property.repeatHelpLabel')}
              content={
                <div className="w-72 space-y-2 text-xs">
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
                </div>
              }
            />
            {mark}
          </div>
        ) : unfit ? (
          <div className="flex items-center gap-1">
            {input}
            {mark}
          </div>
        ) : (
          input
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

/** A property row's name: muted text, with the built-in's icon or, for a raw key, in mono. */
export function PropertyFieldLabel({
  icon: Icon,
  label,
}: {
  icon?: LucideIcon | undefined
  label: string
}): React.ReactElement {
  return (
    <span
      data-slot="property-label"
      className={cn(
        'flex min-w-0 max-w-[120px] shrink-0 items-center gap-1 text-xs text-muted-foreground',
        !Icon && 'font-mono',
      )}
    >
      {Icon && <Icon className="h-3 w-3 shrink-0" />}
      <TruncatedText>{label}</TruncatedText>
    </span>
  )
}
