//! `gcal_push` — Agaric → Google Calendar one-way daily-agenda digest push.
//!
//! Family umbrella: FEAT-5 (see REVIEW-LATER.md for the full design).
//! This module hosts the schema/model types (FEAT-5a), OAuth (FEAT-5b),
//! API client (FEAT-5c), pure digest formatter (FEAT-5d), connector +
//! lease (FEAT-5e), and Tauri settings commands (FEAT-5f) as each slice
//! lands.
//!
//! # Visibility & dead-code analysis (L-127)
//!
//! Submodules are `pub(crate)` (narrowed from `pub` in L-127). Some
//! submodules — notably `oauth` and the `connector::FixedClock` test
//! shim — contain items exercised only by `#[cfg(test)] mod tests`
//! within the same file plus a few stubs that anticipate planned
//! integration paths (`begin_authorize`, `exchange_code`,
//! `refresh_token`, `fetch_with_auto_refresh`). Under `pub mod`, Rust
//! treated those as "potentially used externally" and skipped
//! dead-code analysis for them; under `pub(crate) mod`, the lint
//! correctly flags them as unused in the non-test `lib` build.
//!
//! The items are NOT dead in the project sense — they are either
//! tested-only-but-production-bound (the OAuth client surface) or
//! genuinely test-shim helpers. Per-submodule `#[allow(dead_code)]`
//! attributes below mirror this: they suppress the warnings unmasked
//! by the visibility narrowing without weakening dead-code analysis
//! at the call-site granularity. A future audit (out of scope for
//! L-127) should either wire the OAuth helpers into a production
//! caller or `#[cfg(test)]`-gate the truly test-only shims.

#[allow(dead_code)]
pub(crate) mod api;
#[allow(dead_code)]
pub(crate) mod connector;
pub(crate) mod digest;
pub(crate) mod dirty_producer;
#[allow(dead_code)]
pub(crate) mod keyring_store;
#[allow(dead_code)]
pub(crate) mod lease;
#[allow(dead_code)]
pub(crate) mod migration;
#[allow(dead_code)]
pub(crate) mod models;
#[allow(dead_code)]
pub(crate) mod oauth;
