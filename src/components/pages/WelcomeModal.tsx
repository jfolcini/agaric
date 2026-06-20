import type { TFunction } from 'i18next'
import { AtSign, Bold, SquareSlash } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { DialogBody } from '@/components/ui/dialog'
import { useDialogOrSheet } from '@/hooks/useDialogOrSheet'
import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'
// #754 — the onboarding flag helpers live in `@/lib/onboarding` (outside
// this lazy chunk) so the App shell can gate-mount the modal without
// fetching this chunk on every boot.
import { isOnboardingDone, markOnboardingDone } from '@/lib/onboarding'
import { CLOSE_ALL_OVERLAYS_EVENT } from '@/lib/overlay-events'
import { createBlock, createPageInSpace } from '@/lib/tauri'
import { useBootStore } from '@/stores/boot'
import { useSpaceStore } from '@/stores/space'

// #214 Phase 1B — three concrete workflow rows replace the earlier six
// abstract feature blurbs. Each teaches one core gesture a new user can
// try immediately: the slash menu, links/tags, and inline formatting.
const FEATURES = [
  {
    icon: SquareSlash,
    titleKey: 'welcome.workflowSlash',
    descKey: 'welcome.workflowSlashDesc',
  },
  {
    icon: AtSign,
    titleKey: 'welcome.workflowLinkTag',
    descKey: 'welcome.workflowLinkTagDesc',
  },
  {
    icon: Bold,
    titleKey: 'welcome.workflowFormat',
    descKey: 'welcome.workflowFormatDesc',
  },
] as const

async function createSamplePages(t: TFunction): Promise<void> {
  // / H-3b — onboarding sample pages must land with a `space`
  // ref property so they show up in the PageBrowser. At first boot
  // the bootstrap has just seeded Personal + Work; the active space
  // is whichever one the SpaceStore reconciled to (Personal by
  // default since it sorts first alphabetically). If the SpaceStore
  // has not hydrated yet (rare race on fresh installs), bail with a
  // descriptive error instead of leaking unscoped pages.
  const currentSpaceId = useSpaceStore.getState().currentSpaceId
  if (currentSpaceId == null) {
    throw new Error('No active space; cannot create sample pages')
  }

  // Create t('welcome.sampleGettingStartedTitle') page with child blocks
  const gettingStartedId = await createPageInSpace({
    content: t('welcome.sampleGettingStartedTitle'),
    spaceId: currentSpaceId,
  })
  await createBlock({
    blockType: 'content',
    content: t('welcome.sampleGettingStartedBody1'),
    parentId: gettingStartedId,
    index: 0,
  })
  await createBlock({
    blockType: 'content',
    content: t('welcome.sampleGettingStartedBody2'),
    parentId: gettingStartedId,
    index: 1,
  })
  await createBlock({
    blockType: 'content',
    content: t('welcome.sampleGettingStartedBody3'),
    parentId: gettingStartedId,
    index: 2,
  })

  // Create t('welcome.sampleQuickTipsTitle') page with keyboard shortcut highlights
  const quickTipsId = await createPageInSpace({
    content: t('welcome.sampleQuickTipsTitle'),
    spaceId: currentSpaceId,
  })
  await createBlock({
    blockType: 'content',
    content: t('welcome.sampleQuickTipsBody1'),
    parentId: quickTipsId,
    index: 0,
  })
  await createBlock({
    blockType: 'content',
    content: t('welcome.sampleQuickTipsBody2'),
    parentId: quickTipsId,
    index: 1,
  })
  await createBlock({
    blockType: 'content',
    content: t('welcome.sampleQuickTipsBody3'),
    parentId: quickTipsId,
    index: 2,
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

  // Close the modal when the global "close all overlays" shortcut
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
      notify.success(t('welcome.samplePagesCreated'))
      handleDismiss()
    } catch (err) {
      logger.error('WelcomeModal', 'Failed to create sample pages', undefined, err)
      notify.error(t('welcome.samplePagesFailed'))
    } finally {
      setCreating(false)
    }
  }, [t, handleDismiss])

  const parts = useDialogOrSheet('dialog')
  const { Root, Content, Header, Title, Description, Footer } = parts

  // Sheet's Content takes a `side` prop; DialogContent does not.
  const contentSideProps = parts.isMobile ? ({ side: 'bottom' } as const) : {}

  if (bootState !== 'ready') return null

  // Feature list renders inside DialogBody on desktop so it
  // scrolls when the viewport is short; the mobile Sheet path keeps the
  // list inline (SheetContent already constrains height) so we don't nest
  // scroll regions.
  const featureList = (
    /*
      oxlint-disable-next-line jsx-a11y/no-redundant-roles -- explicit role="list" is
      required because Safari + VoiceOver strip the implicit list role
      from a <ul> with `list-style: none` (Tailwind `list-none`). .
    */
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
  )

  return (
    <Root
      open={open}
      onOpenChange={(value) => {
        if (!value) handleDismiss()
      }}
    >
      <Content data-testid="welcome-modal" {...contentSideProps}>
        <Header>
          <Title>{t('welcome.title')}</Title>
          <Description>{t('welcome.description')}</Description>
        </Header>
        {parts.isMobile ? featureList : <DialogBody>{featureList}</DialogBody>}
        <Footer>
          <Button variant="outline" onClick={handleCreateSamplePages} disabled={creating}>
            {t('welcome.createSamplePages')}
          </Button>
          <Button onClick={handleDismiss}>{t('welcome.getStarted')}</Button>
        </Footer>
      </Content>
    </Root>
  )
}
