# Session 4038 — Boot failure: the recovery steps, and a way to the data folder

Third checkbox of #6554, continued in a cloud session from the overnight batch's parked `wip:` commit (#6667).

**What it does.** `docs/TROUBLESHOOTING.md` gains § 8, *Agaric failed to start: the vault will not open*: the error strings by cause, the data folder per platform, the `notes.db.pre-migration-<time>` backups and how to open one, and the rule that a device restored from a backup after it has synced must be set up fresh and re-paired (export what the others lack first). The boot-failure dialog links that section and, on desktop, offers *Open data folder* and *Copy details* (version, platform, error, the link) beside *Close*. An action brings the dialog back, so the user can paste the details while Agaric still owns the clipboard.

**Decisions and traps.**

- The dialog does not touch the pool: it runs in `setup_app` after `boot` failed, from the resolved data dir alone, and the *Open data folder* button is left out when that dir cannot be resolved.
- Linux uses GTK's own `MessageDialog` on the setup thread, not `rfd`: `rfd` runs a GTK dialog on its own thread, which waits for the main context tao's event loop holds through setup, so it never showed. The main window is hidden first.
- Windows needs `rfd`'s `common-controls-v6` feature for custom button labels; without it the buttons read Yes / No / Cancel.
- Android: no dialog and no button, as before; § 8 says where the error is in `adb logcat`.

**Tests.** A Rust test pins that the dialog's link names a real heading of `TROUBLESHOOTING.md` (GitHub's anchor rule), so renaming the heading reddens it; another that *Copy details* carries the version, platform, error and link. The dialogs themselves need a display and a person: they are on the beta checklists (#6514, #6515 and Linux), not tested here.

**Ran.** The new Rust tests, clippy for the workspace.
