// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(not(tarpaulin_include))]
fn main() {
    block_notes_lib::run()
}
