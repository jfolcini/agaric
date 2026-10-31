/**
 * NumberEditor — renders a numeric input bound to the shared `textLike`
 * slice of the `usePropertyRowEditor` hook.
 */

import type { TextLikeEditorState } from '@/components/properties/PropertyRowEditor/usePropertyRowEditor'
import { Input } from '@/components/ui/input'

export interface NumberEditorProps {
  state: TextLikeEditorState
  ariaLabel: string
  /** The stored value is not a number; a number input would show it empty. */
  unfit: boolean
}

export function NumberEditor({ state, ariaLabel, unfit }: NumberEditorProps) {
  const { localValue, handleChange, handleBlur } = state
  return (
    <Input
      className="h-7 text-xs"
      type={unfit ? 'text' : 'number'}
      value={localValue}
      onChange={handleChange}
      onBlur={handleBlur}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
      }}
      aria-label={ariaLabel}
    />
  )
}
