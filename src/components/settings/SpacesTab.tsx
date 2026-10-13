/**
 * SpacesTab — Settings › Spaces (#5362): the space this device opens in on
 * launch, one row per space (rename, delete, accent colour), and the create
 * form.
 *
 * SettingsView mounts a tab only while it is active, so each visit probes
 * every space's emptiness afresh (#5284).
 *
 * `useSpaceStore.refreshAvailableSpaces()` is the single refresh seam after
 * every mutation, so the SpaceSwitcher re-renders within a tick.
 */

import { Check, Plus } from 'lucide-react'
import type React from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import {
  ACCENT_SWATCHES,
  type AccentToken,
} from '@/components/settings/SpacesTab/SpaceAccentPicker'
import { SpaceRowEditor } from '@/components/settings/SpacesTab/SpaceRowEditor'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { SettingRow, settingDescriptionId } from '@/components/ui/setting-row'
import { unwrap } from '@/lib/app-error'
import { commands, type SpaceRow } from '@/lib/bindings'
import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'
import { PREFERENCES, usePreference } from '@/lib/preferences'
import { listBlocksLimit } from '@/lib/safe-limit'
import { requireActiveScope } from '@/lib/space-scope'
import { cn } from '@/lib/utils'
import { useSpaceStore } from '@/stores/space'

const LOG_MODULE = 'components/settings/SpacesTab'

/** `SelectItem` needs a non-empty value; this one stands for the stored `null`. */
const LAST_USED = '__last_used__'

const DEFAULT_SPACE_SELECT_ID = 'default-space-select'

interface CreateSpaceFormProps {
  onCreated: () => Promise<void> | void
}

/**
 * Inline "create new space" form. Submits via the `createSpace` IPC; on
 * success the form resets, closes, and the parent refreshes
 * `availableSpaces`.
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
      unwrap(await commands.createSpace(trimmed, accent ?? null))
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
        <div
          className="flex flex-wrap gap-1.5"
          // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- toolbar-like group of swatch buttons; <fieldset>/<optgroup> etc. break the flex layout and add unwanted form/list semantics
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
              {/* same icon-overlay rationale as the per-row
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

/** "Open on launch": Last used (the default), or one space. Per device. */
function DefaultSpaceRow({ spaces }: { spaces: SpaceRow[] }): React.ReactElement {
  const { t } = useTranslation()
  const [defaultSpace, setDefaultSpace] = usePreference(PREFERENCES.defaultSpace)
  return (
    <SettingRow
      label={t('settings.spaces.openOnLaunchLabel')}
      controlId={DEFAULT_SPACE_SELECT_ID}
      description={t('settings.spaces.openOnLaunchHelp')}
    >
      <Select
        value={defaultSpace ?? LAST_USED}
        onValueChange={(value) => setDefaultSpace(value === LAST_USED ? null : value)}
      >
        <SelectTrigger
          id={DEFAULT_SPACE_SELECT_ID}
          className="sm:w-48"
          aria-describedby={settingDescriptionId(DEFAULT_SPACE_SELECT_ID)}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={LAST_USED}>{t('settings.spaces.lastUsed')}</SelectItem>
          {spaces.map((space) => (
            <SelectItem key={space.id} value={space.id}>
              {space.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </SettingRow>
  )
}

export function SpacesTab(): React.ReactElement {
  const { t } = useTranslation()
  const availableSpaces = useSpaceStore((s) => s.availableSpaces)
  const refreshAvailableSpaces = useSpaceStore((s) => s.refreshAvailableSpaces)

  // The per-space emptiness probe is owned here so each IPC fires once
  // per unique `space.id` per visit, not once per row mount.
  //
  // Cache contract:
  //  - missing key   = not yet fetched (or last fetch errored)
  //  - present value = resolved successful fetch result
  //
  // Errors deliberately do *not* poison the cache: the key is removed
  // from the in-flight set so the next `availableSpaces` change retries
  // it. A revisit is a fresh mount and probes every space anyway.
  const [emptinessBySpace, setEmptinessBySpace] = useState<Record<string, boolean>>({})
  const emptinessFetchedRef = useRef<Set<string>>(new Set())

  // B-7: `mountedRef` prevents post-unmount setState on the async
  // probes. A result is dropped only on unmount: a space list change
  // mid-flight must not drop it, or the id stays marked fetched and its
  // row never gets a value (#5284). The `listBlocks` emptiness probe is
  // per-space because no batched `list_blocks` shape exists yet.
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  useEffect(() => {
    for (const space of availableSpaces) {
      const id = space.id
      if (!emptinessFetchedRef.current.has(id)) {
        emptinessFetchedRef.current.add(id)
        void (async () => {
          try {
            const result = unwrap(
              await commands.listBlocks(
                {
                  parentId: null,
                  blockType: 'page',
                  tagId: null,
                  date: null,
                  dateRange: null,
                  source: null,
                  excludeTodoStates: null,
                  cursor: null,
                  limit: listBlocksLimit(1),
                },
                requireActiveScope(id),
              ),
            )
            if (!mountedRef.current) return
            // Spaces are themselves page blocks, but a space block carries
            // no `space` property (it *is* the space), so it never appears
            // in its own scoped listing: `items.length === 0` is emptiness.
            setEmptinessBySpace((prev) => ({ ...prev, [id]: result.items.length === 0 }))
          } catch (err) {
            // Delete stays disabled until a probe succeeds.
            emptinessFetchedRef.current.delete(id)
            logger.warn(LOG_MODULE, 'failed to probe space emptiness', { spaceId: id }, err)
          }
        })()
      }
    }
  }, [availableSpaces])

  return (
    <Card>
      <CardContent className="space-y-6">
        <p className="text-sm text-muted-foreground">{t('settings.spaces.description')}</p>
        <DefaultSpaceRow spaces={availableSpaces} />
        <div>
          <div data-slot="space-manage-list">
            {availableSpaces.map((space) => (
              <SpaceRowEditor
                key={space.id}
                space={space}
                isLastSpace={availableSpaces.length === 1}
                onRefresh={refreshAvailableSpaces}
                emptiness={emptinessBySpace[space.id] ?? null}
              />
            ))}
          </div>
          <div className="flex justify-end pt-2">
            <CreateSpaceForm onCreated={refreshAvailableSpaces} />
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
