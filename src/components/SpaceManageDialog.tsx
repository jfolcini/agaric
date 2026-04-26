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
 * the hint never reappears.
 *
 * Reuses existing primitives — no new dialog primitive, no new store.
 * `useSpaceStore.refreshAvailableSpaces()` is the single refresh seam
 * after every mutation so the SpaceSwitcher re-renders within a tick.
 */

import { Plus, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button, buttonVariants } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { i18n } from '@/lib/i18n'
import { logger } from '@/lib/logger'
import type { SpaceRow } from '@/lib/tauri'
import { createSpace, deleteBlock, editBlock, listBlocks, setProperty } from '@/lib/tauri'
import { cn } from '@/lib/utils'
import { useSpaceStore } from '@/stores/space'

const LOG_MODULE = 'components/SpaceManageDialog'

/**
 * Palette tokens consumed by FEAT-3p10. Stored verbatim in the
 * `accent_color` property; the visual identity layer maps them to
 * concrete CSS custom properties at render time. Kept in module scope
 * so tests can import the same source of truth without duplication.
 */
export const ACCENT_SWATCHES = [
  { token: 'accent-emerald', label: 'emerald', className: 'bg-emerald-500' },
  { token: 'accent-blue', label: 'blue', className: 'bg-blue-500' },
  { token: 'accent-violet', label: 'violet', className: 'bg-violet-500' },
  { token: 'accent-amber', label: 'amber', className: 'bg-amber-500' },
  { token: 'accent-rose', label: 'rose', className: 'bg-rose-500' },
  { token: 'accent-slate', label: 'slate', className: 'bg-slate-500' },
] as const

type AccentToken = (typeof ACCENT_SWATCHES)[number]['token']

interface SpaceManageDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

/** Localised localStorage key. Single source of truth via i18n so a
 * future white-label keep can rename it without grepping. */
function onboardingStorageKey(): string {
  return i18n.t('space.onboardingSeenKey')
}

/**
 * Read the dismissal flag for the onboarding hint. Returns `false`
 * when `localStorage` access throws (Private Browsing on iOS) so the
 * hint at worst shows once per session.
 */
function readOnboardingSeen(): boolean {
  try {
    return localStorage.getItem(onboardingStorageKey()) === 'true'
  } catch {
    return false
  }
}

function writeOnboardingSeen(): void {
  try {
    localStorage.setItem(onboardingStorageKey(), 'true')
  } catch (err) {
    logger.warn(LOG_MODULE, 'failed to persist onboarding-dismissed flag', undefined, err)
  }
}

interface SpaceRowEditorProps {
  space: SpaceRow
  /** True when this is the only space — delete forbidden. */
  isLastSpace: boolean
  /** Refresh callback after a successful mutation. */
  onRefresh: () => Promise<void> | void
}

/**
 * Per-space row: inline-editable name + accent picker + delete button.
 * Emptiness check is fired lazily via `listBlocks({ spaceId, limit: 1 })`
 * once per row mount so the Delete button knows whether to be enabled.
 */
