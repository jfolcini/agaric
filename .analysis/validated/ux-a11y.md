# Validation — UX & Accessibility (ux-a11y.md)

**Verdict tally:** CONFIRMED 4 · CONFIRMED-BUT-RESEVERITY 0 · EXAGGERATED 0 · ALREADY-HANDLED 1 (the LOW pickers) · HALLUCINATED-in-part 1 (same pickers item — its central claim is false) · TRIVIAL/drop 1 (PeerListItem).

The HIGH holds. One LOW finding (the aria-modal focus-trap one) is wrong on its core claim and should be dropped.

---

### [HIGH] Destructive tag-delete dialog: hardcoded English + missing `variant="destructive"` — VERDICT: CONFIRMED
- **Evidence checked**: `src/components/TagList.tsx:390-400` — `<ConfirmDialog>` with `title="Delete tag?"`, `cancelLabel="Cancel"`, `actionLabel="Delete"`, an English template `description`, and NO `variant` prop. `ConfirmDialog.tsx:193-194` (`effectiveVariant = variant ?? 'default'`; `isDestructive = false`), and the footer: Cancel gets `autoFocus={isDestructive}` (=false, lines 343/304) while the Action button gets `autoFocus={!isDestructive}` (=true, lines 364/325). So with the variant omitted, initial focus lands on the **Delete** action and a reflex Enter confirms — exactly as the report states. The focus mechanism is described correctly and precisely.
- **Irreversibility**: `TagList.tsx:126-143` `handleDeleteTag` does `deleteBlock(tagId)` then `purgeBlock(tagId)` (hard purge), with no undo affordance and no success toast. So the action is genuinely irreversible. The report's "this action cannot be undone" is accurate.
- **i18n defect**: confirmed — every other label in the file uses `t()` (e.g. `tagList.renameInputLabel` :385, `tags.*` notify strings :84-181); only this destructive dialog ships hardcoded English.
- **Nuance (minor)**: the report's *prose summary* (top of file) loosely says TagList "bypasses the i18n-first ConfirmDialog" — it does NOT use a raw AlertDialog; it uses the shared `ConfirmDialog` via its legacy pre-resolved-string path without `variant`. The finding body itself states this correctly ("legacy pre-resolved string path"). No correction needed to the finding.
- **Severity**: HIGH is justified. Two compounding defects (untranslated destructive copy for all non-English locales + default focus on an irreversible Delete) on a hard-purge action. Keep HIGH.
- **Better-approach**: as proposed — add `titleKey`/`descriptionKey`/`confirmKey`/`cancelKey` + `values` for `deleteTarget.name`, and `variant="destructive"`. Fix is S.

### [MEDIUM] TrashView batch restore/purge swallow errors — VERDICT: CONFIRMED
- **Evidence checked**: `TrashView.tsx:175-196` (`handleBatchRestore`) and `:232-248` (`handleBatchPurge`). Both `catch` only `logger.warn(...)`, then unconditionally `reload(); clearSelection();` and only `notify.success`+`announce` when count `> 0`. On a thrown error, count stays 0 → no toast, no announce, selection wiped. Single-item siblings DO notify: `:141 notify.error(t('trash.restoreFailed'))`, `:158 notify.error(t('trash.purgeFailed'))`; the all-variants also notify on failure (`:262`, `:279`). The inconsistency is real.
- Minor: the report cites `:262`/`:279` as "single-item" — those are actually `handleEmptyTrash`/`handleRestoreAll`; the true single-item paths are `:141`/`:158`. The point (every non-batch path notifies, the two batch paths don't) is unaffected.
- **Severity**: MEDIUM appropriate (read-data integrity not at risk, but a failed bulk op is indistinguishable from a no-op and selection is gone). Fix S: add `notify.error`+`announce` in catch and don't clear selection on failure.

### [MEDIUM] DonePanel renders empty on load failure — VERDICT: CONFIRMED
- **Evidence checked**: `DonePanel.tsx:93-97` and `:138-141` — both catch blocks only `logger.error`, never set blocks or an error flag; `setLoading(false)` in `finally`. Render guard `:269` `if (!loading && blocks.length === 0) return null` and `empty={null}` at :288. So a thrown load is visually identical to a legitimately empty panel — no toast/banner/announce. Comment at :265-268 confirms the empty-render is a deliberate UX decision, but that decision did not account for the failure case.
- **Severity**: MEDIUM is fine (author already notes it's bounded — secondary read-only panel, recovers on next load). Fix S: track `loadError`, render a small `role="alert"` retry or at minimum `notify.error`+`announce`.

### [LOW] QrScanner raw untranslated error via aria-live="assertive" — VERDICT: CONFIRMED
- **Evidence checked**: `QrScanner.tsx:102-111` — `const message = err instanceof Error ? err.message : 'Camera access denied'` (hardcoded English fallback + raw browser/html5-qrcode message), `setError(message)`; rendered at `:125-132` in `<p aria-live="assertive">{error}</p>`. Rest of file uses `t('qrScanner.*')`. There IS an `onCameraDenied?()` fallback to manual entry (:110), so LOW severity is right.
- Fix S as proposed: map common failure classes to `t('qrScanner.*')`, keep `err.message` in the logger only.

### [LOW] Custom aria-modal pickers lack a Tab focus-trap — VERDICT: ALREADY-HANDLED / core claim HALLUCINATED — DROP
- **Evidence checked**: `TemplatePicker.tsx:60-92`. The report claims "There is no Tab/Shift-Tab wrap handler." This is **false**: lines 70-74 handle `e.key === 'Tab'` with `e.preventDefault(); e.stopPropagation(); trapTabFocus(dialog, e.shiftKey)`. It also handles Escape (:62), Arrow nav (:76-79), and focus-restore (:101-103). So TemplatePicker DOES trap Tab.
- `JournalCalendarDropdown.tsx:216-217`: `role="dialog"` but an explicit comment "Intentionally NOT aria-modal: this is a lightweight anchored dropdown." It has Escape (:183) and focus-restore (:174-176). So it does NOT assert modality — the finding's premise (aria-modal without trap) does not apply to it either.
- The author hedged ("did not exhaustively confirm JournalCalendarDropdown"), but the central technical assertion is incorrect for both components. **Drop this finding.**

### [LOW] PeerListItem hardcoded placeholder — VERDICT: TRIVIAL / DROP
- **Evidence checked**: `PeerListItem.tsx:150` `placeholder="192.168.1.100:5000"`. It is a locale-neutral IP:port format example. Author already self-rated it trivial. Drop — not worth filing.

---

## Net assessment — file-worthy, ranked

1. **[HIGH] TagList destructive delete** (`TagList.tsx:390-400`) — file it. Verified on all three axes (hardcoded i18n, focus-on-Delete via confirmed ConfirmDialog mechanism, irreversible hard purge). Strongest finding.
2. **[MEDIUM] TrashView batch silent failure** (`TrashView.tsx:175-196`, `232-248`) — file it. Clear, real inconsistency with sibling handlers; small fix.
3. **[MEDIUM] DonePanel empty-on-failure** (`DonePanel.tsx:93-97`, `138-141`, `269`) — file it (or fold with TrashView into one "silent load/batch failure" issue). Bounded but real.
4. **[LOW] QrScanner untranslated assertive error** (`QrScanner.tsx:102-111`, `125-132`) — file it (low priority; first-run mobile flow).

**Killed:** the two LOW pickers/placeholder items. The aria-modal-without-trap finding is factually wrong (Tab IS trapped; the other component is deliberately non-modal); the placeholder is trivial. Both should be dropped by the synthesizer.
