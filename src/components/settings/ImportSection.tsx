/**
 * ImportSection — the Import card of the Data settings tab, extracted from
 * `DataTab.tsx` (#2898 / #2932).
 *
 * Owns the hidden file inputs and their buttons for every import affordance
 * (`.md`/folder/Obsidian vault, Evernote `.enex`, Joplin `.jex`, and
 * bibliography), the shared progress + result region, and the format handlers.
 * The identical per-unit import bookkeeping lives in `useImportRunner`; each
 * handler here is thin wiring that builds its `ImportUnit[]` (via the pure
 * producers in `@/lib/vault-import`), drives the shared runner, then dispatches
 * its own format-specific summary toast. Bibliography (a single-IPC import that
 * shares the `importing` gate) lives in `./BibliographySection`.
 */

import { FileUp, FolderUp, Library, Upload, Vault } from 'lucide-react'
import type React from 'react'
import { useCallback, useId, useRef } from 'react'
import { useTranslation } from 'react-i18next'

import {
  BibliographyResultPanel,
  useBibliographyImport,
} from '@/components/settings/BibliographySection'
import { type FailedFile, useImportRunner } from '@/components/settings/useImportRunner'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { parseEnex } from '@/lib/enex-import'
import { formatBytes } from '@/lib/format'
import { parseJex } from '@/lib/jex-import'
import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'
import {
  type ImportUnit,
  enexNotesToUnits,
  importErrorReason,
  indexVaultFiles,
  jexNotesToUnits,
  mdFilesToUnits,
} from '@/lib/vault-import'
import { useSpaceStore } from '@/stores/space'

