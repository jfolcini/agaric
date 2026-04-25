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
import { useTranslation } from 'react-i18next'
import { logger } from '@/lib/logger'
import { fetchLinkMetadata } from '@/lib/tauri'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Label } from './ui/label'

export interface LinkEditPopoverProps {
  editor: Editor
  /** Whether the cursor is inside an existing link (shows Remove button). */
  isEditing: boolean
  /** Pre-filled URL when editing; empty string for new links. */
  initialUrl: string
  /** Pre-filled label text (selected text or existing link text). */
  initialLabel: string
  /** Close the popover (called after apply, remove, or escape). */
  onClose: () => void
  /** Selection range saved before popover stole focus (B-70). */
  savedSelection?: { from: number; to: number } | null
}

/**
 * Schemes a user-entered link is never allowed to carry. These either
 * execute script in the renderer (`javascript:`, `vbscript:`, `data:`)
 * or open the host filesystem / native pages (`file:`, `blob:`,
 * `about:`) and are routinely abused for XSS / phishing payloads in
 * markdown link editors. Matched case-insensitively so the obvious
 * obfuscations (`JavaScript:`, `FILE:`) are caught too.
 */
const BLOCKED_URL_SCHEMES: readonly string[] = [
  'javascript:',
  'vbscript:',
  'data:',
  'file:',
  'blob:',
  'about:',
]

/**
 * Normalise a user-entered URL: trim whitespace and prepend `https://`
 * when no protocol scheme is present.
 *
 * Recognises both `scheme://` protocols (http, ftp, …) and
 * schemeless protocols like `mailto:` and `tel:`. Returns `''` for any
 * URL using a scheme in `BLOCKED_URL_SCHEMES` so the caller can treat
 * "no value" and "rejected value" identically.
 */
export function normalizeUrl(url: string): string {
  const trimmed = url.trim()
  if (!trimmed) return ''
  // Block dangerous protocols (case-insensitive). The list mirrors the
  // schemes that browser sanitisers and CodeQL's
  // `js/incomplete-url-scheme-check` query care about.
  const lower = trimmed.toLowerCase()
  if (BLOCKED_URL_SCHEMES.some((scheme) => lower.startsWith(scheme))) return ''
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
  initialLabel,
  onClose,
  savedSelection,
}: LinkEditPopoverProps): React.ReactElement {
  const { t } = useTranslation()
  const [url, setUrl] = useState(initialUrl)
  const [label, setLabel] = useState(initialLabel)
  const [urlError, setUrlError] = useState<string | null>(null)

  const handleApply = useCallback(() => {
    const trimmedUrl = url.trim()
    if (!trimmedUrl) {
      editor.commands.focus()
      onClose()
      return
    }
    const normalized = normalizeUrl(url)
    if (!normalized) {
      setUrlError(t('linkEdit.invalidUrl'))
      return
    }
    setUrlError(null)

    const trimmedLabel = label.trim()
    const linkText = trimmedLabel || normalized

    if (savedSelection && savedSelection.from !== savedSelection.to) {
      if (isEditing && label === initialLabel) {
        editor.chain().focus().setTextSelection(savedSelection).setLink({ href: normalized }).run()
      } else {
        editor
          .chain()
          .focus()
          .setTextSelection(savedSelection)
          .insertContent({
            type: 'text',
            text: linkText,
            marks: [{ type: 'link', attrs: { href: normalized } }],
          })
          .run()
      }
    } else {
      editor
        .chain()
        .focus()
        .insertContent({
          type: 'text',
          text: linkText,
          marks: [{ type: 'link', attrs: { href: normalized } }],
        })
        .run()
    }

    // Exit the link mark so subsequent typing is plain text (UX-177)
    const linkMarkType = editor.schema.marks['link']
    if (linkMarkType) {
      editor.view.dispatch(editor.state.tr.removeStoredMark(linkMarkType))
    }
    // Fire-and-forget: prefetch metadata for the applied URL (UX-165)
    fetchLinkMetadata(normalized).catch((err: unknown) => {
      logger.warn('LinkEditPopover', 'link metadata prefetch failed', { url: normalized }, err)
    })
    onClose()
  }, [editor, url, label, initialLabel, isEditing, onClose, t, savedSelection])

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
    <div className="flex flex-col gap-3" data-testid="link-edit-popover">
      <div className="flex flex-col gap-1">
        <Label size="xs" htmlFor="link-label-input">
          {t('linkEdit.label')}
        </Label>
        <Input
          id="link-label-input"
          type="text"
          placeholder={t('linkEdit.labelPlaceholder')}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          onKeyDown={handleKeyDown}
          className="h-8 [@media(pointer:coarse)]:h-11 text-sm"
          data-testid="link-label-input"
        />
      </div>
      <div className="flex flex-col gap-1">
        <Label size="xs" htmlFor="link-url-input">
          {t('linkEdit.url')}
        </Label>
        <Input
          id="link-url-input"
          type="url"
          placeholder={t('linkEdit.urlPlaceholder')}
          value={url}
          onChange={(e) => {
            setUrl(e.target.value)
            setUrlError(null)
          }}
          onKeyDown={handleKeyDown}
          autoFocus
          className="h-8 [@media(pointer:coarse)]:h-11 text-sm"
          data-testid="link-url-input"
        />
      </div>
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
          {isEditing ? t('linkEdit.update') : t('linkEdit.apply')}
        </Button>
        {isEditing && (
          <Button
            size="xs"
            variant="destructive"
            className="[@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:min-w-[44px]"
            onPointerDown={(e) => e.preventDefault()}
            onClick={handleRemove}
          >
            {t('linkEdit.remove')}
          </Button>
        )}
      </div>
    </div>
  )
}
