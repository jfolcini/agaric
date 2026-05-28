/**
 * SpaceJournalTemplateEditor — markdown textarea for the per-space
 * `journal_template` override.
 *
 * Extracted from `SpaceRowEditor` (PEND-30 D-2). The pre-extraction
 * version carried a `journalTemplateInitializedRef` flag that fired
 * once when the parent's async-resolved `initialJournalTemplate` prop
 * transitioned from `undefined` to a defined string. The ref existed
 * to prevent a *second* prop update (e.g. parent cache invalidation
 * after our own commit) from clobbering an in-flight user edit.
 *
 * The ref is gone in this version. The state model now matches the
 * intent:
 *
 *  1. The parent must NOT mount this component until it has a
 *     resolved initial value (`initialJournalTemplate !== undefined`).
 *     This makes the loading seam explicit at the call site rather
 *     than hidden inside a ref.
 *
 *  2. `initialValue` is consumed exactly once via `useState`'s lazy
 *     initialiser. Subsequent prop changes are intentionally ignored
 *     — the component is the authoritative source of its own draft
 *     after first mount. Parent state transitions (e.g. our own
 *     `onCommitted` callback fanning the new value back into the
 *     cache) cannot clobber an unsaved edit.
 *
 * Behaviour preservation contract:
 *  - Empty trim → `deleteProperty('journal_template')`.
 *  - Non-empty trim → `setProperty('journal_template', trimmed)`.
 *  - Unchanged trim → no-op (no IPC, no toast).
 *  - On IPC failure the textarea reverts to the last successfully
 *    persisted value and a `space.journalTemplateFailed` toast fires.
 */

import { useCallback, useId, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'
import { deleteProperty, setProperty } from '@/lib/tauri'

const LOG_MODULE = 'components/SpaceManageDialog/SpaceJournalTemplateEditor'

interface SpaceJournalTemplateEditorProps {
  spaceId: string
  /**
   * Initial value seeded into the textarea on mount. Read **once** via
   * `useState` lazy init — subsequent prop updates are ignored.
   * Callers should remount this component (`key=`) if the underlying
   * canonical value needs to be force-refreshed.
   */
  initialValue: string
  /**
   * Notify the parent so its cache reflects the new committed value.
   */
  onCommitted: (spaceId: string, value: string) => void
}

export function SpaceJournalTemplateEditor({
  spaceId,
  initialValue,
  onCommitted,
}: SpaceJournalTemplateEditorProps): React.JSX.Element {
  const { t } = useTranslation()
  // Lazy initialiser: `initialValue` is captured exactly once on
  // mount. The parent guarantees a defined value before mounting (see
  // SpaceRowEditor.tsx — the gate is `initialJournalTemplate !==
  // undefined`), so there is no async-resolution seam to paper over.
  const [journalTemplate, setJournalTemplate] = useState<string>(initialValue)
  // `committedJournalTemplate` is the last successfully-persisted value
  // so a setProperty failure can revert without re-fetching from the
  // backend.
  const [committedJournalTemplate, setCommittedJournalTemplate] = useState<string>(initialValue)
  const [savingJournalTemplate, setSavingJournalTemplate] = useState(false)
  const journalTemplateInputId = useId()
  // FEAT-3p5b — id on the hint paragraph so the textarea can announce
  // it via `aria-describedby`. The hint paragraph is short ("Tip:
  // per-space template overrides the global journal-template page.")
  // and useful context for a screen-reader user encountering the field
  // for the first time, so promoting it from purely-visual to
  // accessibility-tree-reachable is worth the one extra `useId`.
  const journalTemplateHintId = useId()

  const handleCommit = useCallback(async () => {
    const trimmed = journalTemplate.trim()
    if (trimmed === committedJournalTemplate.trim()) {
      // No-op — value unchanged since last commit. Avoid a redundant
      // IPC round-trip and the toast/revert dance.
      return
    }
    setSavingJournalTemplate(true)
    const previous = committedJournalTemplate
    try {
      if (trimmed === '') {
        await deleteProperty(spaceId, 'journal_template')
      } else {
        await setProperty({
          blockId: spaceId,
          key: 'journal_template',
          valueText: trimmed,
        })
      }
      setCommittedJournalTemplate(trimmed)
      setJournalTemplate(trimmed)
      // Bubble the new committed value up so the parent's per-space.id
      // cache reflects this edit on a subsequent dialog re-open.
      onCommitted(spaceId, trimmed)
    } catch (err) {
      logger.error(LOG_MODULE, 'journal template update failed', { spaceId }, err)
      notify.error(t('space.journalTemplateFailed'))
      // Revert to the last successfully-persisted value so the textarea
      // reflects backend truth instead of the unsaved edit.
      setJournalTemplate(previous)
    } finally {
      setSavingJournalTemplate(false)
    }
  }, [journalTemplate, committedJournalTemplate, spaceId, t, onCommitted])

  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={journalTemplateInputId} className="text-xs text-muted-foreground">
        {t('space.journalTemplateLabel')}
      </Label>
      <Textarea
        id={journalTemplateInputId}
        rows={4}
        value={journalTemplate}
        onChange={(e) => setJournalTemplate(e.target.value)}
        onBlur={() => void handleCommit()}
        placeholder={t('space.journalTemplatePlaceholder')}
        aria-label={t('space.journalTemplateLabel')}
        aria-describedby={journalTemplateHintId}
        disabled={savingJournalTemplate}
        className="min-h-[6rem]"
      />
      <p id={journalTemplateHintId} className="text-xs text-muted-foreground">
        {t('space.journalTemplateHint')}
      </p>
      <details className="text-xs text-muted-foreground" data-testid="journal-template-examples">
        <summary className="cursor-pointer select-none hover:text-foreground transition-colors">
          {t('space.journalTemplateExamplesLabel')}
        </summary>
        <div className="mt-2 flex flex-col gap-2 pl-4 border-l-2 border-border">
          <div>
            <p className="font-medium text-foreground">{t('space.journalTemplateExample1Title')}</p>
            <pre className="mt-1 bg-muted rounded p-2 font-mono text-[11px] whitespace-pre-wrap">
              {t('space.journalTemplateExample1')}
            </pre>
          </div>
          <div>
            <p className="font-medium text-foreground">{t('space.journalTemplateExample2Title')}</p>
            <pre className="mt-1 bg-muted rounded p-2 font-mono text-[11px] whitespace-pre-wrap">
              {t('space.journalTemplateExample2')}
            </pre>
          </div>
        </div>
      </details>
    </div>
  )
}
