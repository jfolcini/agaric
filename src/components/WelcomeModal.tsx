import { FileText, Keyboard, Tag } from 'lucide-react'
import { useCallback, useState } from 'react'
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

async function createSamplePages(): Promise<void> {
  // Create "Getting Started" page with child blocks
  const gettingStarted = await createBlock({
    blockType: 'page',
    content: 'Getting Started',
  })
  await createBlock({
    blockType: 'content',
    content: 'Welcome to Agaric! This is a local-first note-taking app.',
    parentId: gettingStarted.id,
    position: 0,
  })
  await createBlock({
    blockType: 'content',
    content:
      'Each page is made of **blocks** — small pieces of text that you can nest and reorganize.',
    parentId: gettingStarted.id,
    position: 1,
  })
  await createBlock({
    blockType: 'content',
    content: 'Use the sidebar to navigate between pages, journal, tags, and more.',
    parentId: gettingStarted.id,
    position: 2,
  })

  // Create "Quick Tips" page with keyboard shortcut highlights
  const quickTips = await createBlock({
    blockType: 'page',
    content: 'Quick Tips',
  })
  await createBlock({
    blockType: 'content',
    content: 'Press **?** to open the keyboard shortcuts reference.',
    parentId: quickTips.id,
    position: 0,
  })
  await createBlock({
    blockType: 'content',
    content: 'Use **Ctrl+N** to quickly create a new page.',
    parentId: quickTips.id,
    position: 1,
  })
  await createBlock({
    blockType: 'content',
    content: 'Type **//** to open the slash command menu for inserting dates, templates, and more.',
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

  const handleCreateSamplePages = useCallback(async () => {
    setCreating(true)
    try {
      await createSamplePages()
      toast.success(t('welcome.samplePagesCreated'))
      handleDismiss()
    } catch (err) {
      logger.error('WelcomeModal', 'Failed to create sample pages', {
        error: String(err),
      })
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
        <div className="grid gap-4 py-2">
          {FEATURES.map((feature) => (
            <div key={feature.titleKey} className="flex items-start gap-3">
              <feature.icon
                className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
              <div>
                <p className="text-sm font-medium">{t(feature.titleKey)}</p>
                <p className="text-sm text-muted-foreground">{t(feature.descKey)}</p>
              </div>
            </div>
          ))}
        </div>
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
