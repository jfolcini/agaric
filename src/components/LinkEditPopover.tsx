/**
 * LinkEditPopover — inline popover for inserting / editing external links.
 *
 * Renders inside a shadcn Popover (managed by FormattingToolbar):
 *  - URL input (auto-focused, placeholder "https://...")
 *  - "Apply" + optional "Remove" button (when editing an existing link)
 *  - Enter applies, Escape cancels
 *  - URLs without a protocol scheme get `https://` prepended automatically
 */

import type { Editor } from '@tiptap/react'
import type React from 'react'
import { useCallback, useState } from 'react'
import { Button } from './ui/button'
import { Input } from './ui/input'

export interface LinkEditPopoverProps {
  editor: Editor
  /** Whether the cursor is inside an existing link (shows Remove button). */
  isEditing: boolean
  /** Pre-filled URL when editing; empty string for new links. */
  initialUrl: string
  /** Close the popover (called after apply, remove, or escape). */
  onClose: () => void
}

/**
 * Normalise a user-entered URL: trim whitespace and prepend `https://`
 * when no protocol scheme is present.
 *
 * Recognises both `scheme://` protocols (http, ftp, …) and
 * schemeless protocols like `mailto:` and `tel:`.
 */
export function normalizeUrl(url: string): string {
  const trimmed = url.trim()
  if (!trimmed) return ''
  // Block dangerous protocols
  const lower = trimmed.toLowerCase()
  if (lower.startsWith('javascript:') || lower.startsWith('data:')) return ''
  // scheme://…  (http://, https://, ftp://, etc.)
  if (/^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(trimmed)) return trimmed
  // mailto: and tel: — no authority component
  if (/^(mailto|tel):/i.test(trimmed)) return trimmed
  return `https://${trimmed}`
}

export function LinkEditPopover({
  editor,
  isEditing,
  initialUrl,
  onClose,
}: LinkEditPopoverProps): React.ReactElement {
  const [url, setUrl] = useState(initialUrl)
  const [urlError, setUrlError] = useState<string | null>(null)

  const handleApply = useCallback(() => {
    const trimmed = url.trim()
    if (!trimmed) {
      editor.commands.focus()
      onClose()
      return
    }
    const normalized = normalizeUrl(url)
    if (!normalized) {
      setUrlError('javascript: and data: URLs are not allowed')
      return
    }
    setUrlError(null)
    editor.chain().focus().setLink({ href: normalized }).run()
    onClose()
  }, [editor, url, onClose])

  const handleRemove = useCallback(() => {
    editor.chain().focus().unsetLink().run()
    onClose()
  }, [editor, onClose])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        handleApply()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        editor.commands.focus()
        onClose()
      }
    },
    [handleApply, editor, onClose],
  )

  return (
    <div className="flex flex-col gap-2" data-testid="link-edit-popover">
      <label htmlFor="link-url-input" className="text-xs font-medium text-muted-foreground">
        URL
      </label>
      <Input
        id="link-url-input"
        type="url"
        placeholder="https://..."
        value={url}
        onChange={(e) => {
          setUrl(e.target.value)
          setUrlError(null)
        }}
        onKeyDown={handleKeyDown}
        autoFocus
        className="h-8 text-sm"
        data-testid="link-url-input"
      />
      {urlError && (
        <p className="text-xs text-destructive" role="alert">
          {urlError}
        </p>
      )}
      <div className="flex items-center gap-2">
        <Button
          size="xs"
          className="[@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:min-w-[44px]"
          onPointerDown={(e) => e.preventDefault()}
          onClick={handleApply}
        >
          {isEditing ? 'Update' : 'Apply'}
        </Button>
        {isEditing && (
          <Button
            size="xs"
            variant="destructive"
            className="[@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:min-w-[44px]"
            onPointerDown={(e) => e.preventDefault()}
            onClick={handleRemove}
          >
            Remove
          </Button>
        )}
      </div>
    </div>
  )
}
