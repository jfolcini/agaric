/**
 * QuickCaptureDialog — quick-capture modal.
 *
 * A small Dialog with a single textarea + `t('quickCapture.saveButton')` /
 * `t('rename.cancel')` buttons.
 * Triggered by the user-configured global hotkey (registered at app
 * startup via `registerGlobalShortcut`). On submit, dispatches
 * `commands.quickCaptureBlock(content)` against today's journal page and closes
 * with a success toast — failure surfaces a `notify.error` plus a
 * `logger.error` capture.
 *
 * UX choices:
 *  - Modal autofocuses the textarea on open so the user can start typing
 *    immediately (the hotkey was the explicit "I want to capture now"
 *    signal — there's no reason to make them click first).
 *  - Cmd / Ctrl + Enter submits as a power-user shortcut. Plain Enter
 *    inserts a newline (the textarea is the obvious affordance for
 *    multi-line capture). Escape dismisses via Radix's built-in
 *    onOpenChange; we don't bind it explicitly.
 *  - Empty / whitespace-only submissions are blocked by the disabled
 *    `t('quickCapture.saveButton')` button; submitting an empty textarea via Cmd+Enter is a
 *    no-op (matches the disabled-button semantics).
 *
 * The global shortcut opens it on desktop and the floating quick-capture
 * button on a touch phone, which is why its description has a touch
 * wording that names no key. An `agaric://capture?text=…` link opens it
 * holding the link's text (#6555); the link never saves by itself.
 *
 * On phones < 768 px (`useIsMobile() === true`) the dialog
 * renders as a bottom Sheet so the textarea + Capture / Cancel buttons
 * sit within thumb reach. The desktop path keeps the regular Radix
 * `Dialog` (not `AlertDialog`) so dismiss-on-outside-click / Escape
 * works without confirmation gating. Both paths share the same
 * controlled `open` / `onOpenChange` API.
 */

import type React from 'react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { DialogBody } from '@/components/ui/dialog'
import { SheetBody } from '@/components/ui/sheet'
import { Spinner } from '@/components/ui/spinner'
import { Textarea } from '@/components/ui/textarea'
import { useDialogOrSheet } from '@/components/ui/use-dialog-or-sheet'
import { useShouldShowMobileChrome } from '@/hooks/useShouldShowMobileChrome'
import { reloadChangedPageStores } from '@/hooks/useSyncEvents'
import { unwrap } from '@/lib/app-error'
import { commands } from '@/lib/bindings'
import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'
import { useSpaceStore } from '@/stores/space'

/** Text an `agaric://capture` link hands the dialog (#6555); a new object per link. */
export interface QuickCapturePrefill {
  text: string
}

interface QuickCaptureDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  prefill?: QuickCapturePrefill | null
}

/** The field once a link's text arrives: below what the user typed, never over it. */
function withLinkText(typed: string, linkText: string): string {
  if (linkText.length === 0) return typed
  if (typed.trim().length === 0) return linkText
  return `${typed}\n${linkText}`
}

export function QuickCaptureDialog({
  open,
  onOpenChange,
  prefill = null,
}: QuickCaptureDialogProps): React.ReactElement {
  const { t } = useTranslation()
  const [content, setContent] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  // A phone opens this from the floating button; it has no key combination to press.
  const touch = useShouldShowMobileChrome()

  // Reset content + autofocus the textarea each time the dialog opens.
  // Without the explicit reset, content from a previous capture session
  // would linger in the input on the next hotkey activation.
  useEffect(() => {
    if (open) {
      // oxlint-disable-next-line react/set-state-in-effect -- each re-open starts from an empty textarea; a plain derive would discard the user's edits; the guarded adjust is out of scope; see #4407
      setContent('')
      // Defer to the next microtask so Radix has time to portal-mount
      // the dialog content; otherwise `.focus()` would target a node
      // that's about to be replaced.
      queueMicrotask(() => {
        textareaRef.current?.focus()
      })
    }
  }, [open])

  // Declared after the reset above, so a link that opens the dialog lands in the emptied field.
  useEffect(() => {
    if (prefill === null) return
    // oxlint-disable-next-line react/set-state-in-effect -- the link's text merges into the user's edits, which a derive from props would discard
    setContent((typed) => withLinkText(typed, prefill.text))
  }, [prefill])

  const trimmed = content.trim()
  const isEmpty = trimmed.length === 0

  const handleSubmit = async () => {
    if (isEmpty || submitting) return
    setSubmitting(true)
    try {
      // Quick-capture lands on today's journal page in the
      // active space. The space store should always be hydrated by the
      // time the global shortcut fires (boot is gated on
      // `useSpaceStore.isReady`), but we surface a user-visible failure
      // if it isn't, rather than capturing into an unscoped page.
      const spaceId = useSpaceStore.getState().currentSpaceId
      if (spaceId == null) {
        throw new Error('No active space; cannot quick-capture')
      }
      const row = unwrap(await commands.quickCaptureBlock(trimmed, spaceId))
      // An out-of-band write (#5291): its op shifts the page's positional undo, so re-anchor too.
      reloadChangedPageStores(row.page_id == null ? undefined : [row.page_id])
      notify.success(t('quickCapture.successToast'))
      onOpenChange(false)
    } catch (err) {
      logger.error(
        'QuickCaptureDialog',
        'quick_capture_block IPC failed',
        { contentLength: trimmed.length },
        err,
      )
      notify.error(t('quickCapture.failureToast'))
    } finally {
      setSubmitting(false)
    }
  }

  const parts = useDialogOrSheet('dialog')
  const { Root, Content, Header, Title, Description, Footer } = parts
  // #2281 — match BugReportDialog: the mobile bottom-sheet path uses the
  // Sheet body primitive so padding/scroll behaviour comes from the Sheet
  // scaffolding rather than Dialog's.
  const Body = parts.isMobile ? SheetBody : DialogBody

  return (
    <Root open={open} onOpenChange={onOpenChange}>
      <Content data-testid="quick-capture-dialog">
        <Header>
          <Title>{t('quickCapture.dialogTitle')}</Title>
          <Description>
            {t(touch ? 'quickCapture.descriptionTouch' : 'settings.quickCapture.description')}
          </Description>
        </Header>
        <Body>
          <form
            onSubmit={(e) => {
              e.preventDefault()
              void handleSubmit()
            }}
          >
            <Textarea
              ref={textareaRef}
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder={t('quickCapture.placeholder')}
              aria-label={t('quickCapture.captureInputLabel')}
              disabled={submitting}
              // Cmd / Ctrl + Enter as a power-user submit shortcut.
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                  e.preventDefault()
                  void handleSubmit()
                }
              }}
              rows={4}
              data-testid="quick-capture-textarea"
            />
          </form>
        </Body>
        <Footer>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
            data-testid="quick-capture-cancel"
          >
            {t('rename.cancel')}
          </Button>
          <Button
            onClick={() => {
              void handleSubmit()
            }}
            disabled={isEmpty || submitting}
            data-testid="quick-capture-save"
          >
            {submitting && <Spinner />}
            {t('quickCapture.saveButton')}
          </Button>
        </Footer>
      </Content>
    </Root>
  )
}
