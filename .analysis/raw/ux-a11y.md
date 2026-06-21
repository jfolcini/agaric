# UX & Accessibility Analysis — Agaric Frontend (`src/components/`)

**Summary.** Agaric's UX/a11y posture is genuinely strong and heavily prior-audited:
a mandatory `IconButton` (tooltip + aria-label enforced by the type system), an i18n-first
`ConfirmDialog` with destructive-focus-flip + mobile-Sheet rendering, live regions
(`aria-live` / `role="status"` / `role="alert"`) across async surfaces, a dedicated
`usePrefersReducedMotion` hook, a `touch-target` (44px) utility, focus restore in custom
popovers, and a fully i18n'd toast layer (zero hardcoded `notify.*`/`toast.*` strings).
Low-hanging fruit is gone. The real findings are a few **silent-failure** spots where a
thrown load/batch operation surfaces nothing to the user, and one component (`TagList`)
that bypasses the i18n-first `ConfirmDialog` API for a **destructive** delete — shipping
hardcoded English AND losing the safe Cancel-focus default.

**Counts:** HIGH 1 · MEDIUM 2 · LOW 3

---

### [HIGH] Destructive tag-delete dialog: hardcoded English + missing `variant="destructive"` (loses safe-focus default)
- **Location**: src/components/TagList.tsx:390-400
- **Evidence**: The delete confirm dialog uses the legacy pre-resolved string path:
  `title="Delete tag?"`, `cancelLabel="Cancel"`, `actionLabel="Delete"`, and an inline
  English `description` template (`"This will delete the tag …. This action cannot be
  undone. " + t('tags.deleteWarning')`). It does NOT pass `variant="destructive"`.
