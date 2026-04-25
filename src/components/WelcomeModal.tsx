import type { TFunction } from 'i18next'
import { FileText, Keyboard, Tag } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { logger } from '@/lib/logger'
import { CLOSE_ALL_OVERLAYS_EVENT } from '@/lib/overlay-events'
import { createBlock } from '@/lib/tauri'
import { useBootStore } from '@/stores/boot'

const STORAGE_KEY = 'agaric-onboarding-done'

function isOnboardingDone(): boolean {
  try {
    return !!localStorage.getItem(STORAGE_KEY)
  } catch {
    return false
  }
}

function markOnboardingDone(): void {
  try {
    localStorage.setItem(STORAGE_KEY, 'true')
  } catch {
    // localStorage may be unavailable in some environments
  }
}

const FEATURES = [
  {
    icon: FileText,
    titleKey: 'welcome.featureBlocks',
    descKey: 'welcome.featureBlocksDesc',
  },
  {
    icon: Keyboard,
    titleKey: 'welcome.featureShortcuts',
    descKey: 'welcome.featureShortcutsDesc',
  },
  {
    icon: Tag,
    titleKey: 'welcome.featureTags',
    descKey: 'welcome.featureTagsDesc',
  },
] as const

async function createSamplePages(t: TFunction): Promise<void> {
  // Create "Getting Started" page with child blocks
  const gettingStarted = await createBlock({
    blockType: 'page',
    content: t('welcome.sampleGettingStartedTitle'),
  })
  await createBlock({
    blockType: 'content',
    content: t('welcome.sampleGettingStartedBody1'),
    parentId: gettingStarted.id,
    position: 0,
  })
  await createBlock({
    blockType: 'content',
    content: t('welcome.sampleGettingStartedBody2'),
    parentId: gettingStarted.id,
    position: 1,
  })
  await createBlock({
    blockType: 'content',
    content: t('welcome.sampleGettingStartedBody3'),
    parentId: gettingStarted.id,
    position: 2,
  })

  // Create "Quick Tips" page with keyboard shortcut highlights
  const quickTips = await createBlock({
    blockType: 'page',
    content: t('welcome.sampleQuickTipsTitle'),
  })
  await createBlock({
    blockType: 'content',
    content: t('welcome.sampleQuickTipsBody1'),
    parentId: quickTips.id,
    position: 0,
  })
  await createBlock({
    blockType: 'content',
    content: t('welcome.sampleQuickTipsBody2'),
    parentId: quickTips.id,
    position: 1,
  })
  await createBlock({
    blockType: 'content',
    content: t('welcome.sampleQuickTipsBody3'),
    parentId: quickTips.id,
    position: 2,
  })
}

export function WelcomeModal() {
  const { t } = useTranslation()
  const bootState = useBootStore((s) => s.state)
  const [open, setOpen] = useState(() => !isOnboardingDone())
  const [creating, setCreating] = useState(false)

  const handleDismiss = useCallback(() => {
    setOpen(false)
    markOnboardingDone()
  }, [])

  // UX-228: close the modal when the global "close all overlays" shortcut
  // fires. Treat this as a dismissal (same as clicking outside the Radix
  // Dialog) so the onboarding flag is set and the modal does not re-open
  // on the next launch.
  useEffect(() => {
    function handleClose() {
      handleDismiss()
    }
    window.addEventListener(CLOSE_ALL_OVERLAYS_EVENT, handleClose)
    return () => window.removeEventListener(CLOSE_ALL_OVERLAYS_EVENT, handleClose)
  }, [handleDismiss])

  const handleCreateSamplePages = useCallback(async () => {
    setCreating(true)
    try {
      await createSamplePages(t)
      toast.success(t('welcome.samplePagesCreated'))
      handleDismiss()
    } catch (err) {
      logger.error('WelcomeModal', 'Failed to create sample pages', undefined, err)
      toast.error(t('welcome.samplePagesFailed'))
    } finally {
      setCreating(false)
    }
  }, [t, handleDismiss])

  if (bootState !== 'ready') return null

  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!value) handleDismiss()
      }}
    >
      <DialogContent data-testid="welcome-modal">
        <DialogHeader>
          <DialogTitle>{t('welcome.title')}</DialogTitle>
          <DialogDescription>{t('welcome.description')}</DialogDescription>
        </DialogHeader>
        {/*
          biome-ignore lint/a11y/noRedundantRoles: explicit role="list" is
          required because Safari + VoiceOver strip the implicit list role
          from a <ul> with `list-style: none` (Tailwind `list-none`). UX-278.
        */}
        <ul role="list" className="grid list-none gap-4 py-2 pl-0">
          {FEATURES.map((feature) => (
            <li key={feature.titleKey} className="flex items-start gap-3">
              <feature.icon
                className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
              <div>
                <p className="text-sm font-medium">{t(feature.titleKey)}</p>
                <p className="text-sm text-muted-foreground">{t(feature.descKey)}</p>
              </div>
            </li>
          ))}
        </ul>
        <DialogFooter>
          <Button variant="outline" onClick={handleCreateSamplePages} disabled={creating}>
            {t('welcome.createSamplePages')}
          </Button>
          <Button onClick={handleDismiss}>{t('welcome.getStarted')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
