/**
 * PageSourceDialog — read-only "View as Markdown" (#5140 Phase 2).
 *
 * Shows the page as the one markdown buffer source mode edits, straight from
 * `get_page_source`, with a Copy button.
 */

import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Spinner } from '@/components/ui/spinner'
import { flushActiveDraft } from '@/lib/active-draft-flush'
import { unwrap } from '@/lib/app-error'
import { commands } from '@/lib/bindings'
import { writeText } from '@/lib/clipboard'
import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'

export interface PageSourceDialogProps {
  pageId: string
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function PageSourceDialog({ pageId, open, onOpenChange }: PageSourceDialogProps) {
  const { t } = useTranslation()

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('pageSource.title')}</DialogTitle>
          <DialogDescription className="sr-only">{t('pageSource.description')}</DialogDescription>
        </DialogHeader>
        {/* Mounted only while the dialog is open, so every open starts from a
            fresh load instead of the buffer the last open left behind. */}
        <PageSourceBody pageId={pageId} />
      </DialogContent>
    </Dialog>
  )
}

function PageSourceBody({ pageId }: { pageId: string }) {
  const { t } = useTranslation()
  const [source, setSource] = useState<string | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        // #2969 — commit the focused block's debounced keystrokes first, or
        // the buffer misses what the user just typed.
        await flushActiveDraft()
        const text = unwrap(await commands.getPageSource(pageId))
        if (!cancelled) setSource(text)
      } catch (err) {
        logger.error('PageSourceDialog', 'Failed to load page source', { pageId }, err)
        if (!cancelled) setLoadFailed(true)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [pageId])

  const handleCopy = async () => {
    if (source === null) return
    try {
      await writeText(source)
      notify.success(t('pageHeader.exportCopied'))
    } catch (err) {
      logger.error('PageSourceDialog', 'Failed to copy page source', { pageId }, err)
      notify.error(t('pageSource.copyFailed'))
    }
  }

  return (
    <>
      <DialogBody>
        {loadFailed ? (
          <p role="alert" className="text-sm text-destructive">
            {t('pageSource.loadFailed')}
          </p>
        ) : source === null ? (
          <output
            aria-live="polite"
            className="flex items-center gap-2 text-sm text-muted-foreground"
          >
            <Spinner />
            <span>{t('ui.loading')}</span>
          </output>
        ) : (
          <pre
            data-testid="page-source-content"
            // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- nothing else in the scroll area takes focus, so without a tab stop a keyboard user cannot scroll a long buffer
            tabIndex={0}
            className="whitespace-pre-wrap break-words font-mono text-sm focus-ring-visible"
          >
            {source}
          </pre>
        )}
      </DialogBody>
      <DialogFooter>
        <Button onClick={handleCopy} disabled={source === null}>
          {t('pageSource.copy')}
        </Button>
      </DialogFooter>
    </>
  )
}
