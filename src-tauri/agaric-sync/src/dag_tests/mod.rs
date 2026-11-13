//! Tests for the engine's replicated-record ingest
//! ([`agaric_engine::dag::ingest_replicated_record`]) and its read helpers.
//! They sit in this crate, not the engine, because they also drive
//! `insert_replicated_op` (#3120).

use agaric_engine::dag::{
    get_block_edit_heads, ingest_replicated_record, parse_parent_seqs_canonical,
};

use sqlx::SqlitePool;

use agaric_core::error::AppError;

use crate::sync_protocol::insert_replicated_op;

mod tests;
