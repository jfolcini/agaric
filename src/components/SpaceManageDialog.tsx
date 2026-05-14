/**
 * SpaceManageDialog — manage-spaces UI (FEAT-3 Phase 6).
 *
 * Replaces the previous "Manage spaces… (Coming in Phase 6)" placeholder
 * with a fully functional Radix Dialog. Per-row actions:
 *
 * - **Rename** — inline-editable name. Blur or Enter saves via the
 *   shared `editBlock` IPC (spaces are page blocks, so the existing
 *   block-content edit op is the natural fit — no new op type).
 * - **Accent color** — small swatch grid (FEAT-3p10 consumer). Click
 *   writes a `setProperty(accent_color, …)` op. Storage is plain
 *   `value_text` so the palette token (`accent-emerald`, `accent-blue`,
 *   …) survives unchanged.
 * - **Delete** — `deleteBlock` op, but only allowed when the space is
 *   empty. We probe emptiness via `listBlocks({ spaceId, blockType:
 *   'page', limit: 1 })`; the existing FEAT-3 Phase 2 query scoping
 *   already returns just pages whose `space` property points at the
 *   target. Disabled state shows a tooltip explaining why. Always
 *   disabled on the last remaining space.
 * - **Create new space** — primary footer button opens an inline form
 *   that calls the new `createSpace` IPC. Atomic (CreateBlock +
 *   SetProperty(is_space) + optional SetProperty(accent_color) all
 *   inside a single `BEGIN IMMEDIATE` transaction).
 *
 * **Onboarding hint** — first time the user opens the dialog with
 * exactly the two seeded spaces (`availableSpaces.length <= 2`) and
 * the `agaric:space-onboarding-seen-v1` localStorage flag is unset, an
 * inline banner explains what spaces are. Dismissal sets the flag so
 * the hint never reappears. Owned by `SpaceOnboardingHint` (PEND-30
 * D-2) — hoisted out of the per-row editor since it is dialog-wide.
 *
 * **PEND-30 D-2 decomposition** — the per-row editor used to mix five
 * orthogonal concerns (rename / accent / journal-template / delete /
 * onboarding-hint) in a 600-line `SpaceRowEditor`. Each concern now
 * lives in its own file under `./SpaceManageDialog/`. The dialog
 * shell (this file) is responsible for shared state ownership: the
 * emptiness probe + journal-template fetch caches keyed by
 * `space.id`. See `./SpaceManageDialog/SpaceRowEditor.tsx` for the
 * thin orchestrator that composes the four extracted parts.
 *
 * Reuses existing primitives — no new dialog primitive, no new store.
 * `useSpaceStore.refreshAvailableSpaces()` is the single refresh seam
 * after every mutation so the SpaceSwitcher re-renders within a tick.
 */

import { Check, Plus } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { TooltipProvider } from '@/components/ui/tooltip'
import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'
import { createSpace, getBatchProperties, listBlocks, listBlocksLimit } from '@/lib/tauri'
import { cn } from '@/lib/utils'
import { useSpaceStore } from '@/stores/space'
import { ACCENT_SWATCHES, type AccentToken } from './SpaceManageDialog/SpaceAccentPicker'
import { SpaceOnboardingHint } from './SpaceManageDialog/SpaceOnboardingHint'
import { SpaceRowEditor } from './SpaceManageDialog/SpaceRowEditor'

// Re-export so existing call sites (Settings → ResetOnboardingRow,
// tests, future white-label keep) keep working without churn. The
// implementations now live alongside their respective sub-components.
export { ACCENT_SWATCHES } from './SpaceManageDialog/SpaceAccentPicker'
export { resetOnboardingSeen } from './SpaceManageDialog/SpaceOnboardingHint'

const LOG_MODULE = 'components/SpaceManageDialog'

interface SpaceManageDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

interface CreateSpaceFormProps {
  onCreated: () => Promise<void> | void
}

/**
 * Inline "create new space" form. Toggled open by the dialog footer
 * button. Submits via the new `createSpace` IPC; on success the form
 * resets, closes, and the parent refreshes `availableSpaces`.
 */
