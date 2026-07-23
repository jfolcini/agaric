# Session 1207 — Updater/release hardening, Flatpak self-update guard, single-step pickers

**Date:** 2026-07-23
**Closes:** #2974, #2973, #2971, #3001
**Related:** #3027 (session 1206, shipped separately); a test-mock fix (#3055) landed alongside.

A parallel batch across the release/updater surface and the editor toolbar. Each item shipped as
its own PR; this log covers the batch.

## #2974 — Flathub scaffold: drop the phantom arm64 `.deb`, disable the self-updater under Flatpak

`packaging/flathub/io.github.jfolcini.Agaric.yml` referenced an arm64 `.deb` the release pipeline
never builds. Removed that source block. More importantly, Flathub requires apps not to
self-update (updates flow through Flathub's repo/CI), so:

- `src-tauri/src/lib.rs`: added `fn running_under_flatpak() -> bool` (stats `/.flatpak-info`) and
  wrapped `tauri_plugin_updater` registration in `run()` so the plugin is **not registered** under
  Flatpak.
- `src-tauri/src/commands/mod.rs`: new `is_flatpak` Tauri command (the renderer can't stat
  `/.flatpak-info` itself), registered in the shared command-list macro so `tauri-specta` codegen
  picks it up.
- `src/hooks/useUpdateCheck.ts`: the boot effect now asks `commands.isFlatpak()` and registers
  nothing (no initial check, no interval, no listeners) under Flatpak — belt-and-suspenders with
  the Rust-side registration guard. Defaults to non-Flatpak on any IPC error so a browser/dev
  session or a transient failure never silently disables auto-update for AppImage/`.deb` users.
- `src/lib/bindings.ts` + `src/lib/tauri-mock/handlers/system.ts`: the generated `isFlatpak`
  binding + mock handler (verified against `tauri-specta` codegen via the `ts_bindings_up_to_date`
  gate).

## #2973 — Updater re-checks periodically, not only at boot

`useUpdateCheck` ran a single boot-time check, so autostarted/tray instances open for weeks never
re-checked. Added a 24 h `setInterval` plus `visibilitychange`→visible and `online` listeners, all
routed through the existing `isWithinDebounceWindow` debounce + in-flight guard (no second
debounce), with full unmount cleanup; mobile still no-ops. (This and #2974 both touch the same boot
effect — merged so the Flatpak gate wraps the periodic triggers: a Flatpak instance registers none
of them.)

## #2971 — CI verifies updater signatures against the embedded pubkey

`release.yml` only asserted each `.sig` existed and was non-empty. Added
`scripts/verify-updater-signatures.sh` (base64-decodes the pinned minisign pubkey from
`tauri.conf.json` and each `.sig`, runs `minisign -V`) invoked in `generate-latest-json` before the
manifest is published, failing closed on wrong key / missing payload / empty / no `.sig`. Confirmed
from `tauri-plugin-updater` → `minisign-verify` crate source that a real Tauri `.sig` uses the exact
minisign on-disk format (trusted comment + global signature), so stock `minisign -V` is
format-faithful. Checkout hardened with `persist-credentials: false`.

## #3001 — Single-step callout-type & code-language pickers

Choosing a callout type / code language took two steps (primary click applied the default and
closed the menu; reopen to reach the secondary picker). Added a shared `InlinePicker` primitive
(auto-focused typeahead, Arrow/Enter nav, Esc-close, `onPointerDown` focus retention) and turned
the `TurnIntoMenu` code/callout rows into in-place disclosures, so type+variant is chosen in one
popover open by mouse or keyboard. Apply commands (`INSERT_CALLOUT`, `toggleCodeBlockSafely` /
`updateAttributes`) unchanged. The e2e `callout-picker.spec.ts` was updated to drive the new
single-step flow (same assertions). Review added a mutation-tested `TurnIntoMenu.test.tsx` and
corrected `FormattingToolbar.test.tsx` for the radio→disclosure contract.

## #3055 — test-mock fix (landed alongside)

`PagePropertyTable.test.tsx`'s hand-listed `vi.mock('lucide-react')` omitted `Check`, which
`ui/checkbox.tsx` renders — crashing that whole test file whenever the full vitest suite ran (latent
because `detect-changes` skips full vitest on many merges). Added `Check` to the mock.

## Known pre-existing issue (not addressed here)

A flaky `TypeError: Cannot read properties of null (reading 'can')` in
`FormattingToolbar`/`EditorSurface` (an `editor.can()` call during editor mount/teardown on the
mobile viewport, self-recovers on retry) surfaced while diagnosing #3001's e2e; it is unrelated to
any file in this batch and should be tracked separately.
