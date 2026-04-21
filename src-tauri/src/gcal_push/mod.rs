//! `gcal_push` — Agaric → Google Calendar one-way daily-agenda digest push.
//!
//! Family umbrella: FEAT-5 (see REVIEW-LATER.md for the full design).
//! This module hosts the schema/model types (FEAT-5a), OAuth (FEAT-5b),
//! API client (FEAT-5c), pure digest formatter (FEAT-5d), connector +
//! lease (FEAT-5e), and Tauri settings commands (FEAT-5f) as each slice
//! lands.

pub mod api;
pub mod connector;
pub mod digest;
pub mod dirty_producer;
pub mod keyring_store;
pub mod lease;
pub mod models;
pub mod oauth;
