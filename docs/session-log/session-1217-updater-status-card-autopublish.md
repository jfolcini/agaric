# Session 1217 — Update-status card + auto-publish release

**Issues:** update-button discoverability (AppImage report); release auto-publish (maintainer decision 2026-07-23)

## Problem

Two related update-flow gaps surfaced by the maintainer's "I don't see the update button in
the AppImage version":

1. The Help → Updates affordance gave no persistent feedback. The check was silent-on-error
   and only surfaced a one-shot toast when an update existed, so a user who clicked "Check
   for updates" and was already current (or hit an error) saw nothing — reading as a broken
   button. (The button is NOT platform-gated; the only gate is mobile.)
2. Releases were left as DRAFTS for a manual publish. During the draft window the updater's
   `releases/latest/download/latest.json` 404s. The maintainer chose to remove the manual
   gate and auto-publish once every terminal job is green.

## Fix

1. **Persistent update-status on the card (card-status only, no header badge).**
   - `src/lib/preferences.ts` — `UpdateStatusValue { status: idle|checking|up-to-date|available|error, currentVersion?, availableVersion?, error?, lastCheckedAt? }`, registered as `PREFERENCES.updateStatus` under `agaric:update-status` (separate from the existing `agaric:last-update-check` 24h-debounce key).
   - `src/hooks/useUpdateCheck.ts` — a module-level external store + `useUpdateStatus()` (`useSyncExternalStore`). Status transitions wired into both the boot and manual check paths; the transient `checking` state is in-memory only (never persisted → a reload can't stick on "Checking…"); terminal states persist. The error branch captures `err.message` instead of swallowing it, while the boot path stays toast-silent.
   - `src/components/settings/HelpTab.tsx` — the Updates card renders the status in an `<output>` polite live region: `Up to date (v{current})` / `Update available: v{available}` / `Last check failed: {error}` / `Checking…` / `Never checked`, plus a relative "Last checked {ago}" line. Current version from `@tauri-apps/api/app#getVersion` (updater metadata when an update exists).
   - `src/lib/i18n/common.ts` — new `help.update*` keys.

2. **`publish-release` job (`.github/workflows/release.yml`).** A terminal job running
   `gh release edit "$TAG" --repo "$REPO" --draft=false --latest`, `needs` + `if`-guarded on
   ALL terminal jobs succeeding: `build-and-release`, `android-build-and-release`,
   `generate-vex`, `generate-latest-json`, `finalize-release-notes`. `!cancelled() && each ==
   'success'` means a failed/skipped dependency leaves the release a DRAFT (identical to the
   old manual fallback). `permissions: contents: write` (minimal); no third-party actions; no
   `github.event.*` injection surface.

## Verification

- `npx vitest run useUpdateCheck.test.tsx HelpTab.test.tsx preferences.test.ts` → 77 passed
  (success→available, success→up-to-date, manual + silent-boot error paths, persistence
  round-trip, reactive `useUpdateStatus`, HelpTab per-state render incl. `axe` on the error state).
- `npx tsc -b` → 0; `npx oxlint` → 0; `actionlint release.yml` → 0; YAML parse OK.
- Adversarial review hardened the auto-publish gate: `generate-vex` was only covered
  transitively via `finalize-release-notes`'s own `if`; added it directly to
  `publish-release`'s `needs`/`if` so the release-critical gate is self-contained. Confirmed
  `!cancelled()` does not relax the `== 'success'` checks and the worst case is a release that
  stays a draft.

## Note

The gate requires `android-build-and-release` success, so a transient Android failure blocks
the whole (atomic) release until re-run — consistent with the pre-existing
`finalize-release-notes` gating and the maintainer's atomic-release policy.
