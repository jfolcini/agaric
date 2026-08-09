//! The single seam through which Agaric resolves its app-data directory —
//! "the vault": `notes.db`, `attachments/`, `logs/`, the device id, the sync
//! endpoint key, and the MCP socket all live under it.
//!
//! # Why this exists (#3334)
//!
//! Every resolution used to be a direct `app.path().app_data_dir()`, scattered
//! across seven call sites. That call derives a fixed OS location from the
//! bundle identifier in `tauri.conf.json` (`com.agaric.app`), so on Linux it is
//! always `$XDG_DATA_HOME/com.agaric.app`, i.e. the developer's REAL vault —
//! with no way to point a test run somewhere else. The WebdriverIO lane
//! (`wdio.conf.ts`) drives the real debug binary, creates journal blocks and
//! tags, and never cleaned up; on a developer machine every local run wrote
//! into that real vault, and a repeat run could pass green against the previous
//! run's leftovers.
//!
//! # The contract
//!
//! * [`DATA_DIR_ENV`] (`AGARIC_DATA_DIR`), when set to an ABSOLUTE path,
//!   replaces the OS-default directory everywhere.
//! * [`SANDBOX_ENV`] (`AGARIC_E2E_SANDBOX`), set by any harness that must never
//!   touch a real vault, turns a MISSING or SUSPICIOUS override into a hard
//!   boot failure instead of a silent fallback.
//!
//! That second half is the whole point. An isolation mechanism that degrades to
//! "use the real vault" when its input goes missing is worse than none, because
//! it invites trust it cannot honour: a typo in a harness env block, a spawn
//! that drops the environment, a refactor that stops forwarding it — each would
//! silently re-aim the suite at the developer's notes. Under `AGARIC_E2E_SANDBOX`
//! there is no fallback path to take: the process refuses to open any vault at
//! all rather than open the wrong one.
//!
//! [`decide`] is deliberately a pure function of three strings so the policy can
//! be unit-tested without a Tauri runtime, a filesystem, or (crucially) any risk
//! of a test touching a real directory — the tests assert on the RESOLVED PATH,
//! never on the effect of writing to it.

use std::path::{Path, PathBuf};

/// Absolute-path override for the app-data directory.
///
/// Honoured on every platform (unlike `XDG_DATA_HOME`, which only moves the
/// default on Linux), so a harness on macOS or Windows gets the same guarantee.
pub const DATA_DIR_ENV: &str = "AGARIC_DATA_DIR";

/// Set by a harness that must never operate on a real vault.
///
/// Presence of this flag makes [`DATA_DIR_ENV`] MANDATORY: see [`decide`].
pub const SANDBOX_ENV: &str = "AGARIC_E2E_SANDBOX";

/// What [`decide`] concluded from the environment.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Resolution {
    /// Use this caller-supplied absolute path.
    Override(PathBuf),
    /// No override in play — use the OS-standard identifier-derived directory.
    OsDefault,
}

/// Interpret a boolean-ish environment value.
///
/// `AGARIC_E2E_SANDBOX=0` / `false` / `no` / `off` / empty all mean "off" so a
/// shell that exports the variable unconditionally can still opt out; anything
/// else means on.
fn truthy(raw: &str) -> bool {
    !matches!(
        raw.trim().to_ascii_lowercase().as_str(),
        "" | "0" | "false" | "no" | "off"
    )
}

/// Decide where the app-data directory lives, from the environment alone.
///
/// `os_default` is the identifier-derived OS path (`None` if the platform
/// resolver itself failed); it is used only to reject an "override" that points
/// straight back at the real vault.
///
/// The error strings are user-facing: they surface in the boot failure dialog
/// (`lib.rs` `show_fatal_error_dialog`) and in the CI log of a sandboxed run, so
/// they name the variable, the offending value, and the fix.
pub(crate) fn decide(
    data_dir_raw: Option<&str>,
    sandbox_raw: Option<&str>,
    os_default: Option<&Path>,
) -> Result<Resolution, String> {
    let sandboxed = sandbox_raw.is_some_and(truthy);

    let Some(raw) = data_dir_raw else {
        if sandboxed {
            return Err(format!(
                "{SANDBOX_ENV} is set but {DATA_DIR_ENV} is not. Refusing to fall back to the \
                 OS-default app-data directory — that is the real vault, and a sandboxed run \
                 must never open it. Set {DATA_DIR_ENV} to a throwaway ABSOLUTE path (the \
                 WebdriverIO harness does this in wdio.conf.ts `beforeSession`), or unset \
                 {SANDBOX_ENV} if you genuinely meant to run against your own vault."
            ));
        }
        return Ok(Resolution::OsDefault);
    };

    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(format!(
            "{DATA_DIR_ENV} is set but empty. An empty override is the exact shape of a harness \
             bug (a variable exported before the value was computed), and honouring it as \
             \"unset\" would silently reopen the real vault. Unset it or give it an absolute path."
        ));
    }

    let path = PathBuf::from(trimmed);
    if !path.is_absolute() {
        return Err(format!(
            "{DATA_DIR_ENV}={trimmed:?} is not an absolute path. A relative override resolves \
             against the process working directory, which differs between a shell, a desktop \
             launcher and a WebDriver-spawned process — so no caller could verify where the \
             vault actually landed. Use an absolute path."
        ));
    }

    if sandboxed && os_default == Some(path.as_path()) {
        return Err(format!(
            "{SANDBOX_ENV} is set but {DATA_DIR_ENV}={trimmed:?} points at the OS-default \
             app-data directory — the real vault. A sandboxed run must use a throwaway \
             directory it created itself."
        ));
    }

    Ok(Resolution::Override(path))
}