export function ImportSection(): React.ReactElement {
  const { t } = useTranslation()
  const currentSpaceId = useSpaceStore((s) => s.currentSpaceId)
  const availableSpaces = useSpaceStore((s) => s.availableSpaces)

  const fileInputRef = useRef<HTMLInputElement>(null)
  // #1927 — second hidden input carrying `webkitdirectory` so the user
  // can pick a whole folder/vault. The plain `fileInputRef` above keeps
  // its `.md`-only single-file/multi-file behaviour; this one populates
  // `file.webkitRelativePath` to drive the #1446 folder→namespace mapping.
  const folderInputRef = useRef<HTMLInputElement>(null)
  // #2510 — dedicated hidden `webkitdirectory` input for the "Import Obsidian
  // vault" affordance. It drives the exact SAME `handleFileImport` folder
  // pipeline as `folderInputRef` (an Obsidian vault IS a folder of `.md` files);
  // the separate, explicitly-named button/input just makes Obsidian support
  // discoverable. No behavioural fork on the FE — the backend already resolves
  // Obsidian wikilinks/`^block-id` anchors unconditionally on import.
  const obsidianVaultInputRef = useRef<HTMLInputElement>(null)
  // #1282 — hidden input for the Evernote `.enex` importer. Kept separate
  // from the `.md`/folder inputs since each `.enex` file expands into one
  // page PER note (ENML → Markdown), a different iteration unit than a file.
  const enexInputRef = useRef<HTMLInputElement>(null)
  // #2513 (part 2) — hidden input for the Joplin `.jex` importer. Kept separate
  // from the other inputs since a `.jex` archive expands into one page PER note
  // (like `.enex`), a different iteration unit than a file.
  const jexInputRef = useRef<HTMLInputElement>(null)
  // Stable id wires the disabled-button's
  // `aria-describedby` to the visible `t('data.importSpaceNotReady')`
  // hint, so screen-reader users hear WHY the button is unactionable.
  // The hint also fixes the mobile/touch path: the `title` attribute
  // alone is invisible on `pointer:coarse` (no hover) and is suppressed
  // on disabled buttons in most browsers (`pointer-events: none`).
  const importHintId = useId()

  const {
    importing,
    setImporting,
    importResult,
    detailsExpanded,
    setDetailsExpanded,
    currentFileIndex,
    currentFileName,
    totalFiles,
    blocksProcessed,
    bytesProcessed,
    currentFileBlocksDone,
    currentFileBlocksTotal,
    begin,
    cancel,
    run,
    goToImportedPage,
  } = useImportRunner()

  // #1454 — bibliography import (single-IPC) shares the `importing` gate.
  const { bibInputRef, bibResult, handleBibliographyImport } = useBibliographyImport(setImporting)

  const handleFileImport = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files
      if (!files || files.length === 0) return

      // `import_markdown` now requires a space_id; the backend rejects empty /
      // unknown ULIDs with `AppError::Validation`. The buttons are disabled
      // when `currentSpaceId` is null, so this branch is defensive.
      const activeSpaceId = useSpaceStore.getState().currentSpaceId
      if (activeSpaceId == null) {
        notify.error(t('data.importSpaceNotReady'))
        e.target.value = ''
        return
      }

      begin()
      const fileArray = Array.from(files)

      // #1925 — only a folder/vault pick (`webkitdirectory`) carries sibling
      // assets: the browser populates `webkitRelativePath` for folder picks and
      // leaves it empty for the plain `.md` multi-file pick. When ANY file has a
      // relative path we treat the run as a vault import and index the whole
      // FileList so each markdown's referenced attachments can be matched and
      // shipped. A single-file (non-folder) import has no siblings — documented
      // limitation — so `vaultIndex` stays null and `vaultFiles` is omitted.
      const isVaultImport = fileArray.some(
        (f) => typeof f.webkitRelativePath === 'string' && f.webkitRelativePath.length > 0,
      )
      const vaultIndex = isVaultImport ? indexVaultFiles(fileArray) : null
      const units = mdFilesToUnits(fileArray, vaultIndex)

      const { totalBlocks, succeededFiles, failedFiles, cancelled, navTitle } = await run({
        event: e,
        activeSpaceId,
        units,
        notes: false,
        loggerFailLabel: 'file import failed',
      })

      const viewAction =
        navTitle != null
          ? {
              label: t('data.importViewAction'),
              onClick: () => {
                void goToImportedPage(navTitle, activeSpaceId)
              },
            }
          : undefined

      if (cancelled) {
        // #1927 — user aborted mid-loop. Report how many imported before
        // cancel rather than a generic success/error.
        notify(t('data.importCancelled', { count: succeededFiles }))
      } else if (totalBlocks === 0) {
        // Nothing imported — either every file failed or all files were
        // empty. Never fire a success toast here (#1928); surface an error.
        notify.error(
          failedFiles.length > 0
            ? t('data.importAllFailed', { count: failedFiles.length })
            : t('data.importNoContent'),
        )
      } else if (failedFiles.length > 0) {
        // Partial failure: some files imported, some did not. Report the
        // failures with a retry affordance rather than a green success toast.
        notify.retry(t('data.importFailuresHeading', { count: failedFiles.length }), () =>
          fileInputRef.current?.click(),
        )
      } else {
        notify.success(t('data.importedMessage', { totalBlocks, count: succeededFiles }), {
          action: viewAction,
        })
      }
    },
    [t, begin, run, goToImportedPage],
  )

  // #1282 — Evernote `.enex` import. Frontend-only: each picked `.enex` file
  // is parsed in the browser (`parseEnex`) and each note it contains becomes a
  // page via the SAME `importMarkdown` IPC as the `.md` path — one note → one
  // page. A parse failure fires its OWN per-file toast; `parseFailures` gates
  // the end-of-run summary so it does not double-toast on top of them.
  const handleEnexImport = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files
      if (!files || files.length === 0) return

      const activeSpaceId = useSpaceStore.getState().currentSpaceId
      if (activeSpaceId == null) {
        notify.error(t('data.importSpaceNotReady'))
        e.target.value = ''
        return
      }

      begin()

      const fileArray = Array.from(files)
      const parseFailures: FailedFile[] = []
      // Flatten every note across every picked file into a single unit list.
      const units: ImportUnit[] = []
      for (const file of fileArray) {
        try {
          units.push(...enexNotesToUnits(parseEnex(await file.text())))
        } catch (err) {
          logger.error(
            'DataSettingsTab',
            `enex parse failed: ${file.name}`,
            { fileName: file.name },
            err,
          )
          notify.error(t('data.importEnexParseFailed', { name: file.name }))
          parseFailures.push({ name: file.name, reason: importErrorReason(err) })
        }
      }

      const { totalBlocks, succeededFiles, failedFiles, cancelled, navTitle } = await run({
        event: e,
        activeSpaceId,
        units,
        notes: true,
        loggerFailLabel: 'enex note failed',
        initialFailures: parseFailures,
      })

      const viewAction =
        navTitle != null
          ? {
              label: t('data.importViewAction'),
              onClick: () => {
                void goToImportedPage(navTitle, activeSpaceId)
              },
            }
          : undefined

      if (cancelled) {
        notify(t('data.importCancelled', { count: succeededFiles }))
      } else if (totalBlocks === 0) {
        // #2513 — nothing imported. Each PARSE failure already fired its own
        // per-file error toast above (`importEnexParseFailed`), so the summary
        // fallback must only fire when there is MORE to say: a note that PARSED
        // but failed to import (no per-file toast), or a genuinely empty
        // selection. When every failure was a parse failure we stay silent
        // here and let the per-file toasts stand.
        const noteImportFailures = failedFiles.length - parseFailures.length
        if (noteImportFailures > 0) {
          notify.error(t('data.importAllFailed', { count: failedFiles.length }))
        } else if (failedFiles.length === 0) {
          notify.error(t('data.importNoContent'))
        }
      } else if (failedFiles.length > 0) {
        notify.retry(t('data.importFailuresHeading', { count: failedFiles.length }), () =>
          enexInputRef.current?.click(),
        )
      } else {
        // #2513 — each unit is a NOTE (not a file), so label the aggregate
        // toast "notes" rather than reusing the file-worded `.md` string.
        notify.success(t('data.importedNotesMessage', { totalBlocks, count: succeededFiles }), {
          action: viewAction,
        })
      }
    },
    [t, begin, run, goToImportedPage],
  )

  // #2513 (part 2) — Joplin `.jex` import. Frontend-only: the picked `.jex` tar
  // archive is unpacked in the browser (`parseJex`) and each note becomes a
  // page via the shared `importMarkdown` IPC. Referenced resources ship as
  // `vaultFiles` (the folder-import attachment path). Mirrors `handleEnexImport`
  // including the no-double-toast gating; adds soft `preWarnings` for skipped
  // (e.g. encrypted) items.
  const handleJexImport = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files
      if (!files || files.length === 0) return

      const activeSpaceId = useSpaceStore.getState().currentSpaceId
      if (activeSpaceId == null) {
        notify.error(t('data.importSpaceNotReady'))
        e.target.value = ''
        return
      }

      begin()

      const fileArray = Array.from(files)
      const parseFailures: FailedFile[] = []
      // Soft warnings surfaced in the result panel (e.g. skipped encrypted items).
      const preWarnings: string[] = []
      // Flatten every note across every picked archive into a single unit list.
      const units: ImportUnit[] = []
      for (const file of fileArray) {
        try {
          const buf = await file.arrayBuffer()
          const { notes, skipped } = parseJex(new Uint8Array(buf))
          // An archive that yields no notes is treated as a parse failure so the
          // user gets an explicit "not a valid Joplin export" toast rather than a
          // silent no-op (mirrors the `.enex` malformed-file behaviour).
          if (notes.length === 0) {
            throw new Error('no importable notes found in archive')
          }
          if (skipped > 0) preWarnings.push(t('data.importJexSkipped', { count: skipped }))
          units.push(...jexNotesToUnits(notes))
        } catch (err) {
          logger.error(
            'DataSettingsTab',
            `jex parse failed: ${file.name}`,
            { fileName: file.name },
            err,
          )
          notify.error(t('data.importJexParseFailed', { name: file.name }))
          parseFailures.push({ name: file.name, reason: importErrorReason(err) })
        }
      }

      const { totalBlocks, succeededFiles, failedFiles, cancelled, navTitle } = await run({
        event: e,
        activeSpaceId,
        units,
        notes: true,
        loggerFailLabel: 'jex note import failed',
        initialWarnings: preWarnings,
        initialFailures: parseFailures,
      })

      const viewAction =
        navTitle != null
          ? {
              label: t('data.importViewAction'),
              onClick: () => {
                void goToImportedPage(navTitle, activeSpaceId)
              },
            }
          : undefined

      if (cancelled) {
        notify(t('data.importCancelled', { count: succeededFiles }))
      } else if (totalBlocks === 0) {
        // #2513 — nothing imported. Each PARSE failure already fired its own
        // per-file toast, so the summary fallback only fires when there is MORE
        // to say (a note that PARSED but failed to import, or an empty
        // selection), mirroring the `.enex` path's no-double-toast gating.
        const noteImportFailures = failedFiles.length - parseFailures.length
        if (noteImportFailures > 0) {
          notify.error(t('data.importAllFailed', { count: failedFiles.length }))
        } else if (failedFiles.length === 0) {
          notify.error(t('data.importNoContent'))
        }
      } else if (failedFiles.length > 0) {
        notify.retry(t('data.importFailuresHeading', { count: failedFiles.length }), () =>
          jexInputRef.current?.click(),
        )
      } else {
        // Each unit is a NOTE (one page per note), so label it "notes".
        notify.success(t('data.importedNotesMessage', { totalBlocks, count: succeededFiles }), {
          action: viewAction,
        })
      }
    },
    [t, begin, run, goToImportedPage],
  )

  // #1927 — name of the space an import will land in, for the target
  // label below the controls. `null` when no space is active (the
  // not-ready hint covers that case instead).
  const currentSpaceName =
    currentSpaceId == null
      ? null
      : (availableSpaces.find((s) => s.id === currentSpaceId)?.name ?? null)

  // Shared gating props for every import affordance. `import_markdown` requires
  // a live `space_id`, so each button is disabled until a space is active and,
  // when gated, points at the visible + AT-announced not-ready hint.
  const importGated = currentSpaceId == null
  const importDisabled = importing || importGated
  const importGatedTitle = importGated ? t('data.importSpaceNotReady') : undefined
  const importGatedDescribedBy = importGated ? importHintId : undefined

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle
          className="import-panel-title flex items-center gap-2"
          data-testid="import-panel-title"
        >
          <Upload className="h-4 w-4" />
          {t('data.importTitle')}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-xs text-muted-foreground mb-3">{t('data.importDesc')}</p>
        <div className="flex flex-wrap gap-2">
          <input
            type="file"
            accept=".md"
            multiple
            ref={fileInputRef}
            className="hidden"
            onChange={handleFileImport}
            data-testid="import-file-input"
            aria-label={t('data.importButton')}
          />
          {/* #1927 — second, separate input carrying `webkitdirectory`
              so the OS opens a folder picker. This is what populates
              `file.webkitRelativePath`, the only way the #1446
              folder→namespace mapping can ever trigger; the `.md`-only
              input above never sets it. `webkitdirectory` is not in the
              React DOM typings, so spread it as a lowercased attribute. */}
          <input
            type="file"
            {...{ webkitdirectory: '', directory: '' }}
            ref={folderInputRef}
            className="hidden"
            onChange={handleFileImport}
            data-testid="import-folder-input"
            aria-label={t('data.importFolderButton')}
          />
          <Button
            variant="outline"
            size="sm"
            onClick={() => fileInputRef.current?.click()}
            // `import_markdown` now requires a
            // valid `space_id`; gate the button on the SpaceStore
            // having an active space so we never call the IPC with
            // an empty string. On the rare first-boot path before
            // hydration, `currentSpaceId` is null and the button
            // stays disabled. The visible hint below + the `title`
            // attribute surface WHY (the disabled button itself
            // can't fire hover events on most browsers because
            // `disabled:pointer-events-none`, so we don't rely on
            // the tooltip alone).
            disabled={importDisabled}
            title={importGatedTitle}
            aria-describedby={importGatedDescribedBy}
          >
            <Upload className="h-3.5 w-3.5" />{' '}
            {importing ? t('data.importingMessage') : t('data.importButton')}
          </Button>
          {/* #1927 — folder/vault import affordance. Same gating + flow
              as the files button; only the source input differs. */}
          <Button
            variant="outline"
            size="sm"
            onClick={() => folderInputRef.current?.click()}
            disabled={importDisabled}
            title={importGatedTitle}
            aria-describedby={importGatedDescribedBy}
            data-testid="import-folder-button"
          >
            <FolderUp className="h-3.5 w-3.5" /> {t('data.importFolderButton')}
          </Button>
          {/* #2510 — dedicated "Import Obsidian vault" affordance. A vault is
              a folder pick, so it reuses the SAME `webkitdirectory` input +
              `handleFileImport` flow as the generic folder button; the
              explicit Obsidian label/icon makes the (already-working)
              Obsidian support discoverable. `webkitdirectory` is not in the
              React DOM typings, so spread it as a lowercased attribute. */}
          <input
            type="file"
            {...{ webkitdirectory: '', directory: '' }}
            ref={obsidianVaultInputRef}
            className="hidden"
            onChange={handleFileImport}
            data-testid="import-obsidian-input"
            aria-label={t('data.importObsidianButton')}
          />
          <Button
            variant="outline"
            size="sm"
            onClick={() => obsidianVaultInputRef.current?.click()}
            disabled={importDisabled}
            title={importGatedTitle}
            aria-describedby={importGatedDescribedBy}
            data-testid="import-obsidian-button"
          >
            <Vault className="h-3.5 w-3.5" /> {t('data.importObsidianButton')}
          </Button>
          {/* #1282 — Evernote `.enex` import affordance. Same gating + flow
              as the files button; each note in the picked file(s) becomes a
              page via the shared `importMarkdown` IPC. */}
          <input
            type="file"
            accept=".enex"
            multiple
            ref={enexInputRef}
            className="hidden"
            onChange={handleEnexImport}
            data-testid="import-enex-input"
            aria-label={t('data.importEnexButton')}
          />
          <Button
            variant="outline"
            size="sm"
            onClick={() => enexInputRef.current?.click()}
            disabled={importDisabled}
            title={importGatedTitle}
            aria-describedby={importGatedDescribedBy}
            data-testid="import-enex-button"
          >
            <FileUp className="h-3.5 w-3.5" /> {t('data.importEnexButton')}
          </Button>
          {/* #2513 (part 2) — Joplin `.jex` import affordance. Same gating +
              flow as the Evernote button; each note in the picked archive
              becomes a page via the shared `importMarkdown` IPC. */}
          <input
            type="file"
            accept=".jex"
            multiple
            ref={jexInputRef}
            className="hidden"
            onChange={handleJexImport}
            data-testid="import-jex-input"
            aria-label={t('data.importJexButton')}
          />
          <Button
            variant="outline"
            size="sm"
            onClick={() => jexInputRef.current?.click()}
            disabled={importDisabled}
            title={importGatedTitle}
            aria-describedby={importGatedDescribedBy}
            data-testid="import-jex-button"
          >
            <FileUp className="h-3.5 w-3.5" /> {t('data.importJexButton')}
          </Button>
          {/* #1454 — bibliography import affordance. Same gating + flow as
              the other import buttons; a single `.bib`/`.json` pick maps to
              one `import_bibliography` IPC (one page per entry). */}
          <input
            type="file"
            accept=".bib,.json"
            ref={bibInputRef}
            className="hidden"
            onChange={handleBibliographyImport}
            data-testid="import-bib-input"
            aria-label={t('data.importBibliographyButton')}
          />
          <Button
            variant="outline"
            size="sm"
            onClick={() => bibInputRef.current?.click()}
            disabled={importDisabled}
            title={importGatedTitle}
            aria-describedby={importGatedDescribedBy}
            data-testid="import-bib-button"
          >
            <Library className="h-3.5 w-3.5" /> {t('data.importBibliographyButton')}
          </Button>
          {/* #1927 — Cancel is only shown while a run is in flight. It
              sets the abort flag the file loop checks between files. */}
          {importing && (
            <Button variant="outline" size="sm" onClick={cancel} data-testid="import-cancel-button">
              {t('data.importCancelButton')}
            </Button>
          )}
        </div>
        {/* #1927 — surface the import target so the destination space is
            never silent. Only meaningful once a space is active (the
            not-ready hint covers the null case). */}
        {currentSpaceId != null && currentSpaceName != null && (
          <p className="text-xs text-muted-foreground mt-2" data-testid="import-target-space">
            {t('data.importTargetSpace', { name: currentSpaceName })}
          </p>
        )}
        {currentSpaceId == null && (
          // Visible inline hint on the
          // pre-bootstrap disabled state. `role="status"` +
          // `aria-live="polite"` so screen readers announce the
          // reason once the SpaceStore hydration kicks the user
          // into this branch; `aria-describedby` on the disabled
          // Button above also points here.
          <p
            id={importHintId}
            // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- role lives on a <p> referenced by aria-describedby on the disabled Button; swapping to <output> would lose paragraph semantics and is not a valid p replacement
            role="status"
            aria-live="polite"
            className="text-xs text-muted-foreground mt-2"
            data-testid="import-space-not-ready-hint"
          >
            {t('data.importSpaceNotReady')}
          </p>
        )}
        {currentFileIndex !== null && (
          <>
            <p
              className="text-xs text-muted-foreground mt-2"
              data-testid="import-progress"
              aria-live="polite"
            >
              {t('data.importingProgress', {
                index: currentFileIndex,
                total: totalFiles,
                name: currentFileName,
              })}
            </p>
            {/* secondary line showing cumulative blocks and
                bytes processed so far. Hidden on the very first file
                (before any IPC has returned) to avoid showing
                "0 blocks · 0 B" — once at least one file completes,
                this gives a visible forward motion even if the next
                file is large and slow. */}
            {(blocksProcessed > 0 || bytesProcessed > 0) && (
              <p
                className="text-xs text-muted-foreground mt-1"
                data-testid="import-progress-detail"
              >
                {t('data.importingProgressDetail', {
                  blocks: blocksProcessed,
                  bytes: formatBytes(bytesProcessed),
                })}
              </p>
            )}
            {/* paired progress bar so users get a visual signal
                alongside the textual "Importing N of M" message. No
                design-system Progress primitive yet — use the native
                <progress> element. */}
            <progress
              className="w-full h-1 mt-2"
              data-testid="import-progress-bar"
              aria-label={t('data.importFileProgressLabel')}
              value={currentFileIndex}
              max={totalFiles}
            />
            {/* #128 () — intra-file per-block
                progress streamed over a Channel. Shown only once the
                backend reports a block count (>0) for the current file,
                so a small / headings-only file doesn't flash an empty
                bar. Gives forward motion within a single large file. */}
            {currentFileBlocksTotal > 0 && (
              <>
                <p
                  className="text-xs text-muted-foreground mt-1"
                  data-testid="import-block-progress"
                  aria-live="polite"
                >
                  {t('data.importingBlocks', {
                    done: currentFileBlocksDone,
                    total: currentFileBlocksTotal,
                  })}
                </p>
                <progress
                  className="w-full h-1 mt-1"
                  data-testid="import-block-progress-bar"
                  aria-label={t('data.importBlockProgressLabel')}
                  value={currentFileBlocksDone}
                  max={currentFileBlocksTotal}
                />
              </>
            )}
          </>
        )}
        {importResult &&
          (() => {
            // Derive presentation flags. `allFailed` (nothing imported, at
            // least one hard failure) drives the error-toned state instead
            // of a silent "0 blocks" line (#1928).
            const {
              failures,
              warnings,
              blocksCreated,
              propertiesSet,
              fileCount,
              pageTitle,
              navTitle,
              notes,
            } = importResult
            const allFailed = blocksCreated === 0 && failures.length > 0
            const hasDetail = failures.length > 0 || warnings.length > 0
            // Cap the at-rest list; the toggle reveals the rest.
            const PREVIEW = 5
            const shownFailures = detailsExpanded ? failures : failures.slice(0, PREVIEW)
            const shownWarnings = detailsExpanded ? warnings : warnings.slice(0, PREVIEW)
            const truncated = failures.length > PREVIEW || warnings.length > PREVIEW
            const title =
              pageTitle ??
              t(notes ? 'data.importResultNotesTitle' : 'data.importResultFilesTitle', {
                count: fileCount,
              })
            return (
              <div
                className="import-result mt-3 text-xs space-y-1"
                data-testid="import-result"
                // Announce the outcome once the progress region clears
                // (#1929), mirroring the not-ready hint pattern above.
                // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- block-level status wrapper holding the summary <p> and the <details> list; <output> is inline-level and would change the block flow of the result region
                role="status"
                aria-live="polite"
                aria-atomic="true"
              >
                {allFailed ? (
                  <p className="text-destructive" data-testid="import-result-error">
                    {t('data.importAllFailed', { count: failures.length })}
                  </p>
                ) : (
                  <p className="text-status-done-foreground">
                    {t('data.importResultSummary', { title, count: blocksCreated })}
                    {propertiesSet > 0 &&
                      `, ${t('data.importResultProperties', { count: propertiesSet })}`}
                  </p>
                )}
                {/* #1927 — post-import navigation: jump to what was
                    imported (single file → that page; multi-file → the
                    last imported page in the target space). */}
                {navTitle != null && currentSpaceId != null && (
                  <button
                    type="button"
                    className="underline text-status-done-foreground"
                    data-testid="import-view-button"
                    onClick={() => {
                      void goToImportedPage(navTitle, currentSpaceId)
                    }}
                  >
                    {t('data.importViewAction')}
                  </button>
                )}
                {hasDetail && (
                  <details data-testid="import-result-details">
                    <summary className="cursor-pointer text-status-pending-foreground">
                      {failures.length > 0 && (
                        <span className="text-destructive" data-testid="import-failures-heading">
                          {t('data.importFailuresHeading', { count: failures.length })}
                        </span>
                      )}
                      {failures.length > 0 && warnings.length > 0 && ' · '}
                      {warnings.length > 0 && (
                        <span data-testid="import-warnings-heading">
                          {t('data.importWarningsHeading', { count: warnings.length })}
                        </span>
                      )}
                    </summary>
                    <ul
                      className="mt-1 space-y-0.5 max-h-40 overflow-y-auto"
                      data-testid="import-result-detail-list"
                    >
                      {shownFailures.map(({ name, reason }, i) => (
                        <li
                          // A vault import can surface the same basename
                          // from different folders, so index-qualify.
                          // oxlint-disable-next-line react/no-array-index-key -- failure basenames can duplicate across folders; the list is render-only (no reorder/insert), so the positional index is a stable, unique key
                          key={`fail-${i}-${name}`}
                          className="text-destructive"
                          data-testid="import-failure-item"
                        >
                          {/* #1935 — show WHY the file failed when a reason
                              was extracted; fall back to the reason-less
                              label otherwise. */}
                          {reason
                            ? t('data.importFailedFileDetail', { name, reason })
                            : t('data.importFailedFile', { name })}
                        </li>
                      ))}
                      {shownWarnings.map((warning, i) => (
                        <li
                          // Warnings are free-form strings and may repeat, so
                          // index-qualify the key to keep it stable+unique.
                          // oxlint-disable-next-line react/no-array-index-key -- warning strings are free-form and may duplicate; the list is render-only (no reorder/insert), so the positional index is a stable, unique key
                          key={`warn-${i}-${warning}`}
                          className="text-status-pending-foreground"
                          data-testid="import-warning-item"
                        >
                          {warning}
                        </li>
                      ))}
                    </ul>
                    {truncated && (
                      <button
                        type="button"
                        className="mt-1 underline text-muted-foreground"
                        data-testid="import-details-toggle"
                        onClick={() => setDetailsExpanded((v) => !v)}
                      >
                        {detailsExpanded ? t('data.importShowLess') : t('data.importShowAll')}
                      </button>
                    )}
                  </details>
                )}
              </div>
            )
          })()}
        {/* #1454 — bibliography import outcome (summary + warnings). */}
        {bibResult && <BibliographyResultPanel result={bibResult} />}
      </CardContent>
    </Card>
  )
}