- **Problem**: Two distinct defects in one dialog. (1) i18n: every other label in this same
  file uses `t()` (e.g. `tagList.renameInputLabel` at :385), but this destructive dialog
  ships untranslated English — non-English users see mixed-language UI. (2) a11y/safety:
  `ConfirmDialog` only auto-focuses the safe **Cancel** button when `variant ===
  'destructive'` (see ConfirmDialog.tsx:194, :343 — "Destructive dialogs auto-focus Cancel
  so reflex Enter dismisses"). Omitting the variant means initial focus lands on the
  **Delete** action, so a reflex Enter confirms an irreversible tag delete — exactly the
  footgun ConfirmDialog was designed to prevent.
- **Impact**: Accidental irreversible tag deletion via keyboard; untranslated destructive
  copy for all non-English locales.
- **Fix**: Switch to the i18n-first API — add `titleKey`/`descriptionKey`/`confirmKey`/
  `cancelKey` (new entries in `src/lib/i18n/`), interpolate `deleteTarget.name` via
  `values`, and add `variant="destructive"`.
- **Confidence**: high — verified ConfirmDialog's focus logic and the call site directly.
- **Effort**: S

---

### [MEDIUM] TrashView batch restore/purge swallow errors — no toast, selection silently cleared
- **Location**: src/components/TrashView.tsx:186-196 (`handleBatchRestore`), 232-248 (`handleBatchPurge`)
- **Evidence**: Both batch handlers wrap the IPC in `try { … } catch (err) {
  logger.warn(...) }` and then unconditionally `reload(); clearSelection();` and only
  `notify.success(...)` when `count > 0`. On a thrown error the count stays 0, so the user
  gets **no toast, no announce** — and their selection is wiped.
- **Problem**: The single-item paths in this same file all surface failures
  (`:141 notify.error(t('trash.restoreFailed'))`, `:158`, `:262`, `:279`), so the batch
  paths are inconsistent silent failures. The user can't tell a "nothing happened because
  it failed" from a "nothing matched" outcome.
- **Impact**: A failed bulk restore/purge looks like a no-op; the user may assume success
  or retry blindly, with their selection already gone.
- **Fix**: In the `catch`, call `notify.error(t('trash.batchRestoreFailed'))` /
  `notify.error(t('trash.batchPurgeFailed'))` + `announce(...)`, and do not clear selection
  on failure so a retry is possible.
- **Confidence**: high — both handlers read in full; single-item siblings confirmed to notify.
- **Effort**: S

---

### [MEDIUM] DonePanel renders an empty panel on load failure (failure ≡ "none yet")
- **Location**: src/components/agenda/DonePanel.tsx:93-97, 138-142 (catch blocks); 265-289 (empty render)
- **Evidence**: `loadDone` does `catch (err) { logger.error(...) } finally {
  setLoading(false) }` and never sets blocks or an error flag. The render comment at :265
  states "Render nothing when empty … an empty 'none yet' panel" and the list passes
  `empty={null}`.
- **Problem**: When the IPC throws, `loading` flips false and `blocks` stays empty, so a
  load failure is visually indistinguishable from a legitimately empty "Done today" panel —
  no toast, no error banner, no `aria-live` announcement. Other agenda surfaces (e.g.
  GraphView.tsx:273 `setError(t('graph.loadFailed'))`) render an explicit error state.
- **Impact**: Completed-items list silently vanishes on a transient backend error; the user
  believes they completed nothing.
- **Fix**: Track a `loadError` state and render a small `role="alert"` retry affordance (or
  at minimum a `notify.error` + `announce`) when the catch fires, mirroring GraphView.
- **Confidence**: medium — confirmed catch + empty-render path; severity is bounded because
  this is a secondary read-only panel and the data reappears on next successful load.
- **Effort**: S

---

### [LOW] QrScanner surfaces raw, untranslated browser error text via `aria-live="assertive"`
- **Location**: src/components/peers/QrScanner.tsx:102-104, 125-132
- **Evidence**: `const message = err instanceof Error ? err.message : 'Camera access
  denied'` then `setError(message)`; the error `<p aria-live="assertive">{error}</p>`
  announces it. The fallback string is a hardcoded English literal, and `err.message` is the
  raw html5-qrcode/browser message (e.g. "Requested device not found").
- **Problem**: Pairing is a first-run, mobile-critical flow. The most user-visible error
  copy here is untranslated and technical, unlike the rest of the file which uses
  `t('qrScanner.*')`. Assertive live-region makes the raw text especially jarring for SR users.
- **Impact**: Confusing, locale-inconsistent camera-permission errors in the pairing flow.
- **Fix**: Map common failure classes (permission denied / no camera) to localized
  `t('qrScanner.*')` strings; keep `err.message` only in the logger.
- **Confidence**: high (code read directly); low severity — there is a `onCameraDenied`
  fallback to manual entry, so the user isn't fully stuck.
- **Effort**: S

---

### [LOW] Custom `role="dialog" aria-modal="true"` pickers claim modality without a Tab focus-trap
- **Location**: src/components/block-tree/TemplatePicker.tsx:113-145 (and similar
  src/components/journal/JournalCalendarDropdown.tsx)
- **Evidence**: TemplatePicker sets `role="dialog" aria-modal="true"`, auto-focuses the
  first `<button>` (:99-100), restores focus on close (:101-103), and handles Escape via a
  document keydown listener (:90). There is no Tab/Shift-Tab wrap handler.
- **Problem**: `aria-modal="true"` asserts the rest of the page is inert, but keyboard Tab
  from the last item moves focus to background DOM (the backdrop is `role="presentation"`,
  non-focusable, so it doesn't intercept). SR users (who honor aria-modal) and sighted
  keyboard users get divergent reality. Radix-based dialogs in this codebase (e.g.
  GestureCoachMark, ConfirmDialog) trap focus for free; these two hand-rolled pickers don't.
- **Impact**: Keyboard focus can leak behind a "modal" picker; minor since Escape + click-out
  + focus-restore all work and the surface is transient.
- **Fix**: Either add a small focus-trap (wrap Tab within the dialog) or migrate these to the
  Radix `Popover`/`Dialog` primitive already used elsewhere.
- **Confidence**: medium — verified TemplatePicker's handlers; did not exhaustively confirm
  JournalCalendarDropdown lacks a trap beyond the shared backdrop pattern.
- **Effort**: M

---

### [LOW] `PeerListItem` manual-address input placeholder is a hardcoded literal
- **Location**: src/components/peers/PeerListItem.tsx:150
- **Evidence**: `placeholder="192.168.1.100:5000"`.
- **Problem**: A hardcoded placeholder. It is an IP:port *format example*, which is locale-
  neutral, so this is borderline — flagged only for completeness. No real translation need.
- **Impact**: Negligible; documented here so the validator knows it was considered and
  deliberately rated trivial.
- **Confidence**: high — it is a universal numeric format example, not prose.
- **Effort**: S

---

## Areas reviewed / not reviewed

**Reviewed (focused):** `ui/` primitives (icon-button, ConfirmDialog, dialog, sheet,
tooltip, button — all exemplary); dialogs/ (ConfirmDialog, GestureCoachMark, QrScanner,
PairingDialog live regions); i18n usage across components (`t()`, `notify.*`, `toast.*` —
clean except TagList); silent-failure sweep of ~50 catch blocks in `src/components/**`
(TrashView batch + DonePanel are the only genuine gaps; rest notify+log+announce
consistently); non-button `onClick` sweep (only `role="presentation"` backdrops found —
fine); `aria-live`/`role` coverage; reduced-motion (`usePrefersReducedMotion`, 30 files);
touch-target utility (44px); focus restore in custom pickers (TemplatePicker).

**Not deeply reviewed:** the TipTap editor block internals (roving-tabindex correctness is
an explicit architecture invariant — left to the editor/perf agents); color-contrast token
values in `src/index.css` (requires a rendering/visual pass, not static analysis); the
full agenda/ and graph/ keyboard-navigation matrices beyond spot checks; `e2e/` Playwright
a11y assertions (out of scope per shared rules).

**Cross-dimension note:** TrashView batch handlers (:175-248) issue a single batch IPC and
clear selection before confirming success — the data-integrity/correctness agent may want
to confirm the post-batch `reload()` reconciles partial-success counts correctly.
