import type { TFunction } from 'i18next'
import { AtSign, Bold, SquareSlash } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { DialogBody } from '@/components/ui/dialog'
import { Spinner } from '@/components/ui/spinner'
import { useDialogOrSheet } from '@/hooks/useDialogOrSheet'
import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'
// #754 — the onboarding flag helpers live in `@/lib/onboarding` (outside
// this lazy chunk) so the App shell can gate-mount the modal without
// fetching this chunk on every boot.
import { isOnboardingDone, markOnboardingDone } from '@/lib/onboarding'
import { CLOSE_ALL_OVERLAYS_EVENT } from '@/lib/overlay-events'
import { createBlock, createPageInSpace, listAllPagesInSpace, listBlocks } from '@/lib/tauri'
import { useBootStore } from '@/stores/boot'
import { useSpaceStore } from '@/stores/space'
import { useTabsStore } from '@/stores/tabs'

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

/** Body i18n keys for the "Getting Started" sample page, in render order. */
const GETTING_STARTED_BODY_KEYS = [
  'welcome.sampleGettingStartedBody1',
  'welcome.sampleGettingStartedBody2',
  'welcome.sampleGettingStartedBody3',
] as const

/** Body i18n keys for the "Quick Tips" sample page, in render order. */
const QUICK_TIPS_BODY_KEYS = [
  'welcome.sampleQuickTipsBody1',
  'welcome.sampleQuickTipsBody2',
  'welcome.sampleQuickTipsBody3',
] as const

/**
 * Create the sample page titled `t(titleKey)` in `spaceId` — or REUSE the
 * one that is already there — and fill in whichever body blocks are
 * missing. Returns the page id.
 *
 * #3308 finding 1(b): the eight-IPC creation sequence has no transaction,
 * so a rejection anywhere in the middle used to leave half-built pages
 * behind a still-open modal whose still-enabled button then created a
 * SECOND copy of everything. Reuse-by-title is the recovery: it converges
 * on one Getting Started / Quick Tips page no matter how many times the
 * flow is retried. Compensating deletion was rejected deliberately —
 * removing blocks the user may have already edited is a worse failure mode
 * than a partially-filled page that the next retry completes.
 *
 * Matching is by exact title within the active space (the sample titles are
 * fixed i18n strings), and body blocks are matched by exact content so a
 * retry after a mid-sequence failure appends only the parts that never
 * landed. Blocks the user edited no longer match, so they are re-added
 * rather than silently overwritten — additive, never destructive.
 */
async function ensureSamplePage(
  t: TFunction,
  spaceId: string,
  existingPages: ReadonlyArray<{ id: string; content: string | null }>,
  titleKey: string,
  bodyKeys: ReadonlyArray<string>,
): Promise<string> {
  const title = t(titleKey)
  const existing = existingPages.find((page) => page.content === title)

  const pageId = existing ? existing.id : await createPageInSpace({ content: title, spaceId })

  // A brand-new page has no children; a reused one may already carry some
  // of the bodies from an interrupted earlier attempt.
  let existingBodies: ReadonlySet<string | null> = new Set<string | null>()
  let index = 0
  if (existing) {
    const children = await listBlocks({ parentId: pageId, spaceId })
    existingBodies = new Set(children.items.map((block) => block.content))
    index = children.items.length
  }

  for (const key of bodyKeys) {
    const content = t(key)
    if (existingBodies.has(content)) continue
    await createBlock({ blockType: 'content', content, parentId: pageId, index })
    index += 1
  }

  return pageId
}

/**
 * Seed the two onboarding sample pages, idempotently. Returns the
 * "Getting Started" page id so the caller can navigate the user straight
 * to the content that was just created.
 */
async function createSamplePages(t: TFunction): Promise<string> {
  // H-3b — onboarding sample pages must land with a `space`
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

  // One unpaginated `{ id, content }` sweep of the space (see
  // `listAllPagesInSpace`) answers "does this sample page already exist?"
  // for BOTH pages — the paginated `listBlocks({ blockType: 'page' })`
  // form could miss a match past the first page of results.
  const existingPages = await listAllPagesInSpace(currentSpaceId)

  const gettingStartedId = await ensureSamplePage(
    t,
    currentSpaceId,
    existingPages,
    'welcome.sampleGettingStartedTitle',
    GETTING_STARTED_BODY_KEYS,
  )
  await ensureSamplePage(
    t,
    currentSpaceId,
    existingPages,
    'welcome.sampleQuickTipsTitle',
    QUICK_TIPS_BODY_KEYS,
  )

  return gettingStartedId
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

  // Retry indirection: the failure toast's action has to re-run the very
  // callback that produced it, so it reads the latest one out of a ref
  // instead of referencing itself (which no `useCallback` can do).
  const retryCreateRef = useRef<() => void>(() => {})

  const handleCreateSamplePages = useCallback(async () => {
    setCreating(true)
    try {
      const gettingStartedId = await createSamplePages(t)
      notify.success(t('welcome.samplePagesCreated'))
      // Land the user ON the content that was just created — the flow used
      // to leave them on whatever view they started from, with no pointer
      // to the new pages (#3308 finding 1).
      useTabsStore
        .getState()
        .navigateToPage(gettingStartedId, t('welcome.sampleGettingStartedTitle'))
      handleDismiss()
    } catch (err) {
      logger.error('WelcomeModal', 'Failed to create sample pages', undefined, err)
      // UX.md:113 — error states must offer a way to retry or recover. The
      // retry is safe to press repeatedly: `createSamplePages` reuses any
      // page/blocks a failed attempt already left behind.
      notify.retry(t('welcome.samplePagesFailed'), () => {
        retryCreateRef.current()
      })
    } finally {
      setCreating(false)
    }
  }, [t, handleDismiss])

  useEffect(() => {
    retryCreateRef.current = () => {
      void handleCreateSamplePages()
    }
  }, [handleCreateSamplePages])

  const parts = useDialogOrSheet('dialog')
  const { Root, Content, Header, Title, Description, Footer } = parts

  if (bootState !== 'ready') return null

  // Feature list renders inside DialogBody on desktop so it
  // scrolls when the viewport is short; the mobile Sheet path keeps the
  // list inline because the shared SheetContent viewport cap is sufficient,
  // avoiding nested scroll regions.
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
      <Content data-testid="welcome-modal">
        <Header>
          <Title>{t('welcome.title')}</Title>
          <Description>{t('welcome.description')}</Description>
        </Header>
        {parts.isMobile ? featureList : <DialogBody>{featureList}</DialogBody>}
        <Footer>
          <Button variant="outline" onClick={handleCreateSamplePages} disabled={creating}>
            {creating && <Spinner />}
            {t('welcome.createSamplePages')}
          </Button>
          <Button onClick={handleDismiss}>{t('welcome.getStarted')}</Button>
        </Footer>
      </Content>
    </Root>
  )
}