function CreateSpaceForm({ onCreated }: CreateSpaceFormProps) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [accent, setAccent] = useState<AccentToken | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) inputRef.current?.focus()
  }, [open])

  const handleSubmit = useCallback(async () => {
    const trimmed = name.trim()
    if (!trimmed || submitting) return
    setSubmitting(true)
    try {
      await createSpace({
        name: trimmed,
        accentColor: accent ?? null,
      })
      setName('')
      setAccent(null)
      setOpen(false)
      await onCreated()
    } catch (err) {
      logger.error(LOG_MODULE, 'create space failed', { name: trimmed }, err)
      notify.error(t('space.createSpaceFailed'))
    } finally {
      setSubmitting(false)
    }
  }, [name, accent, submitting, onCreated, t])

  if (!open) {
    return (
      <Button
        type="button"
        variant="default"
        onClick={() => setOpen(true)}
        aria-label={t('space.createSpaceLabel')}
      >
        <Plus className="h-4 w-4" />
        {t('space.createSpaceLabel')}
      </Button>
    )
  }

  return (
    <div className="flex w-full flex-col gap-2">
      <Input
        ref={inputRef}
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder={t('space.newSpacePlaceholder')}
        aria-label={t('space.newSpacePlaceholder')}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            void handleSubmit()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            setOpen(false)
            setName('')
            setAccent(null)
          }
        }}
      />
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted-foreground">{t('space.accentColorLabel')}:</span>
        {/* biome-ignore lint/a11y/useSemanticElements: same swatch-picker pattern as the per-row picker — see the rationale comment in SpaceAccentPicker.tsx */}
        <div
          className="flex flex-wrap gap-1.5"
          role="group"
          aria-label={t('space.accentColorLabel')}
        >
          {ACCENT_SWATCHES.map((swatch) => (
            <button
              key={swatch.token}
              type="button"
              aria-label={t('space.accentSwatchLabel', { color: swatch.label })}
              aria-pressed={accent === swatch.token}
              onClick={() => setAccent(swatch.token)}
              className={cn(
                'inline-flex items-center justify-center rounded-full transition-all',
                'h-5 w-5 [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11',
                'focus-ring-visible',
                accent === swatch.token && 'ring-2 ring-ring',
              )}
              style={{ backgroundColor: `var(--${swatch.token})` }}
              data-accent-token={swatch.token}
            >
              {/* UX-6 — same icon-overlay rationale as the per-row
               * picker; keeps the two swatch grids visually consistent
               * for colour-blind users. */}
              {accent === swatch.token ? (
                <Check
                  className="h-3 w-3 text-white drop-shadow-(--shadow-accent-stroke)"
                  strokeWidth={3}
                  aria-hidden="true"
                />
              ) : null}
            </button>
          ))}
        </div>
      </div>
      <div className="flex justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            setOpen(false)
            setName('')
            setAccent(null)
          }}
          disabled={submitting}
        >
          {t('space.cancelLabel')}
        </Button>
        <Button
          type="button"
          variant="default"
          size="sm"
          onClick={() => void handleSubmit()}
          disabled={submitting || !name.trim()}
        >
          {t('space.createSpaceCta')}
        </Button>
      </div>
    </div>
  )
}