function SpaceRowEditor({ space, isLastSpace, onRefresh }: SpaceRowEditorProps) {
  const { t } = useTranslation()
  const [name, setName] = useState(space.name)
  const [accent, setAccent] = useState<AccentToken | null>(null)
  const [isEmpty, setIsEmpty] = useState<boolean | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [savingAccent, setSavingAccent] = useState(false)
  const renameInputId = useId()

  // Re-sync local state when the upstream `space.name` changes — for
  // instance after the user renames it elsewhere or refreshAvailableSpaces
  // returns server truth that differs from optimistic state.
  useEffect(() => {
    setName(space.name)
  }, [space.name])

  // Fire the emptiness probe once per `space.id`. We treat unknown
  // (`null`) as "still loading" → Delete stays disabled. Once resolved
  // we either flip to `true` (no pages) or `false` (≥1 page).
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const result = await listBlocks({
          blockType: 'page',
          spaceId: space.id,
          limit: 1,
        })
        if (cancelled) return
        // Spaces are themselves page blocks. The current
        // `listBlocks(blockType:'page', spaceId)` query returns only
        // pages whose `space` property points at the target — the
        // space block itself does NOT carry a `space` property (it
        // *is* the space) and therefore never appears here. So
        // `items.length === 0` correctly reflects emptiness.
        setIsEmpty(result.items.length === 0)
      } catch (err) {
        if (cancelled) return
        // On error, leave `isEmpty` as `null` (delete stays disabled).
        // The user sees the disabled button + tooltip; refreshing the
        // dialog re-runs the probe.
        logger.warn(LOG_MODULE, 'failed to probe space emptiness', { spaceId: space.id }, err)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [space.id])

  const handleRenameCommit = useCallback(async () => {
    const trimmed = name.trim()
    if (!trimmed || trimmed === space.name) {
      setName(space.name)
      return
    }
    try {
      await editBlock(space.id, trimmed)
      await onRefresh()
    } catch (err) {
      logger.error(LOG_MODULE, 'rename failed', { spaceId: space.id }, err)
      toast.error(t('space.renameFailed'))
      setName(space.name)
    }
  }, [name, space.name, space.id, onRefresh, t])

  const handleRenameKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        ;(e.target as HTMLInputElement).blur()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        setName(space.name)
        ;(e.target as HTMLInputElement).blur()
      }
    },
    [space.name],
  )

  const handleAccentClick = useCallback(
    async (token: AccentToken) => {
      setSavingAccent(true)
      const previous = accent
      setAccent(token)
      try {
        await setProperty({
          blockId: space.id,
          key: 'accent_color',
          valueText: token,
        })
      } catch (err) {
        logger.error(LOG_MODULE, 'accent color update failed', { spaceId: space.id }, err)
        toast.error(t('space.accentFailed'))
        setAccent(previous)
      } finally {
        setSavingAccent(false)
      }
    },
    [accent, space.id, t],
  )

  const handleDeleteConfirm = useCallback(async () => {
    try {
      await deleteBlock(space.id)
      setConfirmOpen(false)
      await onRefresh()
    } catch (err) {
      logger.error(LOG_MODULE, 'delete failed', { spaceId: space.id }, err)
      toast.error(t('space.deleteFailed'))
    }
  }, [space.id, onRefresh, t])

  const deleteDisabledReason: string | null = isLastSpace
    ? t('space.deleteLastTooltipDisabled')
    : isEmpty === true
      ? null
      : t('space.deleteSpaceTooltipDisabled')

  const deleteEnabled = deleteDisabledReason === null

  return (
    <div data-slot="space-manage-row" className="flex flex-col gap-2 border-b py-3 last:border-b-0">
      <div className="flex items-center gap-2">
        <Label htmlFor={renameInputId} className="sr-only">
          {t('space.renameLabel')}
        </Label>
        <Input
          id={renameInputId}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => void handleRenameCommit()}
          onKeyDown={handleRenameKeyDown}
          aria-label={t('space.renameLabel')}
          className="flex-1"
        />
        {deleteEnabled ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t('space.deleteSpaceLabel')}
            onClick={() => setConfirmOpen(true)}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        ) : (
          <Tooltip>
            <TooltipTrigger asChild>
              <span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t('space.deleteSpaceLabel')}
                  disabled
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </span>
            </TooltipTrigger>
            <TooltipContent side="left">{deleteDisabledReason}</TooltipContent>
          </Tooltip>
        )}
      </div>
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">{t('space.accentColorLabel')}:</span>
        {/* biome-ignore lint/a11y/useSemanticElements: a swatch picker is not a `<fieldset>`-style form group; `role="group"` + per-button `aria-pressed` is the conventional WAI-ARIA pattern for a single-select toolbar of toggle buttons */}
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
              disabled={savingAccent}
              onClick={() => void handleAccentClick(swatch.token)}
              className={cn(
                'inline-block rounded-full ring-offset-background transition-all',
                'h-5 w-5 [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11',
                'focus-visible:outline-hidden focus-visible:ring-[3px] focus-visible:ring-ring/50',
                'disabled:opacity-50 disabled:cursor-not-allowed',
                accent === swatch.token && 'ring-2 ring-ring ring-offset-2',
                swatch.className,
              )}
              data-accent-token={swatch.token}
            />
          ))}
        </div>
      </div>
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('space.deleteConfirmTitle', { name: space.name })}
            </AlertDialogTitle>
            <AlertDialogDescription>{t('space.deleteConfirmDescription')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel autoFocus>{t('space.cancelLabel')}</AlertDialogCancel>
            <AlertDialogAction
              className={buttonVariants({ variant: 'destructive' })}
              onClick={() => void handleDeleteConfirm()}
            >
              {t('action.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
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
      toast.error(t('space.createSpaceFailed'))
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
        {/* biome-ignore lint/a11y/useSemanticElements: same swatch-picker pattern as the per-row picker above — see the rationale comment there */}
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
                'inline-block rounded-full ring-offset-background transition-all',
                'h-5 w-5 [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11',
                'focus-visible:outline-hidden focus-visible:ring-[3px] focus-visible:ring-ring/50',
                accent === swatch.token && 'ring-2 ring-ring ring-offset-2',
                swatch.className,
              )}
              data-accent-token={swatch.token}
            />
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

interface OnboardingHintProps {
  onDismiss: () => void
}

function OnboardingHint({ onDismiss }: OnboardingHintProps) {
  const { t } = useTranslation()
  return (
    <div
      role="note"
      aria-label={t('space.onboardingTitle')}
      className="rounded-md border bg-muted/40 p-3 text-sm"
    >
      <p className="font-medium">{t('space.onboardingTitle')}</p>
      <p className="mt-1 text-muted-foreground">{t('space.onboardingBody')}</p>
      <div className="mt-2 flex justify-end">
        <Button type="button" size="sm" variant="outline" onClick={onDismiss}>
          {t('space.onboardingDismiss')}
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

  // Onboarding flag — read once per dialog open so dismissal during the
  // session is reflected in real time. Track in component state so the
  // banner unmounts immediately on dismiss.
  const [onboardingVisible, setOnboardingVisible] = useState(false)
  useEffect(() => {
    if (!open) return
    setOnboardingVisible(availableSpaces.length <= 2 && !readOnboardingSeen())
  }, [open, availableSpaces.length])

  const handleDismissOnboarding = useCallback(() => {
    writeOnboardingSeen()
    setOnboardingVisible(false)
  }, [])

  const handleRefresh = useCallback(async () => {
    await refreshAvailableSpaces()
  }, [refreshAvailableSpaces])

  // Memoise the row list so the per-row `useEffect` (emptiness probe)
  // doesn't re-fire on every parent re-render.
  const rows = useMemo(
    () =>
      availableSpaces.map((space) => (
        <SpaceRowEditor
          key={space.id}
          space={space}
          isLastSpace={availableSpaces.length === 1}
          onRefresh={handleRefresh}
        />
      )),
    [availableSpaces, handleRefresh],
  )

  return (
    <TooltipProvider>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent data-testid="space-manage-dialog" className="max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t('space.manageDialogTitle')}</DialogTitle>
            <DialogDescription>{t('space.manageDialogDescription')}</DialogDescription>
          </DialogHeader>
          {onboardingVisible && <OnboardingHint onDismiss={handleDismissOnboarding} />}
          <div data-slot="space-manage-list">{rows}</div>
          <div className="flex justify-end pt-2">
            <CreateSpaceForm onCreated={handleRefresh} />
          </div>
        </DialogContent>
      </Dialog>
    </TooltipProvider>
  )
}