/// Resolve the app-data directory for this process.
///
/// THE ONLY sanctioned caller of `app.path().app_data_dir()` in the codebase;
/// `scripts/check-vault-isolation.mjs` fails the commit if a second one appears,
/// because a call site that bypasses this seam would keep writing into the real
/// vault while the rest of the process ran in a sandbox — the worst of both.
pub fn resolve_app_data_dir<R, M>(app: &M) -> Result<PathBuf, std::io::Error>
where
    R: tauri::Runtime,
    M: tauri::Manager<R>,
{
    let os_default = app.path().app_data_dir();
    let data_dir_raw = std::env::var(DATA_DIR_ENV).ok();
    let sandbox_raw = std::env::var(SANDBOX_ENV).ok();

    let resolution = decide(
        data_dir_raw.as_deref(),
        sandbox_raw.as_deref(),
        os_default.as_deref().ok(),
    )
    .map_err(std::io::Error::other)?;

    match resolution {
        Resolution::Override(path) => Ok(path),
        Resolution::OsDefault => os_default.map_err(|e| std::io::Error::other(e.to_string())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const REAL_VAULT: &str = "/home/dev/.local/share/com.agaric.app";
    const SANDBOX: &str = "/tmp/agaric-wdio-vault/run-abc/vault";

    fn real_vault() -> Option<&'static Path> {
        Some(Path::new(REAL_VAULT))
    }

    // ── Plain developer run: nothing set, nothing changes ──────────────────

    #[test]
    fn no_override_and_no_sandbox_uses_the_os_default() {
        assert_eq!(
            decide(None, None, real_vault()),
            Ok(Resolution::OsDefault),
            "an ordinary app launch must keep resolving the OS-standard vault"
        );
    }

    #[test]
    fn an_explicitly_disabled_sandbox_flag_does_not_demand_an_override() {
        for off in ["0", "false", "no", "off", "", "  "] {
            assert_eq!(
                decide(None, Some(off), real_vault()),
                Ok(Resolution::OsDefault),
                "{SANDBOX_ENV}={off:?} means OFF, so the OS default stays legal"
            );
        }
    }

    // ── The override itself ────────────────────────────────────────────────

    #[test]
    fn an_absolute_override_wins_with_or_without_the_sandbox_flag() {
        for sandbox in [None, Some("1")] {
            assert_eq!(
                decide(Some(SANDBOX), sandbox, real_vault()),
                Ok(Resolution::Override(PathBuf::from(SANDBOX))),
                "an absolute {DATA_DIR_ENV} must replace the OS default"
            );
        }
    }

    #[test]
    fn surrounding_whitespace_is_trimmed_not_treated_as_a_path() {
        assert_eq!(
            decide(Some("  /tmp/vault  "), Some("1"), real_vault()),
            Ok(Resolution::Override(PathBuf::from("/tmp/vault"))),
        );
    }

    // ── The refusals: every one of these would otherwise mean "real vault" ──

    #[test]
    fn a_sandboxed_run_without_an_override_refuses_to_boot() {
        let err = decide(None, Some("1"), real_vault())
            .expect_err("a sandboxed run MUST NOT silently fall back to the OS-default vault");
        assert!(
            err.contains(DATA_DIR_ENV) && err.contains(SANDBOX_ENV),
            "the refusal must name both variables so the fix is obvious: {err}"
        );
    }

    #[test]
    fn a_sandboxed_run_refuses_even_when_the_os_default_is_unknown() {
        // A platform resolver failure must not become an accidental escape
        // hatch out of the sandbox contract.
        assert!(decide(None, Some("1"), None).is_err());
    }

    #[test]
    fn an_empty_override_is_an_error_not_an_absent_one() {
        for empty in ["", "   "] {
            assert!(
                decide(Some(empty), None, real_vault()).is_err(),
                "{DATA_DIR_ENV}={empty:?} must fail loudly, not degrade to the OS default"
            );
        }
    }

    #[test]
    fn a_relative_override_is_rejected() {
        for relative in ["vault", "./vault", "../vault"] {
            assert!(
                decide(Some(relative), None, real_vault()).is_err(),
                "{DATA_DIR_ENV}={relative:?} is unverifiable and must be rejected"
            );
        }
    }

    #[test]
    fn a_sandboxed_override_aimed_at_the_real_vault_is_rejected() {
        let err = decide(Some(REAL_VAULT), Some("1"), real_vault())
            .expect_err("pointing the sandbox at the OS-default vault defeats the whole point");
        assert!(
            err.contains(REAL_VAULT),
            "the refusal must show the path: {err}"
        );
    }

    #[test]
    fn the_same_path_is_fine_when_the_sandbox_flag_is_absent() {
        // Not every override is a test harness — a user relocating their vault
        // to the same place it already is must not be an error.
        assert_eq!(
            decide(Some(REAL_VAULT), None, real_vault()),
            Ok(Resolution::Override(PathBuf::from(REAL_VAULT))),
        );
    }
}