export function SpaceManageDialog({
  open,
  onOpenChange,
}: SpaceManageDialogProps): React.JSX.Element {
  const { t } = useTranslation()
  const availableSpaces = useSpaceStore((s) => s.availableSpaces)
  const refreshAvailableSpaces = useSpaceStore((s) => s.refreshAvailableSpaces)

  const handleRefresh = useCallback(async () => {
    await refreshAvailableSpaces()
  }, [refreshAvailableSpaces])

  // MAINT-180 — both the per-space emptiness probe and the
  // journal-template fetch are owned here so each IPC fires once per
  // unique `space.id` for the whole dialog lifetime, not once per row
  // mount. Re-opening the dialog (which unmounts and remounts every
  // `SpaceRowEditor` via Radix) is a cache hit.
  //
  // Cache contract:
  //  - missing key   = not yet fetched (or last fetch errored)
  //  - present value = resolved successful fetch result
  //
  // Errors deliberately do *not* poison the cache: the key is removed
  // from the in-flight set so the next render (e.g. after a re-open)
  // retries — same observable behaviour as the pre-MAINT-180 row-local
  // probes that re-fired on every mount.
  const [emptinessBySpace, setEmptinessBySpace] = useState<Record<string, boolean>>({})
  const [journalTemplateBySpace, setJournalTemplateBySpace] = useState<Record<string, string>>({})
  const emptinessFetchedRef = useRef<Set<string>>(new Set())
  const journalTemplateFetchedRef = useRef<Set<string>>(new Set())

  // PEND-29 B-7: cancellation flag prevents post-unmount setState on
  // both async chains. Closing the dialog unmounts the content (Radix
  // portal, no `forceMount`); without the guard the in-flight
  // `listBlocks` / `getBatchProperties` IPCs resolved into setState
  // calls on an unmounted component. The `emptinessFetchedRef` /
  // `journalTemplateFetchedRef` dedup behavior is preserved — the
  // catch path's `delete(id)` still gates on `active` so we don't
  // re-open a slot for a dead component.
  //
  // PEND-35 Tier 2.4b: the per-space `getProperties(id)` loop was
  // collapsed into a single `getBatchProperties(ids)` call covering
  // every un-fetched space id at once. Each row only reads one key
  // (`journal_template`); fanning out N IPCs to surface N single-key
  // values is wasteful. The `listBlocks` emptiness probe stays
  // per-space because no batched `list_blocks` shape exists yet.
  useEffect(() => {
    let active = true
    // Per-space emptiness probe — still one IPC per space.id (no
    // batched list_blocks shape today).
    for (const space of availableSpaces) {
      const id = space.id
      if (!emptinessFetchedRef.current.has(id)) {
        emptinessFetchedRef.current.add(id)
        void (async () => {
          try {
            const result = await listBlocks({
              blockType: 'page',
              spaceId: id,
              limit: listBlocksLimit(1),
            })
            if (!active) return
            // Spaces are themselves page blocks. The current
            // `listBlocks(blockType:'page', spaceId)` query returns
            // only pages whose `space` property points at the target —
            // the space block itself does NOT carry a `space` property
            // (it *is* the space) and therefore never appears here.
            // So `items.length === 0` correctly reflects emptiness.
            setEmptinessBySpace((prev) => ({ ...prev, [id]: result.items.length === 0 }))
          } catch (err) {
            // On error, allow a retry on the next render so the user
            // can recover by reopening the dialog. Delete stays
            // disabled until a probe succeeds.
            if (active) emptinessFetchedRef.current.delete(id)
            logger.warn(LOG_MODULE, 'failed to probe space emptiness', { spaceId: id }, err)
          }
        })()
      }
    }
    // Single-IPC batched journal-template fetch — covers every
    // un-fetched space id in one `getBatchProperties` call.
    const journalIdsToFetch = availableSpaces
      .map((s) => s.id)
      .filter((id) => !journalTemplateFetchedRef.current.has(id))
    if (journalIdsToFetch.length > 0) {
      // Reserve all ids up-front so a concurrent re-render doesn't
      // re-issue the batch. On error, release them again so the next
      // render can retry.
      for (const id of journalIdsToFetch) journalTemplateFetchedRef.current.add(id)
      void (async () => {
        try {
          const result = await getBatchProperties(journalIdsToFetch)
          if (!active) return
          setJournalTemplateBySpace((prev) => {
            const next = { ...prev }
            for (const id of journalIdsToFetch) {
              const props = result[id] ?? []
              const row = props.find((p) => p.key === 'journal_template')
              next[id] = row?.value_text ?? ''
            }
            return next
          })
        } catch (err) {
          if (active) {
            for (const id of journalIdsToFetch) journalTemplateFetchedRef.current.delete(id)
          }
          logger.warn(
            LOG_MODULE,
            'failed to load journal template properties',
            { spaceIds: journalIdsToFetch },
            err,
          )
        }
      })()
    }
    return () => {
      active = false
    }
  }, [availableSpaces])

  const handleJournalTemplateCommitted = useCallback((spaceId: string, value: string) => {
    setJournalTemplateBySpace((prev) => ({ ...prev, [spaceId]: value }))
  }, [])

  const rows = useMemo(
    () =>
      availableSpaces.map((space) => (
        <SpaceRowEditor
          key={space.id}
          space={space}
          isLastSpace={availableSpaces.length === 1}
          onRefresh={handleRefresh}
          emptiness={emptinessBySpace[space.id] ?? null}
          initialJournalTemplate={journalTemplateBySpace[space.id]}
          onJournalTemplateCommitted={handleJournalTemplateCommitted}
        />
      )),
    [
      availableSpaces,
      handleRefresh,
      emptinessBySpace,
      journalTemplateBySpace,
      handleJournalTemplateCommitted,
    ],
  )

  return (
    <TooltipProvider>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent data-testid="space-manage-dialog">
          <DialogHeader>
            <DialogTitle>{t('space.manageDialogTitle')}</DialogTitle>
            <DialogDescription>{t('space.manageDialogDescription')}</DialogDescription>
          </DialogHeader>
          <DialogBody>
            <SpaceOnboardingHint open={open} availableSpaceCount={availableSpaces.length} />
            <div data-slot="space-manage-list">{rows}</div>
            <div className="flex justify-end pt-2">
              <CreateSpaceForm onCreated={handleRefresh} />
            </div>
          </DialogBody>
        </DialogContent>
      </Dialog>
    </TooltipProvider>
  )
}
