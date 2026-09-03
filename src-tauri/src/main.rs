// Test bodies are exempt from the 70-code-line ceiling (AGENTS.md "Patterns
// caught in review" item 6); production functions over it carry `#[expect]`
// so the marker expires when the function is split (#4639).
#![cfg_attr(test, allow(clippy::too_many_lines))]
// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    agaric_lib::run();
}
