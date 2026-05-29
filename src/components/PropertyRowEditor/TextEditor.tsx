/**
 * TextEditor — renders a single-line text input bound to the shared
 * `textLike` slice of the `usePropertyRowEditor` hook.
 */

import { Input } from '@/components/ui/input'

import type { TextLikeEditorState } from './usePropertyRowEditor'

export interface TextEditorProps {
  state: TextLikeEditorState
  ariaLabel: string
}

export function TextEditor({ state, ariaLabel }: TextEditorProps) {
  const { localValue, handleChange, handleBlur } = state
  return (
    <Input
      className="h-7 text-xs"
      type="text"
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
