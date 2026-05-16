/**
 * QuickCaptureDialog — FEAT-12 quick-capture modal.
 *
 * A small Dialog with a single textarea + `t('quickCapture.saveButton')` /
 * `t('rename.cancel')` buttons.
 * Triggered by the user-configured global hotkey (registered at app
 * startup via `registerGlobalShortcut`). On submit, dispatches
 * `quickCaptureBlock(content)` against today's journal page and closes
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
 * Desktop-only by virtue of its trigger being the global shortcut, but
 * the component itself doesn't gate on platform — App.tsx mounts it
 * unconditionally and the dialog only opens when the global shortcut
 * fires (which is itself a no-op on mobile per `registerGlobalShortcut`).
 *
 * MAINT-215: on phones < 768 px (`useIsMobile() === true`) the dialog
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
import { Textarea } from '@/components/ui/textarea'
import { useDialogOrSheet } from '@/hooks/useDialogOrSheet'
import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'
import { quickCaptureBlock } from '@/lib/tauri'
import { useSpaceStore } from '@/stores/space'

interface QuickCaptureDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function QuickCaptureDialog({
  open,
  onOpenChange,
}: QuickCaptureDialogProps): React.ReactElement {
  const { t } = useTranslation()
  const [content, setContent] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)

  // Reset content + autofocus the textarea each time the dialog opens.
  // Without the explicit reset, content from a previous capture session
  // would linger in the input on the next hotkey activation.
  useEffect(() => {
    if (open) {
      setContent('')
      // Defer to the next microtask so Radix has time to portal-mount
      // the dialog content; otherwise `.focus()` would target a node
      // that's about to be replaced.
      queueMicrotask(() => {
        textareaRef.current?.focus()
      })
    }
  }, [open])

  const trimmed = content.trim()
  const isEmpty = trimmed.length === 0

  const handleSubmit = async () => {
    if (isEmpty || submitting) return
    setSubmitting(true)
    try {
      // FEAT-3p5: quick-capture lands on today's journal page in the
      // active space. The space store should always be hydrated by the
      // time the global shortcut fires (boot is gated on
      // `useSpaceStore.isReady`), but we surface a user-visible failure
      // if it isn't, rather than capturing into an unscoped page.
      const spaceId = useSpaceStore.getState().currentSpaceId
      if (spaceId == null) {
        throw new Error('No active space; cannot quick-capture')
      }
      await quickCaptureBlock(trimmed, spaceId)
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
  // Sheet's Content takes a `side` prop; DialogContent does not.
  const contentSideProps = parts.isMobile ? ({ side: 'bottom' } as const) : {}

  return (
    <Root open={open} onOpenChange={onOpenChange}>
      <Content data-testid="quick-capture-dialog" {...contentSideProps}>
        <Header>
          <Title>{t('quickCapture.dialogTitle')}</Title>
          <Description>{t('settings.quickCapture.description')}</Description>
        </Header>
        <DialogBody>
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
        </DialogBody>
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
            {t('quickCapture.saveButton')}
          </Button>
        </Footer>
      </Content>
    </Root>
  )
}
