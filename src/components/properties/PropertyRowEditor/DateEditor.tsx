/**
 * DateEditor — renders a text input that accepts natural-language dates
 * plus a live preview line. Bound to the shared `date` slice of the
 * `usePropertyRowEditor` hook (which wraps `useDateInput`).
 */

import { useTranslation } from 'react-i18next'

import { Input } from '@/components/ui/input'

import type { DateEditorState } from './usePropertyRowEditor'

export interface DateEditorProps {
  state: DateEditorState
  ariaLabel: string
}

export function DateEditor({ state, ariaLabel }: DateEditorProps) {
  const { t } = useTranslation()
  const { dateInput, datePreview, handleChange, handleBlur } = state
  return (
    <>
      <Input
        className="h-7 text-xs"
        type="text"
        value={dateInput}
        placeholder={t('property.datePlaceholder')}
        onChange={handleChange}
        onBlur={handleBlur}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        }}
        aria-label={ariaLabel}
      />
      {datePreview && <p className="text-xs text-muted-foreground mt-0.5">{datePreview}</p>}
    </>
  )
}
